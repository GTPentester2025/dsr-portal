import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../public/rate-limit.service';

interface RouteBudget {
  method: 'GET' | 'POST';
  /** Matches when the request path ends with this. '' matches any path for the method. */
  suffix: string;
  name: string;
  /** Bounds the token itself: this is what actually stops a leaked link, and
   *  it survives the caller rotating source IPs. */
  tokenLimit: number;
  /** A coarser brake on one host hammering many tokens. Generous, because a
   *  whole office can sit behind one address and share this budget. */
  ipLimit: number;
}

/**
 * The three public delegation routes, in one place, so the limit that
 * matters (per token) is easy to compare against the one that is only a
 * backstop (per IP).
 */
const ROUTE_BUDGETS: RouteBudget[] = [
  { method: 'GET', suffix: '', name: 'view', tokenLimit: 120, ipLimit: 600 },
  { method: 'POST', suffix: '/accept', name: 'accept', tokenLimit: 20, ipLimit: 100 },
  { method: 'POST', suffix: '/upload', name: 'upload', tokenLimit: 40, ipLimit: 200 },
];

/** Anything that does not match a known route is rate-limited under this
 *  conservative budget rather than let through unbounded. Should not be
 *  reachable in practice: it would mean a route was added to the controller
 *  without a matching entry above. */
const FALLBACK_BUDGET: RouteBudget = {
  method: 'GET',
  suffix: '',
  name: 'unknown',
  tokenLimit: 20,
  ipLimit: 100,
};

/**
 * Rate-limits every route on `PublicDelegationController` **before** the
 * handler — and therefore before `FileInterceptor` buffers an upload body —
 * because guards run ahead of interceptors in the Nest request lifecycle
 * while a limiter called from inside a handler body runs after both.
 *
 * Two budgets are consumed per request:
 *
 * - **Per token**, keyed on the token's SHA-256, never the plaintext (so a
 *   working bearer token is never sitting in the queryable `rate_counters`
 *   table). This is the budget that actually bounds a leaked link: it holds
 *   even when the caller rotates source IPs.
 * - **Per IP**, as a coarse brake against one host hammering many tokens. It
 *   is deliberately more generous than the per-token budget, because a
 *   privacy team sitting behind one office NAT shares this bucket across
 *   every delegation its members touch.
 *
 * Either budget being spent fails the request.
 */
@Injectable()
export class DelegationRateGuard implements CanActivate {
  private readonly log = new Logger(DelegationRateGuard.name);

  constructor(
    private readonly rate: RateLimitService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const budget = this.budgetFor(req);
    const token = (req.params?.token as string | undefined) ?? '';
    const tokenHash = this.crypto.sha256Hex(token);

    const [tokenOk, ipOk] = await Promise.all([
      this.rate.consume(`delegation:${budget.name}:token:${tokenHash}`, budget.tokenLimit),
      this.rate.consume(`delegation:${budget.name}:ip:${req.ip}`, budget.ipLimit),
    ]);

    if (!tokenOk || !ipOk) {
      throw new HttpException('Too many attempts. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private budgetFor(req: Request): RouteBudget {
    const method = req.method.toUpperCase();
    const path = req.path ?? req.url ?? '';
    const found = ROUTE_BUDGETS.find(
      (r) => r.method === method && (r.suffix === '' ? true : path.endsWith(r.suffix)),
    );
    if (!found) {
      this.log.warn(`no rate budget matched ${method} ${path}; using fallback`);
      return FALLBACK_BUDGET;
    }
    return found;
  }
}
