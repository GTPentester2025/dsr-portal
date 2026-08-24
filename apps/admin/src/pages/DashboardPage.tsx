import { useEffect, useId, useMemo, useState } from 'react'
import { api, ZONES, type Dashboard, type Me, atLeast } from '../lib/api'
import {
  Card,
  Chip,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { ExportButton } from '../components/ExportButton'

/* --------------------------------- charts -------------------------------- */

/** Smooth area chart drawn as inline SVG — no chart dependency, themed via
 *  currentColor so it adapts to light and dark automatically. */
function AreaChart({ points, labels }: { points: number[]; labels: string[] }) {
  // Unique per instance: two charts sharing a gradient id is invalid and the
  // second one silently picks up the first one's definition.
  const gradientId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const W = 100
  const H = 34
  const max = Math.max(...points, 1)

  const path = useMemo(() => {
    if (points.length === 0) return { line: '', area: '' }
    const step = points.length > 1 ? W / (points.length - 1) : W
    const xy = points.map((p, i) => [i * step, H - (p / max) * (H - 4) - 2] as const)
    // Catmull-Rom style smoothing keeps the trend readable without distorting values.
    let d = `M ${xy[0][0]},${xy[0][1]}`
    for (let i = 0; i < xy.length - 1; i++) {
      const [x0, y0] = xy[i]
      const [x1, y1] = xy[i + 1]
      const cx = (x0 + x1) / 2
      d += ` C ${cx},${y0} ${cx},${y1} ${x1},${y1}`
    }
    return { line: d, area: `${d} L ${W},${H} L 0,${H} Z` }
  }, [points, max])

  if (points.length === 0) return <EmptyState icon="trendUp" title="No intake yet" />

  const step = points.length > 1 ? W / (points.length - 1) : W

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full text-brand-ink"
        role="img"
        aria-label={`Weekly intake trend, ${points.length} weeks, peak ${max} cases`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={path.area} fill={`url(#${gradientId})`} />
        <path d={path.line} fill="none" stroke="currentColor" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        {hover !== null && (
          <circle cx={hover * step} cy={H - (points[hover] / max) * (H - 4) - 2} r="1.4" fill="currentColor" />
        )}
      </svg>

      {/* Invisible hit strips give every point a comfortable target. */}
      <div className="absolute inset-0 flex">
        {points.map((p, i) => (
          <div
            key={i}
            className="h-full flex-1"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${labels[i]}: ${p} case${p === 1 ? '' : 's'}`}
          />
        ))}
      </div>

      <div className="mt-2 flex justify-between text-[10px] text-faint">
        <span>{labels[0]}</span>
        {hover !== null && (
          <span className="mono font-medium text-ink">
            {labels[hover]} · {points[hover]}
          </span>
        )}
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  )
}

const TONE: Record<string, string> = {
  critical: 'var(--t-danger)',
  warning: 'var(--t-warning)',
  positive: 'var(--t-positive)',
  neutral: 'var(--t-gold-1)',
}

const ZONE_COLOR: Record<string, string> = {
  EUR: 'var(--t-gold-1)',
  SAZ: 'var(--t-info)',
  MAZ: 'var(--t-warning)',
}

/**
 * Grouped bars: one cluster per month, one bar per zone.
 *
 * Drawn with flex boxes rather than a chart library — three series over six
 * months does not justify the bundle, and this stays legible at any width.
 */
function MonthlyByZone({
  rows,
  months,
}: {
  rows: { month: string; zone_id: string; n: number }[]
  months: string[]
}) {
  if (rows.length === 0) {
    return <EmptyState icon="chart" title="No data yet" hint="Monthly volume appears once requests arrive." />
  }
  const zones = [...new Set(rows.map((r) => r.zone_id))].sort()
  const peak = Math.max(1, ...rows.map((r) => r.n))
  const value = (month: string, zone: string) =>
    rows.find((r) => r.month === month && r.zone_id === zone)?.n ?? 0

  return (
    <div>
      <div className="flex h-40 items-end gap-2">
        {months.map((m) => (
          <div key={m} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div className="flex h-32 w-full items-end justify-center gap-[3px]">
              {zones.map((z) => {
                const n = value(m, z)
                return (
                  <div
                    key={z}
                    title={`${z} · ${m} · ${n}`}
                    className="min-w-[5px] flex-1 rounded-t-sm transition-[height] duration-500"
                    style={{
                      height: `${Math.max(n > 0 ? 4 : 1, (n / peak) * 100)}%`,
                      background: n > 0 ? ZONE_COLOR[z] ?? 'var(--t-gold-1)' : 'var(--t-line)',
                      transitionTimingFunction: 'var(--ease-out-expo)',
                    }}
                  />
                )
              })}
            </div>
            <span className="mono text-[10px] text-faint">{m.slice(2)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 border-t border-line pt-2.5">
        {zones.map((z) => (
          <span key={z} className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="h-2 w-2 rounded-sm" style={{ background: ZONE_COLOR[z] ?? 'var(--t-gold-1)' }} />
            {z}
            <span className="mono text-faint">{rows.filter((r) => r.zone_id === z).reduce((a, r) => a + r.n, 0)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return (
    <div className="group grid grid-cols-[minmax(0,max-content)_1fr_2.25rem] items-center gap-3">
      <span
        className="max-w-[11rem] truncate text-[12px] text-muted"
        title={label}
      >
        {label}
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: color ?? 'var(--t-gold-1)', transitionTimingFunction: 'var(--ease-out-expo)' }}
        />
      </div>
      <span className="mono text-right text-[12px] font-medium text-ink">{value}</span>
    </div>
  )
}

function Kpi({
  label,
  value,
  icon,
  color,
  note,
  href,
}: {
  label: string
  value: number
  icon: string
  color: string
  note?: string
  /** When set the card drills through to the matching case list. */
  href?: string
}) {
  // An anchor rather than a click handler: the target is a real page, so it
  // should be middle-clickable and readable by a screen reader as a link.
  const Wrapper = href ? 'a' : 'div'
  return (
    <Wrapper
      {...(href ? { href, 'aria-label': `${label}: ${value} cases. Open the list.` } : {})}
      className={`block rounded-xl border border-line bg-surface p-4 transition-transform duration-200 hover:-translate-y-0.5 ${
        href ? 'cursor-pointer hover:border-brand-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink' : ''
      }`}
      style={{ boxShadow: 'var(--shadow-sm)', transitionTimingFunction: 'var(--ease-out-expo)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</span>
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
        >
          <Icon name={icon} size={14} />
        </span>
      </div>
      <p className="mono mt-2.5 text-[26px] font-semibold leading-none tracking-tight text-ink">{value}</p>
      {note && <p className="mt-1.5 text-[11px] text-faint">{note}</p>}
    </Wrapper>
  )
}

/* ---------------------------------- page --------------------------------- */

export function DashboardPage({ me }: { me: Me }) {
  const [zone, setZone] = useState(me.zoneId ?? '')
  // Findings come from the report endpoint so the dashboard, the Reports view
  // and the PDF all read from one source.
  const [insights, setInsights] = useState<{ tone: string; headline: string; detail: string }[]>([])
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setData(null)
    api
      .get<Dashboard>(`/internal/dashboard${zone ? `?zone=${zone}` : ''}`)
      .then(setData)
      .catch((e) => setError(String(e)))
    // Findings are advisory: an approver has no access to the report endpoint,
    // and the dashboard must still render for them.
    api
      .get<{ insights?: { tone: string; headline: string; detail: string }[] }>(
        `/internal/reports${zone ? `?zone=${zone}` : ''}`,
      )
      .then((r) => setInsights(r.insights ?? []))
      .catch(() => setInsights([]))
  }, [zone])

  if (error) return <p className="text-sm text-danger">{error}</p>

  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="SLA health and workload" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px]" />)}
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </>
    )
  }

  const typeMax = Math.max(...data.byRequestType.map((s) => s.n), 1)
  const total = data.byStatus.reduce((a, s) => a + s.n, 0)

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${total} case${total === 1 ? '' : 's'} ${zone ? `in ${zone}` : 'across all zones'}`}
        actions={
          atLeast(me.role, 'admin') || me.role === 'auditor' ? (
            <>
              <div className="w-40">
                <Select value={zone} onChange={(e) => setZone(e.target.value)} aria-label="Zone filter">
                  <option value="">All zones</option>
                  {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              </div>
              <ExportButton
                href={`/internal/reports/export.pdf${zone ? `?zone=${zone}` : ''}`}
                label="Executive report"
                variant="primary"
              />
            </>
          ) : (
            <>
              <Chip tone="brand">{me.zoneId}</Chip>
              {me.role === 'zone_manager' && (
                <ExportButton href="/internal/reports/export.pdf" label="Executive report" variant="primary" />
              )}
            </>
          )
        }
      />

      <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="On track" value={data.slaHealth.on_track} icon="checkCircle" color="var(--t-positive)" note="Within SLA window" href="#/cases?sla=on_track" />
        <Kpi label="At risk" value={data.slaHealth.at_risk} icon="clock" color="var(--t-warning)" note="Due within 3 days" href="#/cases?sla=at_risk" />
        <Kpi label="Overdue" value={data.slaHealth.overdue} icon="alert" color="var(--t-danger)" note="Past the statutory deadline" href="#/cases?sla=overdue" />
        <Kpi label="Closed" value={data.slaHealth.closed} icon="inbox" color="var(--t-faint)" note="Resolved to date" href="#/cases?sla=closed" />
      </div>

      {insights.length > 0 && (
        <div className="mt-4">
          <Card
            title="What needs attention"
            subtitle="Ranked by severity — the same findings as the executive report"
          >
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {insights.slice(0, 4).map((i, n) => (
                <li key={n} className="flex gap-2.5">
                  <span
                    className="mt-1 w-0.5 shrink-0 rounded-full"
                    style={{ background: TONE[i.tone] ?? 'var(--t-gold-1)' }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-ink">{i.headline}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">{i.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
        <Card title="Monthly intake by zone" subtitle="Last 6 months" className="lg:col-span-2">
          <MonthlyByZone rows={data.monthlyByZone ?? []} months={data.months ?? []} />
        </Card>
        <Card title="Daily intake" subtitle="Requests received each day, last 30 days">
          <AreaChart
            points={(data.dailyVolume ?? []).map((d) => d.n)}
            labels={(data.dailyVolume ?? []).map((d) =>
              new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            )}
          />
        </Card>

        <Card title="Weekly intake" subtitle="Submissions over the last 12 weeks">
          <AreaChart
            points={data.volumeTrend.map((w) => w.n)}
            labels={data.volumeTrend.map((w) =>
              new Date(w.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            )}
          />
        </Card>




      </div>

      <div className="mt-5">
        <Card
          title="Due in the next 7 days"
          subtitle={data.upcomingDue.length ? `${data.upcomingDue.length} approaching deadline` : undefined}
          bleed
        >
          {data.upcomingDue.length === 0 ? (
            <EmptyState icon="checkCircle" title="Nothing due this week" hint="Cases nearing their SLA deadline appear here." />
          ) : (
            <Table head={<><Th>Case</Th><Th>Zone</Th><Th>Status</Th><Th className="text-right">Due</Th></>}>
              {data.upcomingDue.map((c) => {
                const days = Math.ceil((new Date(c.due_at).getTime() - Date.now()) / 86400000)
                return (
                  <Tr key={c.id} onClick={() => { window.location.hash = `#/cases/${c.id}` }}>
                    <Td><span className="mono text-[12px] font-medium text-brand-ink">{c.case_ref}</span></Td>
                    <Td><Chip>{c.zone_id}</Chip></Td>
                    <Td><StatusBadge status={c.status} /></Td>
                    <Td className="text-right">
                      <span className="mono text-[12px] text-muted">{new Date(c.due_at).toISOString().slice(0, 10)}</span>
                      <span className={`ml-2 text-[11px] ${days <= 1 ? 'text-danger' : 'text-faint'}`}>
                        {days <= 0 ? 'today' : `${days}d`}
                      </span>
                    </Td>
                  </Tr>
                )
              })}
            </Table>
          )}
        </Card>
        <Card title="Requests by type" className="lg:col-span-2">
          {data.byRequestType.length === 0 ? (
            <EmptyState icon="filter" title="No data yet" hint="The breakdown appears after the first submissions." />
          ) : (
            <div className="space-y-3 py-1">
              {data.byRequestType.map((s) => (
                <BarRow key={s.request_type} label={s.request_type} value={s.n} max={typeMax} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
