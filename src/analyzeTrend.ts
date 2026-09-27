/**
 * analyzeTrend.ts — turn a raw pageviews series into a defensible answer to
 * "is interest in this topic actually growing, and how much should I trust
 * that?"
 *
 * This is the part of the skill that keeps the agent honest. A naive
 * approach ("views went from 800 to 1400, that's +75%!") is exactly the
 * kind of claim that falls apart under a follow-up question ("is that just
 * one viral day?" / "isn't that a tiny sample?"). Every function here
 * exists to answer a specific follow-up question before the user has to
 * ask it.
 *
 * Core ideas:
 * - Work in monthly buckets by default; gap-fill missing months with 0 so a
 *   regression isn't silently fit to a sparser-than-it-looks x-axis.
 * - Fit the trend on log1p(views), not raw views. Interest usually
 *   grows/decays multiplicatively (percent-per-month), and a log-linear fit
 *   gives a slope that's directly interpretable as an approximate monthly
 *   growth rate.
 * - Always compute a "robust" version of the trend with outlier months
 *   downweighted (median absolute deviation based), and report both. A
 *   single news-driven spike month can flip a linear regression's sign.
 * - Attach explicit reliability flags (sparse data, short history, one
 *   spike dominates the story) rather than a single opaque confidence
 *   score, so the agent can state its assumptions in plain language rather
 *   than a made-up percentage.
 */

import type { DayPoint } from "./wikimediaClient.js";
import { linearRegression, weightedLinearRegression, median } from "./stats.js";

export interface MonthPoint {
  month: string; // "YYYY-MM"
  views: number;
}

export type TrendDirection = "growing" | "declining" | "flat" | "insufficient_data";

export interface TrendResult {
  nMonths: number;
  totalViews: number;
  meanMonthlyViews: number;
  slopePctPerMonth: number;
  rSquared: number;
  pValue: number;
  direction: TrendDirection;
  yoyChangePct: number | null;
  robustSlopePctPerMonth: number;
  outlierMonths: string[];
  reliabilityFlags: string[];
}

/** Bucket raw DayPoints into calendar months across [start, end] (both
 * "YYYYMMDD"), filling months with no data as 0 — matching the range
 * actually requested from the API, not just the span between the first and
 * last non-zero month. */
export function toMonthly(points: DayPoint[], start: string, end: string): MonthPoint[] {
  const byMonth = new Map<string, number>();
  for (const p of points) {
    const month = p.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + p.views);
  }

  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(4, 6));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(4, 6));

  const months: MonthPoint[] = [];
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    months.push({ month: key, views: byMonth.get(key) ?? 0 });
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/** exp(slope) - 1 in percent, for a fit on log1p(views) vs. month index —
 * an approximately correct, directly-interpretable %/month growth rate. */
function logLinearFit(months: MonthPoint[], weights?: number[]) {
  const x = months.map((_, i) => i);
  const y = months.map((m) => Math.log1p(m.views));

  if (!weights) {
    const fit = linearRegression(x, y);
    const pctPerMonth = (Math.exp(fit.slope) - 1) * 100;
    return { pctPerMonth, rSquared: fit.rSquared, pValue: fit.pValue };
  }
  const fit = weightedLinearRegression(x, y, weights);
  const pctPerMonth = (Math.exp(fit.slope) - 1) * 100;
  // Significance is judged on the raw (unweighted) fit — see stats.ts's
  // weightedLinearRegression doc comment.
  const rawFit = linearRegression(x, y);
  return { pctPerMonth, rSquared: fit.rSquared, pValue: rawFit.pValue };
}

export function analyze(points: DayPoint[], start: string, end: string): TrendResult {
  const months = toMonthly(points, start, end);
  const n = months.length;
  const views = months.map((m) => m.views);
  const total = views.reduce((a, b) => a + b, 0);
  const meanMonthly = n > 0 ? total / n : 0;

  const flags: string[] = [];

  if (n < 6) {
    return {
      nMonths: n,
      totalViews: total,
      meanMonthlyViews: meanMonthly,
      slopePctPerMonth: 0,
      rSquared: 0,
      pValue: 1,
      direction: "insufficient_data",
      yoyChangePct: null,
      robustSlopePctPerMonth: 0,
      outlierMonths: [],
      reliabilityFlags: ["short_history: fewer than 6 months of data — no trend claim is reliable"],
    };
  }

  // --- unweighted (raw) fit ---
  const { pctPerMonth, rSquared, pValue } = logLinearFit(months);

  // --- outlier detection via median absolute deviation ---
  const med = median(views);
  const mad = median(views.map((v) => Math.abs(v - med))) || 1;
  const zScores = views.map((v) => (0.6745 * (v - med)) / mad);
  const outlierIdx = zScores.map((z, i) => (Math.abs(z) > 4.0 ? i : -1)).filter((i) => i !== -1);
  const outlierMonths = outlierIdx.map((i) => months[i].month);

  // --- robust fit: downweight (not delete) outlier months ---
  const weights = months.map((_, i) => (outlierIdx.includes(i) ? 0.1 : 1));
  const robust = logLinearFit(months, weights);

  // --- year-over-year, if we have >=24 months ---
  let yoy: number | null = null;
  if (n >= 24) {
    const last12 = views.slice(-12).reduce((a, b) => a + b, 0);
    const prior12 = views.slice(-24, -12).reduce((a, b) => a + b, 0);
    if (prior12 > 0) yoy = ((last12 - prior12) / prior12) * 100;
  }

  // --- reliability flags ---
  if (meanMonthly < 50) {
    flags.push(
      `low_volume: average of only ${meanMonthly.toFixed(0)} views/month — percentage changes on this small a ` +
        `base are noisy; treat direction, not magnitude, as the takeaway`,
    );
  }
  if (outlierIdx.length > 0) {
    flags.push(
      `${outlierIdx.length} outlier month(s) detected (${outlierMonths.join(", ")}) — likely a news event or ` +
        `main-page feature, not organic interest; compare 'slope' (raw) against 'robustSlope' (outliers ` +
        `downweighted) below`,
    );
  }
  if (pValue >= 0.05) {
    flags.push(
      `trend not statistically significant (p=${pValue.toFixed(2)}) — month-to-month noise could plausibly ` +
        `explain the apparent direction; report this as 'no clear trend' rather than picking a direction`,
    );
  }
  if (n < 12) {
    flags.push(`only ${n} months of history — a full year (12+) gives a much sturdier read on seasonality`);
  }

  let direction: TrendDirection;
  if (pValue < 0.05 && Math.abs(pctPerMonth) > 0.5) {
    direction = pctPerMonth > 0 ? "growing" : "declining";
  } else {
    direction = "flat";
  }

  return {
    nMonths: n,
    totalViews: total,
    meanMonthlyViews: meanMonthly,
    slopePctPerMonth: pctPerMonth,
    rSquared,
    pValue,
    direction,
    yoyChangePct: yoy,
    robustSlopePctPerMonth: robust.pctPerMonth,
    outlierMonths,
    reliabilityFlags: flags,
  };
}

/** Rank multiple labeled TrendResults by robust growth rate. Series flagged
 * insufficient_data always sort last, regardless of slope — a missing/thin
 * series should never outrank a real trend just because its tiny sample
 * produced a big noisy percentage. */
export function rankSeries(results: Record<string, TrendResult>): Array<[string, TrendResult]> {
  return Object.entries(results).sort(([, a], [, b]) => {
    const usableA = a.direction !== "insufficient_data" ? 0 : 1;
    const usableB = b.direction !== "insufficient_data" ? 0 : 1;
    if (usableA !== usableB) return usableA - usableB;
    return b.robustSlopePctPerMonth - a.robustSlopePctPerMonth;
  });
}
