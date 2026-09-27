/**
 * analyzeTopic.ts — the single entry point SKILL.md tells the agent to run.
 * Ties together resolveTitles -> wikimediaClient.fetchPageviews (cached) ->
 * analyzeTrend -> makeReport, and prints a compact JSON summary to stdout.
 * Two supported request shapes: --languages for auto-resolution, --pairs
 * for explicit lang:Title overrides when auto-resolution picks the wrong
 * article (see SKILL.md's "wrong-article correction" guidance).
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { cacheGet, cacheSet } from "./cache.js";
import { analyze, rankSeries, toMonthly, type MonthPoint, type TrendResult } from "./analyzeTrend.js";
import { resolveTopic } from "./resolveTitles.js";
import { fetchPageviews, type DayPoint } from "./wikimediaClient.js";
import { buildReport } from "./makeReport.js";

function dateRange(years: number, end?: string): [string, string] {
  let endD: Date;
  if (end) {
    endD = new Date(end);
  } else {
    // Default to the end of the last FULLY COMPLETED month, not today. The
    // current calendar month is still in progress, so its pageview total
    // is naturally low — a real live run comparing "chess" in en/de flagged
    // the current month as a MAD outlier in BOTH independent series at
    // once, which is the signature of a data-completeness artifact, not a
    // real coincidental spike. Landing on any date in the previous month
    // (day 0 of the current month = the previous month's last day) means
    // toMonthly's calendar-month bucketing stops at the last complete
    // month by default. Pass --end explicitly if you specifically want to
    // include the current partial month (e.g. to catch a very recent
    // spike) — just expect its bucket to look artificially low.
    const now = new Date();
    endD = new Date(now.getFullYear(), now.getMonth(), 0);
  }
  // Exact calendar-month arithmetic rather than years*365.25 days — the
  // latter drifts across month boundaries (a "1 year" lookback landed on
  // 13 calendar months, not 12, in the same live run that surfaced the
  // outlier-month issue above). Date's constructor normalizes an
  // out-of-range month index (e.g. -4) into the correct prior year, so this
  // needs no manual carry logic.
  const totalMonths = Math.round(years * 12);
  const startD = new Date(endD.getFullYear(), endD.getMonth() - totalMonths + 1, 1);
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`;
  return [fmt(startD), fmt(endD)];
}

async function fetchCached(
  project: string,
  article: string,
  start: string,
  end: string,
  access: "all-access" | "desktop" | "mobile-app" | "mobile-web",
  agent: "user" | "all-agents" | "spider" | "automated",
): Promise<DayPoint[]> {
  const params = { project, article, start, end, granularity: "monthly", access, agent };
  const cached = cacheGet<DayPoint[]>(params);
  if (cached) return cached;

  const points = await fetchPageviews(project, article, start, end, { granularity: "monthly", access, agent });
  cacheSet(params, points);
  return points;
}

export interface RunOptions {
  topic: string;
  languages?: string[];
  pairs?: Array<[string, string]>;
  years: number;
  end?: string;
  output: string;
  userQuestion?: string;
  /** "all-access" (default) | "desktop" | "mobile-app" | "mobile-web" — lets
   * a follow-up like "what about excluding mobile" be answered without
   * editing code. */
  access?: "all-access" | "desktop" | "mobile-app" | "mobile-web";
  /** "user" (default, excludes bots — almost always what you want) |
   * "all-agents" | "spider" | "automated". */
  agent?: "user" | "all-agents" | "spider" | "automated";
  /** Force the first title-resolution attempt to run on this language
   * edition instead of the automatic "en, then first target language"
   * fallback (see resolveTitles.ts's resolveTopic doc comment). Only
   * needed when neither of those two guesses matches the topic phrase's
   * own language. */
  anchorLanguage?: string;
}

export async function run(opts: RunOptions) {
  const outputPath = resolvePath(process.cwd(), opts.output);
  const [start, endYmd] = dateRange(opts.years, opts.end);
  const dateRangeLabel = `${start.slice(0, 4)}-${start.slice(4, 6)} to ${endYmd.slice(0, 4)}-${endYmd.slice(4, 6)}`;

  const resolutionNotes: string[] = [];
  let resolvedPairs: Array<[string, string]> = [];

  if (opts.pairs) {
    resolvedPairs = opts.pairs;
  } else {
    if (!opts.languages || opts.languages.length === 0) {
      throw new Error("Provide either languages (with topic) or pairs");
    }
    const resolution = await resolveTopic(opts.topic, opts.languages, opts.anchorLanguage);
    if (resolution.error) {
      // Deliberately loud and distinct from the success JSON shape below —
      // an earlier version printed this as a plain {"error": ...} object on
      // stdout with no other signal, which looks enough like normal output
      // that it's easy to miss the fact that NO PDF was written at all.
      console.error(`\n✗ FAILED — no PDF was created.\n`);
      console.error(`Reason: ${resolution.error}\n`);
      process.exitCode = 1;
      return;
    }
    for (const lang of opts.languages) {
      const project = `${lang}.wikipedia.org`;
      const title = resolution.titles[project];
      if (title) {
        resolvedPairs.push([lang, title]);
      } else {
        resolutionNotes.push(
          `No ${lang} Wikipedia article found for '${opts.topic}' (Wikidata item ${resolution.wikibaseItem}) — ` +
            `excluded from the comparison. This can itself be the finding: no localized coverage yet.`,
        );
      }
    }
  }

  if (resolvedPairs.length === 0) {
    console.error(`\n✗ FAILED — no PDF was created.\n`);
    console.error(`Reason: none of the requested languages had a resolvable article for '${opts.topic}'.\n`);
    if (resolutionNotes.length) console.error(resolutionNotes.join("\n"));
    process.exitCode = 1;
    return;
  }

  const series: Record<string, MonthPoint[]> = {};
  const trendResults: Record<string, TrendResult> = {};

  const access = opts.access ?? "all-access";
  const agent = opts.agent ?? "user";

  for (const [lang, title] of resolvedPairs) {
    const project = `${lang}.wikipedia.org`;
    const points = await fetchCached(project, title, start, endYmd, access, agent);
    const months = toMonthly(points, start, endYmd);
    const label = `${lang} \u00b7 ${title}`;
    series[label] = months;
    trendResults[label] = analyze(points, start, endYmd);
  }

  const assumptionNotes: string[] = [];
  if (access !== "all-access") assumptionNotes.push(`Filtered to ${access} traffic only (excludes other platforms).`);
  if (agent !== "user") assumptionNotes.push(`Traffic filter: ${agent} (default is human "user" traffic only — this run includes/uses a different filter, interpret volumes accordingly).`);

  await buildReport({
    topic: opts.topic,
    series,
    trendResults,
    outputPath,
    dateRangeLabel,
    userQuestion: opts.userQuestion,
    extraNotes: [...resolutionNotes, ...assumptionNotes],
  });

  const ranked = rankSeries(trendResults);
  const summary = {
    topic: opts.topic,
    dateRange: dateRangeLabel,
    outputPdf: outputPath,
    assumptions: { access, agent },
    rankedByRobustGrowth: ranked.map(([label, r]) => ({
      label,
      direction: r.direction,
      robustPctPerMonth: round(r.robustSlopePctPerMonth, 2),
      yoyChangePct: r.yoyChangePct !== null ? round(r.yoyChangePct, 1) : null,
      meanMonthlyViews: round(r.meanMonthlyViews, 1),
      nMonths: r.nMonths,
      reliabilityFlags: r.reliabilityFlags,
    })),
    resolutionNotes,
  };
  console.log(JSON.stringify(summary, null, 2));
  // Printed after (not instead of) the JSON, and to stderr, so it's visible
  // even if stdout is being piped/parsed elsewhere — this is the one line
  // that should never be ambiguous about whether a file actually landed.
  console.error(`\n✓ PDF written to: ${outputPath}`);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// --- CLI parsing ---
function parseArgs(argv: string[]): RunOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const getList = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const out: string[] = [];
    for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
    return out;
  };

  const topic = get("--topic");
  if (!topic) throw new Error("--topic is required");

  const pairsRaw = getList("--pairs");
  const pairs = pairsRaw?.map((p) => {
    const [lang, ...rest] = p.split(":");
    return [lang, rest.join(":").replace(/_/g, " ")] as [string, string];
  });

  const access = get("--access") as RunOptions["access"] | undefined;
  const agent = get("--agent") as RunOptions["agent"] | undefined;
  const validAccess = ["all-access", "desktop", "mobile-app", "mobile-web"];
  const validAgent = ["user", "all-agents", "spider", "automated"];
  if (access && !validAccess.includes(access)) throw new Error(`--access must be one of: ${validAccess.join(", ")}`);
  if (agent && !validAgent.includes(agent)) throw new Error(`--agent must be one of: ${validAgent.join(", ")}`);

  return {
    topic,
    languages: getList("--languages"),
    pairs,
    years: Number(get("--years") ?? "2"),
    end: get("--end"),
    output: get("--output") ?? "report.pdf",
    userQuestion: get("--user-question"),
    access,
    agent,
    anchorLanguage: get("--anchor-language"),
  };
}

// Compared via pathToFileURL, not a hand-built "file://" string — see the
// matching comment in resolveTitles.ts for why (a space anywhere in the
// project path, e.g. a macOS-generated "folder 2", silently breaks the
// naive comparison and this CLI produces zero output with no error).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  run(opts).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
