/**
 * One derivation of SLA urgency for every screen.
 *
 * The list, the detail header and the side rail each carried their own copy of
 * "how many days left and what colour is that" — three chances to disagree
 * about whether the same case is at risk. This module is the copy. The 3-day
 * at-risk window mirrors the server's sla-buckets.ts; the two must move
 * together.
 */
export const AT_RISK_DAYS = 3

export type UrgencyTone = 'neutral' | 'positive' | 'warning' | 'danger'

export interface Urgency {
  tone: UrgencyTone
  /** Short label: "3d left", "2d overdue", "Due today", "Closed", "No deadline". */
  text: string
  /** Days until due, negative when past. Null without a deadline or when closed. */
  daysLeft: number | null
  overdue: boolean
  atRisk: boolean
}

export function urgencyOf(status: string, dueAt: string | null | undefined): Urgency {
  if (status === 'closed') {
    return { tone: 'neutral', text: 'Closed', daysLeft: null, overdue: false, atRisk: false }
  }
  if (!dueAt) {
    return { tone: 'neutral', text: 'No deadline', daysLeft: null, overdue: false, atRisk: false }
  }
  const days = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 86_400_000)
  if (days < 0) {
    return { tone: 'danger', text: `${-days}d overdue`, daysLeft: days, overdue: true, atRisk: false }
  }
  if (days === 0) {
    return { tone: 'danger', text: 'Due today', daysLeft: 0, overdue: false, atRisk: true }
  }
  if (days <= AT_RISK_DAYS) {
    return { tone: 'warning', text: `${days}d left`, daysLeft: days, overdue: false, atRisk: true }
  }
  return { tone: 'positive', text: `${days}d left`, daysLeft: days, overdue: false, atRisk: false }
}

/** "3 days", "5 hours", "12 minutes" — the largest unit that is not zero. */
export function humanise(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** Local date, no time. */
export const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString() : '—'

/** Local date and time. */
export const fmtDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString() : '—'
