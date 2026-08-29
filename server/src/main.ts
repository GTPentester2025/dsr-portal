import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { SettingsService } from './settings/settings.service';
import { assertEmailConfig } from './email/email-config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.disable('x-powered-by');
  // The API binds to loopback and is only ever reached through nginx, which
  // appends the caller to X-Forwarded-For. Without this, req.ip is the proxy's
  // own address for every request: rate limits keyed on IP become one global
  // bucket — ten failed sign-ins would lock out every administrator — and the
  // audit log records 127.0.0.1 for everything. Trusting exactly one hop is
  // safe here because nothing else can reach the socket.
  app.set('trust proxy', 'loopback');
  app.use(cookieParser());

  // Security headers (spec §9). CSP applies to the few HTML responses the
  // API serves (verification landing); the SPA bundles ship their own.
  app.use((req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    next();
  });

  // Body size cap for public JSON payloads.
  app.useBodyParser('json', { limit: '256kb' });

  // Read through SettingsService so the envOnly resolution used at runtime is
  // the same one validated here.
  const settings = app.get(SettingsService);
  const log = new Logger('EmailConfig');
  try {
    assertEmailConfig((key) => settings.get<string | undefined>(key, undefined), {
      error: (m) => log.error(m),
    });
  } catch {
    await app.close();
    process.exit(1);
  }

  await app.listen(process.env.PORT ?? 3000, '127.0.0.1');
}
void bootstrap();
