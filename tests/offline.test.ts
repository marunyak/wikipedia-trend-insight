/**
 * Offline sanity tests. These don't touch the network — the two functions
 * that actually call Wikimedia (wikimediaClient.fetchPageviews,
 * resolveTitles.resolveTopic) are exercised manually against the live API
 * before shipping (see references/api-notes.md). What's tested here is
 * everything downstream of a fetched series: gap-filling, trend math,
 * outlier detection, and PDF generation, using synthetic data with known
 * properties.
 *
 * Run with tsx (fastest for local dev):
 *   npm test
 * or against compiled output:
 *   npm run build:test
 */

import { analyze, toMonthly, type MonthPoint } from "../src/analyzeTrend.js";
import { buildReport } from "../src/makeReport.js";
import { statSync } from "node:fs";
import type { DayPoint } from "../src/wikimediaClient.js";

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSeries(opts: {
  nMonths?: number;
  startYear?: number;
  startMonth?: number;
  base?: number;
  monthlyGrowth?: number;
  spikeMonthIdx?: number;
  seed?: number;
}): { points: DayPoint[]; start: string; end: string } {
  const { nMonths = 24, startYear = 2023, startMonth = 1, base = 200, monthlyGrowth = 0.03, spikeMonthIdx, seed = 1 } = opts;
  const rand = mulberry32(seed);
  const points: DayPoint[] = [];
  let y = startYear;
  let m = startMonth;
  for (let i = 0; i < nMonths; i++) {
    let views = base * (1 + monthlyGrowth) ** i;
    views *= 0.85 + rand() * 0.3; // uniform[0.85, 1.15]
    if (spikeMonthIdx !== undefined && i === spikeMonthIdx) views *= 12;
    const dayViews = Math.max(1, Math.floor(views / 28));
    for (let d = 1; d <= 28; d++) {
      points.push({ date: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, views: dayViews });
    }
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  let endY = y;
  let endM = m - 1;
  if (endM === 0) {
    endM = 12;
    endY -= 1;
  }
  const start = `${String(startYear).padStart(4, "0")}${String(startMonth).padStart(2, "0")}01`;
  const end = `${String(endY).padStart(4, "0")}${String(endM).padStart(2, "0")}01`;
  return { points, start, end };
}

let failures = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

export async function main() {
  // growth detected as growing
  {
    const { points, start, end } = makeSeries({ monthlyGrowth: 0.05, seed: 2 });
    const r = analyze(points, start, end);
    assert(r.direction === "growing", `expected growing, got ${r.direction}`);
    assert(r.pValue < 0.05, `expected p<0.05, got ${r.pValue}`);
    assert(r.slopePctPerMonth > 0, `expected positive slope, got ${r.slopePctPerMonth}`);
    console.log(`growth test: slope=${r.slopePctPerMonth.toFixed(2)}%/mo p=${r.pValue.toFixed(4)} n=${r.nMonths}`);
  }

  // flat series not called growing
  {
    const { points, start, end } = makeSeries({ monthlyGrowth: 0.0, seed: 3 });
    const r = analyze(points, start, end);
    assert(r.direction === "flat" || r.direction === "insufficient_data", `expected flat, got ${r.direction}`);
    console.log(`flat test: direction=${r.direction} slope=${r.slopePctPerMonth.toFixed(2)}%/mo p=${r.pValue.toFixed(4)}`);
  }

  // outlier detected, robust slope differs
  {
    const { points, start, end } = makeSeries({ monthlyGrowth: 0.0, spikeMonthIdx: 12, seed: 4 });
    const r = analyze(points, start, end);
    assert(r.outlierMonths.length >= 1, "expected the injected spike month to be flagged");
    console.log(
      `outlier test: outliers=${JSON.stringify(r.outlierMonths)} raw_slope=${r.slopePctPerMonth.toFixed(2)} robust_slope=${r.robustSlopePctPerMonth.toFixed(2)}`,
    );
  }

  // short history flagged insufficient
  {
    const { points, start, end } = makeSeries({ nMonths: 3, seed: 5 });
    const r = analyze(points, start, end);
    assert(r.direction === "insufficient_data", `expected insufficient_data, got ${r.direction}`);
    assert(
      r.reliabilityFlags.some((f) => f.includes("short_history")),
      "expected short_history flag",
    );
  }

  // low volume flagged
  {
    const { points, start, end } = makeSeries({ base: 5, monthlyGrowth: 0.02, seed: 6 });
    const r = analyze(points, start, end);
    assert(
      r.reliabilityFlags.some((f) => f.includes("low_volume")),
      `expected low_volume flag, got ${JSON.stringify(r.reliabilityFlags)}`,
    );
  }

  // PDF report builds and is non-empty
  {
    const a = makeSeries({ monthlyGrowth: 0.06, seed: 7 });
    const b = makeSeries({ monthlyGrowth: -0.03, spikeMonthIdx: 5, seed: 8 });

    const monthsA: MonthPoint[] = toMonthly(a.points, a.start, a.end);
    const monthsB: MonthPoint[] = toMonthly(b.points, b.start, b.end);
    const resultA = analyze(a.points, a.start, a.end);
    const resultB = analyze(b.points, b.start, b.end);

    const outPath = "/tmp/test_report_ts.pdf";
    await buildReport({
      topic: "test topic",
      series: { "pl \u00b7 Test Article": monthsA, "cs \u00b7 Test Article": monthsB },
      trendResults: { "pl \u00b7 Test Article": resultA, "cs \u00b7 Test Article": resultB },
      outputPath: outPath,
      dateRangeLabel: "2023-01 to 2024-12",
      userQuestion: "Is interest in the test topic growing?",
    });
    const size = statSync(outPath).size;
    assert(size > 1500, `PDF suspiciously small: ${size} bytes`);
    console.log(`PDF built OK: ${outPath} (${size} bytes)`);
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\nAll offline tests passed.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
