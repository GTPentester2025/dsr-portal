import { Injectable } from '@nestjs/common';
import { DbService, ZoneContext } from '../db/db.module';
import { slaBucketSql } from './sla-buckets';

/** Aggregations for the zone dashboards (spec §11). RLS scopes everything. */
@Injectable()
export class DashboardService {
  constructor(private readonly db: DbService) {}

  async overview(ctx: ZoneContext, zone?: string) {
    return this.db.withContext(ctx, async (_db, client) => {
      const zoneFilter = zone ? 'AND c.zone_id = $1' : '';
      const params = zone ? [zone] : [];

      const byStatus = await client.query(
        `SELECT c.status, count(*)::int AS n FROM cases c WHERE true ${zoneFilter} GROUP BY c.status`,
        params,
      );
      // The same predicates the case list's drill-down uses (sla-buckets.ts),
      // so a card's count always equals the list it links to.
      const b = slaBucketSql('c');
      const slaHealth = await client.query(
        `SELECT
           count(*) FILTER (WHERE ${b.closed})::int AS closed,
           count(*) FILTER (WHERE ${b.on_track})::int AS on_track,
           count(*) FILTER (WHERE ${b.at_risk})::int AS at_risk,
           count(*) FILTER (WHERE ${b.overdue})::int AS overdue
         FROM cases c WHERE true ${zoneFilter}`,
        params,
      );
      const ageing = await client.query(
        `SELECT width_bucket(EXTRACT(EPOCH FROM now() - c.created_at) / 86400, 0, 60, 6) AS bucket,
                count(*)::int AS n
           FROM cases c WHERE c.status != 'closed' ${zoneFilter}
          GROUP BY bucket ORDER BY bucket`,
        params,
      );
      const volumeTrend = await client.query(
        `SELECT date_trunc('week', c.created_at)::date AS week, count(*)::int AS n
           FROM cases c
          WHERE c.created_at > now() - interval '12 weeks' ${zoneFilter}
          GROUP BY week ORDER BY week`,
        params,
      );
      // Daily arrivals for the last 30 days, gap-filled: a day with no requests
      // must still plot as zero or the line implies continuity that is not there.
      const dailyVolume = await client.query(
        `SELECT d::date AS day, COALESCE(v.n, 0)::int AS n
           FROM generate_series(now()::date - interval '29 days', now()::date, interval '1 day') d
      LEFT JOIN (
             SELECT c.created_at::date AS day, count(*)::int AS n
               FROM cases c
              WHERE c.created_at > now() - interval '30 days' ${zoneFilter}
              GROUP BY 1
           ) v ON v.day = d::date
          ORDER BY day`,
        params,
      );
      // Six months by zone. Stored as one row per month with a count per zone
      // so the client can render a grouped bar without pivoting.
      const monthlyByZone = await client.query(
        `SELECT to_char(m, 'YYYY-MM') AS month,
                c.zone_id,
                count(c.id)::int AS n
           FROM generate_series(
                  date_trunc('month', now()) - interval '5 months',
                  date_trunc('month', now()),
                  interval '1 month'
                ) m
      LEFT JOIN cases c
             ON date_trunc('month', c.created_at) = m ${zoneFilter}
          GROUP BY m, c.zone_id
          ORDER BY m`,
        params,
      );

      const byRequestType = await client.query(
        `SELECT rt.value AS request_type, count(*)::int AS n
           FROM cases c, jsonb_array_elements_text(c.request_types) rt(value)
          WHERE true ${zoneFilter}
          GROUP BY rt.value ORDER BY n DESC`,
        params,
      );
      // The id rides along so the console can link a row straight into the
      // case list filtered to that person; the overdue split turns "busy"
      // into "busy and drowning", which are different problems.
      const byAssignee = await client.query(
        `SELECT u.id, u.name, count(*)::int AS n,
                count(*) FILTER (WHERE ${b.overdue})::int AS overdue
           FROM cases c JOIN users u ON u.id = c.assignee_id
          WHERE c.status != 'closed' ${zoneFilter}
          GROUP BY u.id, u.name ORDER BY n DESC LIMIT 20`,
        params,
      );

      // How closing actually went: the questions a quarterly review asks.
      const closure = await client.query(
        `SELECT count(*)::int AS total,
                COALESCE(ROUND((EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY (c.closed_at - c.created_at))) / 86400)::numeric, 1), 0)::float AS median_days,
                count(*) FILTER (WHERE c.completed_after_deadline)::int AS late
           FROM cases c
          WHERE c.status = 'closed' AND c.closed_at IS NOT NULL ${zoneFilter}`,
        params,
      );
      const byOutcome = await client.query(
        `SELECT c.outcome_code, count(*)::int AS n
           FROM cases c
          WHERE c.status = 'closed' AND c.outcome_code IS NOT NULL ${zoneFilter}
          GROUP BY c.outcome_code ORDER BY n DESC`,
        params,
      );
      // Counted on the appeal cases only: appeal_status is mirrored onto the
      // original, and counting both would double every decision.
      const appeals = await client.query(
        `SELECT count(*) FILTER (WHERE c.is_appeal AND c.status <> 'closed')::int AS open,
                count(*) FILTER (WHERE c.is_appeal AND c.appeal_status = 'upheld')::int AS upheld,
                count(*) FILTER (WHERE c.is_appeal AND c.appeal_status = 'rejected')::int AS rejected
           FROM cases c WHERE true ${zoneFilter}`,
        params,
      );
      const upcoming = await client.query(
        `SELECT c.id, c.case_ref, c.zone_id, c.status, c.due_at
           FROM cases c
          WHERE c.status != 'closed'
            AND c.due_at BETWEEN now() AND now() + interval '7 days' ${zoneFilter}
          ORDER BY c.due_at LIMIT 50`,
        params,
      );

      return {
        byStatus: byStatus.rows,
        slaHealth: slaHealth.rows[0],
        ageing: ageing.rows,
        volumeTrend: volumeTrend.rows,
        dailyVolume: dailyVolume.rows,
        monthlyByZone: monthlyByZone.rows.filter((r) => r.zone_id !== null),
        /** Months present even when no zone had a case, so the axis is continuous. */
        months: [...new Set(monthlyByZone.rows.map((r) => r.month))],
        byRequestType: byRequestType.rows,
        byAssignee: byAssignee.rows,
        upcomingDue: upcoming.rows,
        closure: closure.rows[0],
        byOutcome: byOutcome.rows,
        appeals: appeals.rows[0],
      };
    });
  }
}
