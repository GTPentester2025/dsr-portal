/**
 * Narrative findings for the executive report.
 *
 * A page of counts tells a manager what happened; it does not tell them what to
 * do about it. These rules turn the same numbers into ranked statements —
 * what changed, what is about to go wrong, and where the pressure is — so the
 * first thing on the page is the thing worth acting on.
 */

export interface InsightInput {
  receivedThisWeek: number;
  receivedLastWeek: number;
  closedThisWeek: number;
  closedLastWeek: number;
  open: number;
  overdue: number;
  breachingSoon: number;
  onTimeRate: number | null;
  previousOnTimeRate: number | null;
  medianDaysToClose: number | null;
  slaTargetDays: number | null;
  topRequestType: { type: string; n: number } | null;
  totalRequestTypes: number;
  worstZone: { zone: string; overdue: number } | null;
  oldestOpenDays: number | null;
  unverifiedDrafts: number;
}

export type InsightTone = 'critical' | 'warning' | 'positive' | 'neutral';

export interface Insight {
  tone: InsightTone;
  headline: string;
  detail: string;
  /** Higher sorts first. Severity, not chronology, decides what leads. */
  weight: number;
}

function pct(from: number, to: number): number | null {
  if (from === 0) return to === 0 ? 0 : null;
  return Math.round(((to - from) / from) * 100);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildInsights(i: InsightInput): Insight[] {
  const out: Insight[] = [];

  // ---- things that are already wrong -----------------------------------
  if (i.overdue > 0) {
    out.push({
      tone: 'critical',
      headline: `${plural(i.overdue, 'request')} past the statutory deadline`,
      detail:
        'Each one is a live compliance exposure. Regulators treat a missed deadline as a breach ' +
        'regardless of the eventual outcome, so these need closing or a documented extension today.',
      weight: 100 + i.overdue,
    });
  }

  if (i.breachingSoon > 0) {
    out.push({
      tone: 'warning',
      headline: `${plural(i.breachingSoon, 'request')} will breach within 48 hours`,
      detail:
        'Still recoverable. Either close them or record a justified extension before the deadline ' +
        'passes — an extension agreed after the fact does not count.',
      weight: 90 + i.breachingSoon,
    });
  }

  // ---- compliance trend --------------------------------------------------
  if (i.onTimeRate !== null) {
    const delta =
      i.previousOnTimeRate === null ? null : i.onTimeRate - i.previousOnTimeRate;
    if (i.onTimeRate < 90) {
      out.push({
        tone: i.onTimeRate < 75 ? 'critical' : 'warning',
        headline: `On-time closure is ${i.onTimeRate}%`,
        detail:
          `Roughly ${100 - i.onTimeRate} in every 100 requests are answered late` +
          (delta !== null && delta < 0 ? `, and the rate has fallen ${Math.abs(delta)} points.` : '.') +
          ' Sustained below 90% suggests capacity or routing, not individual cases.',
        weight: 85 + (90 - i.onTimeRate),
      });
    } else if (delta !== null && delta >= 5) {
      out.push({
        tone: 'positive',
        headline: `On-time closure improved to ${i.onTimeRate}%`,
        detail: `Up ${delta} points on the previous period. Whatever changed is working.`,
        weight: 40,
      });
    } else {
      out.push({
        tone: 'positive',
        headline: `On-time closure holding at ${i.onTimeRate}%`,
        detail: 'Comfortably inside the statutory window with margin to absorb a spike.',
        weight: 30,
      });
    }
  }

  // ---- demand ------------------------------------------------------------
  const volumeChange = pct(i.receivedLastWeek, i.receivedThisWeek);
  if (volumeChange !== null && Math.abs(volumeChange) >= 25 && i.receivedThisWeek > 0) {
    const up = volumeChange > 0;
    out.push({
      tone: up ? 'warning' : 'neutral',
      headline: `Intake ${up ? 'up' : 'down'} ${Math.abs(volumeChange)}% week on week`,
      detail:
        `${i.receivedThisWeek} received in the last 7 days against ${i.receivedLastWeek} the week before. ` +
        (up
          ? 'Check that throughput is keeping pace before the backlog compounds.'
          : 'A quieter week is the moment to clear the oldest open cases.'),
      weight: 60 + Math.min(20, Math.abs(volumeChange) / 5),
    });
  }

  // ---- throughput: are we keeping up with arrivals? ----------------------
  if (i.receivedThisWeek > 0 || i.closedThisWeek > 0) {
    const net = i.receivedThisWeek - i.closedThisWeek;
    if (net > 0 && i.receivedThisWeek >= 3) {
      out.push({
        tone: 'warning',
        headline: `Backlog grew by ${plural(net, 'request')} this week`,
        detail:
          `${i.receivedThisWeek} arrived and ${i.closedThisWeek} closed. At this rate the open queue ` +
          'roughly doubles every few weeks, which eventually shows up as missed deadlines.',
        weight: 70 + net,
      });
    } else if (net < 0) {
      out.push({
        tone: 'positive',
        headline: `Backlog reduced by ${plural(Math.abs(net), 'request')}`,
        detail: `${i.closedThisWeek} closed against ${i.receivedThisWeek} received. The queue is shrinking.`,
        weight: 35,
      });
    }
  }

  // ---- speed against the promise ----------------------------------------
  // Guard on a whole day: a sub-day SLA (a test policy, typically) rounds to
  // zero and would render as "of the 0 allowed".
  if (i.medianDaysToClose !== null && i.slaTargetDays !== null && i.slaTargetDays >= 1) {
    const used = Math.round((i.medianDaysToClose / i.slaTargetDays) * 100);
    out.push({
      tone: used > 80 ? 'warning' : 'positive',
      headline: `Median response takes ${i.medianDaysToClose} days of the ${i.slaTargetDays} allowed`,
      detail:
        used > 80
          ? `That uses ${used}% of the window, leaving almost no room for a complex case or an absence.`
          : `That uses ${used}% of the window, leaving healthy headroom.`,
      weight: used > 80 ? 65 : 25,
    });
  }

  // ---- where the pressure is --------------------------------------------
  if (i.worstZone && i.worstZone.overdue > 0) {
    out.push({
      tone: 'warning',
      headline: `${i.worstZone.zone} carries ${plural(i.worstZone.overdue, 'overdue request')}`,
      detail:
        'Concentrated in one zone rather than spread evenly, which points at approver capacity or ' +
        'coverage there rather than a systemic problem.',
      weight: 55 + i.worstZone.overdue,
    });
  }

  if (i.topRequestType && i.totalRequestTypes > 0) {
    const share = Math.round((i.topRequestType.n / i.totalRequestTypes) * 100);
    if (share >= 40) {
      out.push({
        tone: 'neutral',
        headline: `${share}% of requests are "${i.topRequestType.type}"`,
        detail:
          'A dominant request type is the best automation candidate: a templated path for it would ' +
          'take the largest single bite out of handling time.',
        weight: 45,
      });
    }
  }

  if (i.oldestOpenDays !== null && i.oldestOpenDays > 30) {
    out.push({
      tone: 'warning',
      headline: `Oldest open request is ${i.oldestOpenDays} days old`,
      detail:
        'Long-lived cases rarely resolve themselves and are the ones that surface in an audit. ' +
        'Worth a decision either way.',
      weight: 58,
    });
  }

  if (i.open === 0 && i.overdue === 0) {
    out.push({
      tone: 'positive',
      headline: 'No open requests',
      detail: 'Everything received has been answered and closed.',
      weight: 20,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}
