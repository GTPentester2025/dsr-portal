import { Injectable } from '@nestjs/common';
import { DbService, ZoneContext } from '../db/db.module';

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
      const slaHealth = await client.query(
        `SELECT
           count(*) FILTER (WHERE c.status = 'closed')::int AS closed,
           count(*) FILTER (WHERE c.status != 'closed' AND c.due_at > now() + interval '3 days')::int AS on_track,
           count(*) FILTER (WHERE c.status != 'closed' AND c.due_at BETWEEN now() AND now() + interval '3 days')::int AS at_risk,
           count(*) FILTER (WHERE c.status != 'closed' AND c.due_at < now())::int AS overdue
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
      const byAssignee = await client.query(
        `SELECT u.name, count(*)::int AS n
           FROM cases c JOIN users u ON u.id = c.assignee_id
          WHERE c.status != 'closed' ${zoneFilter}
          GROUP BY u.name ORDER BY n DESC LIMIT 20`,
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
      };
    });
  }
}
