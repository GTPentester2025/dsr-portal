import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../db/db.module';
import { SettingsService } from '../settings/settings.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';
import { buildInsights, type Insight } from './insights';
import { ReportPdfService } from './report-pdf.service';

export interface ReportStats {
  generatedAt: string;
  zone: string;
  window: { from: string; to: string };
  today: {
    received: number;
    closed: number;
    verified: number;
  };
  overall: {
    open: number;
    overdue: number;
    dueSoon: number;
    closed: number;
    total: number;
    medianDaysToClose: number | null;
    onTimeRate: number | null;
  };
  byStatus: { status: string; n: number }[];
  byZone: { zone_id: string; n: number; overdue: number }[];
  oldestOpen: { case_ref: string; zone_id: string; status: string; days: number }[];
  dailyVolume: { day: string; n: number }[];
  byRequestType: { request_type: string; n: number }[];
  /** Week-on-week comparison, which is what makes the findings meaningful. */
  comparison: {
    receivedThisWeek: number;
    receivedLastWeek: number;
    closedThisWeek: number;
    closedLastWeek: number;
    breachingSoon: number;
    previousOnTimeRate: number | null;
    slaTargetDays: number | null;
    oldestOpenDays: number | null;
  };
  insights: Insight[];
}

/**
 * Operational reporting for managers.
 *
 * Two consumers, one query: a scheduled email each morning and an on-demand
 * download. Building them from the same stats means the figure in the inbox and
 * the figure on screen can never disagree, which is the usual way reporting
 * loses trust.
 */
@Injectable()
export class ReportService {
  private readonly log = new Logger(ReportService.name);

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly pdf: ReportPdfService,
  ) {}

  async build(zone?: string): Promise<ReportStats> {
    const zoneFilter = zone ? 'AND c.zone_id = $1' : '';
    const params = zone ? [zone] : [];

    return this.db.system(async (_db, client) => {
      const today = await client.query(
        `SELECT
           count(*) FILTER (WHERE c.created_at::date = now()::date)::int AS received,
           count(*) FILTER (WHERE c.closed_at::date = now()::date)::int AS closed
         FROM cases c WHERE true ${zoneFilter}`,
        params,
      );

      const overall = await client.query(
        `SELECT
           count(*) FILTER (WHERE c.status NOT IN ('closed'))::int AS open,
           count(*) FILTER (WHERE c.status NOT IN ('closed') AND c.due_at < now())::int AS overdue,
           count(*) FILTER (WHERE c.status NOT IN ('closed')
                              AND c.due_at BETWEEN now() AND now() + interval '3 days')::int AS due_soon,
           count(*) FILTER (WHERE c.status = 'closed')::int AS closed,
           count(*)::int AS total,
           -- Median rather than mean: one pathological case should not move it.
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (c.closed_at - c.created_at)) / 86400
           ) FILTER (WHERE c.closed_at IS NOT NULL) AS median_days,
           count(*) FILTER (WHERE c.closed_at IS NOT NULL AND c.closed_at <= c.due_at)::int AS closed_on_time
         FROM cases c WHERE true ${zoneFilter}`,
        params,
      );

      const byStatus = await client.query(
        `SELECT c.status, count(*)::int AS n FROM cases c WHERE true ${zoneFilter}
          GROUP BY c.status ORDER BY n DESC`,
        params,
      );

      const byZone = await client.query(
        `SELECT c.zone_id, count(*)::int AS n,
                count(*) FILTER (WHERE c.status <> 'closed' AND c.due_at < now())::int AS overdue
           FROM cases c WHERE true ${zoneFilter}
          GROUP BY c.zone_id ORDER BY c.zone_id`,
        params,
      );

      const oldestOpen = await client.query(
        `SELECT c.case_ref, c.zone_id, c.status,
                floor(EXTRACT(EPOCH FROM (now() - c.created_at)) / 86400)::int AS days
           FROM cases c
          WHERE c.status NOT IN ('closed') ${zoneFilter}
          ORDER BY c.created_at ASC LIMIT 10`,
        params,
      );

      const daily = await client.query(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(v.n, 0)::int AS n
           FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') d
      LEFT JOIN (
             SELECT c.created_at::date AS day, count(*)::int AS n
               FROM cases c WHERE c.created_at > now() - interval '14 days' ${zoneFilter}
              GROUP BY 1
           ) v ON v.day = d::date
          ORDER BY day`,
        params,
      );

      const verified = await client.query(
        `SELECT count(*)::int AS n FROM verification_tokens
          WHERE consumed_at::date = now()::date`,
      );

      // Week on week, plus the near-term breach risk. Separate from the
      // headline counts because a total without a direction is not a finding.
      const compare = await client.query(
        `SELECT
           count(*) FILTER (WHERE c.created_at > now() - interval '7 days')::int AS recv_this,
           count(*) FILTER (WHERE c.created_at > now() - interval '14 days'
                              AND c.created_at <= now() - interval '7 days')::int AS recv_last,
           count(*) FILTER (WHERE c.closed_at > now() - interval '7 days')::int AS closed_this,
           count(*) FILTER (WHERE c.closed_at > now() - interval '14 days'
                              AND c.closed_at <= now() - interval '7 days')::int AS closed_last,
           count(*) FILTER (WHERE c.status <> 'closed'
                              AND c.due_at BETWEEN now() AND now() + interval '48 hours')::int AS breaching_soon,
           max(floor(EXTRACT(EPOCH FROM (now() - c.created_at)) / 86400))
             FILTER (WHERE c.status <> 'closed')::int AS oldest_open_days
         FROM cases c WHERE true ${zoneFilter}`,
        params,
      );

      // On-time rate for closures before this week, so the trend has a baseline.
      const priorRate = await client.query(
        `SELECT
           count(*) FILTER (WHERE c.closed_at <= c.due_at)::int AS on_time,
           count(*)::int AS total
         FROM cases c
        WHERE c.closed_at IS NOT NULL
          AND c.closed_at <= now() - interval '7 days' ${zoneFilter}`,
        params,
      );

      const byRequestType = await client.query(
        `SELECT rt.value AS request_type, count(*)::int AS n
           FROM cases c, jsonb_array_elements_text(c.request_types) rt(value)
          WHERE true ${zoneFilter}
          GROUP BY rt.value ORDER BY n DESC`,
        params,
      );

      const slaTarget = await client.query(
        `SELECT min(target_minutes)::int AS m FROM sla_policies
          ${zone ? 'WHERE zone_id = $1' : ''}`,
        params,
      );

      const o = overall.rows[0];
      const closedCount = Number(o.closed);
      const cmp = compare.rows[0];
      const priorOnTime = Number(priorRate.rows[0].on_time);
      const priorTotal = Number(priorRate.rows[0].total);
      const slaTargetDays = slaTarget.rows[0]?.m ? Math.ceil(Number(slaTarget.rows[0].m) / 1440) : null;
      const worst = [...byZone.rows].sort((a, b) => Number(b.overdue) - Number(a.overdue))[0];
      return {
        generatedAt: new Date().toISOString(),
        zone: zone ?? 'all zones',
        window: { from: daily.rows[0]?.day ?? '', to: daily.rows.at(-1)?.day ?? '' },
        today: {
          received: Number(today.rows[0].received),
          closed: Number(today.rows[0].closed),
          verified: Number(verified.rows[0].n),
        },
        overall: {
          open: Number(o.open),
          overdue: Number(o.overdue),
          dueSoon: Number(o.due_soon),
          closed: closedCount,
          total: Number(o.total),
          medianDaysToClose: o.median_days === null ? null : Math.round(Number(o.median_days) * 10) / 10,
          onTimeRate: closedCount > 0 ? Math.round((Number(o.closed_on_time) / closedCount) * 100) : null,
        },
        byStatus: byStatus.rows,
        byZone: byZone.rows,
        oldestOpen: oldestOpen.rows,
        dailyVolume: daily.rows,
        byRequestType: byRequestType.rows,
        comparison: {
          receivedThisWeek: Number(cmp.recv_this),
          receivedLastWeek: Number(cmp.recv_last),
          closedThisWeek: Number(cmp.closed_this),
          closedLastWeek: Number(cmp.closed_last),
          breachingSoon: Number(cmp.breaching_soon),
          previousOnTimeRate: priorTotal > 0 ? Math.round((priorOnTime / priorTotal) * 100) : null,
          slaTargetDays: slaTargetDays,
          oldestOpenDays: cmp.oldest_open_days === null ? null : Number(cmp.oldest_open_days),
        },
        insights: buildInsights({
          receivedThisWeek: Number(cmp.recv_this),
          receivedLastWeek: Number(cmp.recv_last),
          closedThisWeek: Number(cmp.closed_this),
          closedLastWeek: Number(cmp.closed_last),
          open: Number(o.open),
          overdue: Number(o.overdue),
          breachingSoon: Number(cmp.breaching_soon),
          onTimeRate: closedCount > 0 ? Math.round((Number(o.closed_on_time) / closedCount) * 100) : null,
          previousOnTimeRate: priorTotal > 0 ? Math.round((priorOnTime / priorTotal) * 100) : null,
          medianDaysToClose:
            o.median_days === null ? null : Math.round(Number(o.median_days) * 10) / 10,
          slaTargetDays,
          topRequestType: byRequestType.rows[0]
            ? { type: byRequestType.rows[0].request_type, n: Number(byRequestType.rows[0].n) }
            : null,
          totalRequestTypes: byRequestType.rows.reduce((sum, r) => sum + Number(r.n), 0),
          worstZone: worst ? { zone: worst.zone_id, overdue: Number(worst.overdue) } : null,
          oldestOpenDays: cmp.oldest_open_days === null ? null : Number(cmp.oldest_open_days),
          unverifiedDrafts: 0,
        }),
      };
    });
  }

  /** Plain-table HTML: mail clients are unreliable with anything cleverer. */
  renderHtml(s: ReportStats): string {
    const row = (label: string, value: string | number, emphasis = false) =>
      `<tr><td style="padding:6px 12px 6px 0;color:#5f636b">${label}</td>` +
      `<td style="padding:6px 0;font-weight:${emphasis ? 700 : 500};color:#17171a">${value}</td></tr>`;

    const bar = (n: number, max: number) => {
      const width = max > 0 ? Math.round((n / max) * 160) : 0;
      return `<span style="display:inline-block;height:9px;width:${width}px;background:#d3a238;border-radius:2px"></span>`;
    };
    const peak = Math.max(1, ...s.dailyVolume.map((d) => d.n));

    return `
<h2 style="font:600 17px system-ui;margin:0 0 4px">Privacy requests — ${s.zone}</h2>
<p style="font:400 13px system-ui;color:#5f636b;margin:0 0 18px">
  Generated ${new Date(s.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
</p>

<h3 style="font:600 14px system-ui;margin:0 0 6px">Today</h3>
<table style="font:400 13px system-ui;border-collapse:collapse;margin-bottom:18px">
  ${row('Received', s.today.received, true)}
  ${row('Closed', s.today.closed)}
  ${row('Emails verified', s.today.verified)}
</table>

<h3 style="font:600 14px system-ui;margin:0 0 6px">Overall</h3>
<table style="font:400 13px system-ui;border-collapse:collapse;margin-bottom:18px">
  ${row('Open', s.overall.open, true)}
  ${row('Overdue', s.overall.overdue, s.overall.overdue > 0)}
  ${row('Due within 3 days', s.overall.dueSoon)}
  ${row('Closed', s.overall.closed)}
  ${row('Total ever received', s.overall.total)}
  ${row('Median days to close', s.overall.medianDaysToClose ?? 'no closures yet')}
  ${row('Closed within SLA', s.overall.onTimeRate === null ? 'no closures yet' : `${s.overall.onTimeRate}%`)}
</table>

<h3 style="font:600 14px system-ui;margin:0 0 6px">Arrivals, last 14 days</h3>
<table style="font:400 12px system-ui;border-collapse:collapse;margin-bottom:18px">
  ${s.dailyVolume
    .map(
      (d) =>
        `<tr><td style="padding:2px 10px 2px 0;color:#5f636b;white-space:nowrap">${d.day}</td>` +
        `<td style="padding:2px 8px 2px 0">${bar(d.n, peak)}</td>` +
        `<td style="padding:2px 0;color:#17171a">${d.n}</td></tr>`,
    )
    .join('')}
</table>

${
  s.oldestOpen.length > 0
    ? `<h3 style="font:600 14px system-ui;margin:0 0 6px">Longest open</h3>
<table style="font:400 12px system-ui;border-collapse:collapse;margin-bottom:18px">
  <tr style="color:#5f636b"><td style="padding:4px 12px 4px 0">Reference</td><td style="padding:4px 12px 4px 0">Zone</td><td style="padding:4px 12px 4px 0">Status</td><td style="padding:4px 0">Age</td></tr>
  ${s.oldestOpen
    .map(
      (c) =>
        `<tr><td style="padding:3px 12px 3px 0">${c.case_ref}</td><td style="padding:3px 12px 3px 0">${c.zone_id}</td>` +
        `<td style="padding:3px 12px 3px 0">${c.status}</td><td style="padding:3px 0">${c.days} days</td></tr>`,
    )
    .join('')}
</table>`
    : ''
}

<p style="font:400 12px system-ui;color:#9b9ea6">
  Sent automatically to zone managers and administrators. Download the same figures any time from the Reports page.
</p>`;
  }

  /**
   * Daily digest. 07:00 UTC, which lands before the working day in Europe and
   * the Americas alike.
   */
  @Cron('0 7 * * *')
  async sendDaily(): Promise<void> {
    if (this.settings.get<string>('DAILY_REPORT_ENABLED', 'true') !== 'true') return;
    try {
      await this.dispatch();
    } catch (err) {
      this.log.error(`daily report failed: ${(err as Error).message}`);
    }
  }

  /**
   * One report per zone to its managers, plus an all-zones report to
   * administrators — a manager should not receive figures for zones they
   * cannot open.
   */
  async dispatch(): Promise<{ sent: number }> {
    const people = await this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT email, name, role, zone_id FROM users
          WHERE active AND role IN ('zone_manager', 'admin', 'super_admin')`,
      );
      return res.rows as { email: string; name: string; role: string; zone_id: string | null }[];
    });

    let sent = 0;
    const cache = new Map<string, ReportStats>();
    const pdfs = new Map<string, Buffer>();
    for (const person of people) {
      const zone = person.role === 'zone_manager' ? person.zone_id ?? undefined : undefined;
      const key = zone ?? '*';
      if (!cache.has(key)) cache.set(key, await this.build(zone));
      const stats = cache.get(key)!;
      // Rendered once per zone, not once per recipient.
      if (!pdfs.has(key)) {
        try {
          pdfs.set(key, await this.pdf.render(stats));
        } catch (err) {
          // A failed attachment must not stop the report going out.
          this.log.warn(`report PDF for ${key} failed: ${(err as Error).message}`);
        }
      }
      try {
        await this.email.sendAsUser({
          // Boot validation guarantees PRIVACY_MAILBOX is set, so there is no
          // fallback to invent here — an example.com sender would bounce.
          fromMailbox: this.settings.get<string>('PRIVACY_MAILBOX'),
          to: [person.email],
          subject: `Privacy request report — ${stats.zone} — ${new Date().toISOString().slice(0, 10)}`,
          body: this.renderHtml(stats),
          // The HTML is the at-a-glance version; the PDF is what gets forwarded
          // to an executive or filed as evidence.
          attachments: pdfs.has(key)
            ? [
                {
                  filename: `privacy-report-${new Date().toISOString().slice(0, 10)}.pdf`,
                  content: pdfs.get(key)!.toString('base64'),
                  contentType: 'application/pdf',
                },
              ]
            : undefined,
        });
        sent++;
      } catch (err) {
        this.log.warn(`report to ${person.email} failed: ${(err as Error).message}`);
      }
    }
    this.log.log(`daily report sent to ${sent}/${people.length} recipients`);
    return { sent };
  }
}
