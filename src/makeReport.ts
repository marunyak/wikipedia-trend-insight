/**
 * makeReport.ts — render the trend chart and assemble the one-page,
 * shareable PDF report, using pdf-lib's vector drawing primitives directly
 * (lines, circles, text) rather than a charting library + canvas.
 *
 * Why draw the chart by hand instead of e.g. chartjs-node-canvas: this
 * skill's whole premise is "dependencies and environment setup must be
 * reproducible" (per the task brief). Canvas-backed chart libraries need
 * native bindings (node-canvas, skia) that are exactly the kind of thing
 * that's easy on one machine and a broken `npm install` on another. pdf-lib
 * is pure JS. A hand-drawn line chart with ~150 lines of coordinate math is
 * a small price for a report generator that reliably installs anywhere
 * Node runs.
 *
 * Design choices worth knowing about before you change this: one page,
 * always — if findings don't fit, that's a signal to tighten the writing,
 * not add a page; the chart always shows the actual monthly series, not
 * just the fitted line, with outlier months circled, not hidden — trust is
 * built by letting the reader see the noise the stats summarized; every
 * report ends with a "Caveats" section populated straight from
 * TrendResult.reliabilityFlags — never suppress these to make a report
 * look cleaner.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MonthPoint, TrendResult } from "./analyzeTrend.js";

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 43; // ~0.6in

/** Walk up from this module's compiled location until a directory
 * containing package.json is found, then return <that dir>/assets/fonts.
 * Deliberately not a fixed relative path ("../assets/fonts") because how
 * many directories up "here" is from the package root differs between the
 * production build (tsconfig.json, dist/makeReport.js sits directly under
 * the package root) and the dev/test build (tsconfig.tests.json preserves
 * the src/ subfolder under dist-test/) — walking up to the nearest
 * package.json is robust to both without hard-coding either layout. */
function findFontsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return join(dir, "assets", "fonts");
    dir = dirname(dir);
  }
  throw new Error("Could not locate package root (no package.json found while walking up from makeReport.js) — cannot find bundled fonts");
}

let cachedFontBytes: { regular: Buffer; bold: Buffer; oblique: Buffer } | null = null;
function loadFontBytes() {
  if (cachedFontBytes) return cachedFontBytes;
  const dir = findFontsDir();
  cachedFontBytes = {
    regular: readFileSync(join(dir, "DejaVuSans.ttf")),
    bold: readFileSync(join(dir, "DejaVuSans-Bold.ttf")),
    oblique: readFileSync(join(dir, "DejaVuSans-Oblique.ttf")),
  };
  return cachedFontBytes;
}

// A qualitative 10-color palette (matplotlib's "tab10") rather than the
// original 5 colors — with only 5, any request comparing 6+ language
// editions (a realistic shape for query 3's "compare across our chosen
// language editions") silently recycled colors, making two genuinely
// different series look like the same line on the chart even though the
// underlying data and findings table were always correct. Legend text
// still disambiguates regardless, but the chart itself shouldn't need that
// as a crutch up to a reasonable number of series.
const SERIES_COLORS = [
  rgb(0.122, 0.467, 0.706), // blue
  rgb(1.0, 0.498, 0.055), // orange
  rgb(0.173, 0.627, 0.173), // green
  rgb(0.839, 0.153, 0.157), // red
  rgb(0.58, 0.404, 0.741), // purple
  rgb(0.549, 0.337, 0.294), // brown
  rgb(0.89, 0.467, 0.761), // pink
  rgb(0.498, 0.498, 0.498), // gray
  rgb(0.737, 0.741, 0.133), // olive
  rgb(0.09, 0.745, 0.812), // cyan
];

function directionWord(result: TrendResult): string {
  switch (result.direction) {
    case "growing":
      return "^ Growing";
    case "declining":
      return "v Declining";
    case "flat":
      return "- No clear trend";
    default:
      return "? Not enough data";
  }
}

interface ChartArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

function drawChart(
  page: PDFPage,
  font: PDFFont,
  area: ChartArea,
  series: Record<string, MonthPoint[]>,
  trendResults: Record<string, TrendResult>,
) {
  const labels = Object.keys(series);
  const months = series[labels[0]]?.map((m) => m.month) ?? [];
  const n = months.length;
  const maxViews = Math.max(1, ...labels.flatMap((l) => series[l].map((m) => m.views)));

  const plotX = area.x + 34; // room for y-axis labels
  const plotY = area.y + 26; // room for x-axis labels
  const plotW = area.width - 34;
  const plotH = area.height - 26;

  const xOf = (i: number) => plotX + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yOf = (v: number) => plotY + (v / maxViews) * plotH;

  // Axes
  page.drawLine({
    start: { x: plotX, y: plotY },
    end: { x: plotX, y: plotY + plotH },
    thickness: 0.75,
    color: rgb(0.3, 0.3, 0.3),
  });
  page.drawLine({
    start: { x: plotX, y: plotY },
    end: { x: plotX + plotW, y: plotY },
    thickness: 0.75,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Y gridlines/labels (4 ticks)
  for (let t = 0; t <= 4; t++) {
    const v = (maxViews / 4) * t;
    const y = yOf(v);
    page.drawLine({
      start: { x: plotX, y },
      end: { x: plotX + plotW, y },
      thickness: 0.4,
      color: rgb(0.88, 0.88, 0.88),
    });
    page.drawText(formatCompact(v), { x: area.x, y: y - 3, size: 6.5, font, color: rgb(0.35, 0.35, 0.35) });
  }

  // X labels (sparse)
  const step = Math.max(1, Math.floor(n / 8));
  for (let i = 0; i < n; i += step) {
    page.drawText(months[i], {
      x: xOf(i) - 12,
      y: area.y,
      size: 6.5,
      font,
      color: rgb(0.35, 0.35, 0.35),
      rotate: undefined,
    });
  }

  // Series lines + points, outliers circled
  labels.forEach((label, li) => {
    const color = SERIES_COLORS[li % SERIES_COLORS.length];
    const pts = series[label];
    for (let i = 0; i < pts.length - 1; i++) {
      page.drawLine({
        start: { x: xOf(i), y: yOf(pts[i].views) },
        end: { x: xOf(i + 1), y: yOf(pts[i + 1].views) },
        thickness: 1.3,
        color,
      });
    }
    const outliers = new Set(trendResults[label]?.outlierMonths ?? []);
    for (let i = 0; i < pts.length; i++) {
      const r = outliers.has(pts[i].month) ? 3.2 : 1.3;
      page.drawCircle({ x: xOf(i), y: yOf(pts[i].views), size: r, color, borderColor: color, borderWidth: 0.5 });
    }
  });
}

/** Legend is laid out as its own band above the chart, with an explicit
 * height the caller reserves up front — kept separate from drawChart so the
 * legend's vertical space is never accidentally shared with the chart's own
 * top gridline/label (an earlier version of this file had them overlap). */
function legendHeightFor(nSeries: number): number {
  return nSeries * 11 + 4;
}

function drawLegend(page: PDFPage, font: PDFFont, x: number, topY: number, labels: string[]) {
  labels.forEach((label, li) => {
    const color = SERIES_COLORS[li % SERIES_COLORS.length];
    const y = topY - li * 11;
    page.drawLine({ start: { x, y: y + 2.5 }, end: { x: x + 14, y: y + 2.5 }, thickness: 2, color });
    page.drawText(label, { x: x + 18, y, size: 7.5, font, color: rgb(0.15, 0.15, 0.15) });
  });
}

function formatCompact(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

export interface BuildReportOptions {
  topic: string;
  series: Record<string, MonthPoint[]>;
  trendResults: Record<string, TrendResult>;
  outputPath: string;
  dateRangeLabel: string;
  userQuestion?: string;
  extraNotes?: string[];
}

export async function buildReport(opts: BuildReportOptions): Promise<string> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const bytes = loadFontBytes();
  // subset: true keeps the embedded font to only the glyphs actually used,
  // since DejaVu Sans's full character set (Latin+Cyrillic+Greek+more) is
  // much larger than any single report needs.
  const font = await doc.embedFont(bytes.regular, { subset: true });
  const fontBold = await doc.embedFont(bytes.bold, { subset: true });
  const fontItalic = await doc.embedFont(bytes.oblique, { subset: true });

  let cursorY = PAGE_H - MARGIN;

  page.drawText(`Wikipedia interest trend: ${opts.topic}`, {
    x: MARGIN,
    y: cursorY,
    size: 17,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  cursorY -= 16;

  const subtitle = `${opts.dateRangeLabel} \u00b7 generated ${new Date().toISOString().slice(0, 10)} \u00b7 source: Wikimedia Pageviews API`;
  page.drawText(subtitle, { x: MARGIN, y: cursorY, size: 8.5, font, color: rgb(0.45, 0.45, 0.45) });
  cursorY -= 14;

  if (opts.userQuestion) {
    page.drawText(truncate(opts.userQuestion, 110), { x: MARGIN, y: cursorY, size: 9, font: fontItalic, color: rgb(0.2, 0.2, 0.2) });
    cursorY -= 14;
  }

  const labels = Object.keys(opts.series);
  cursorY -= 6;
  const legendH = legendHeightFor(labels.length);
  drawLegend(page, font, MARGIN, cursorY, labels);
  cursorY -= legendH + 4;

  const chartHeight = 175;
  const chartArea: ChartArea = { x: MARGIN, y: cursorY - chartHeight, width: PAGE_W - 2 * MARGIN, height: chartHeight };
  drawChart(page, font, chartArea, opts.series, opts.trendResults);
  cursorY = chartArea.y - 20;

  page.drawText("Findings", { x: MARGIN, y: cursorY, size: 11, font: fontBold });
  cursorY -= 14;

  const colX = [MARGIN, MARGIN + 150, MARGIN + 260, MARGIN + 360, MARGIN + 400, MARGIN + 480];
  const headers = ["Series", "Trend", "%/mo (robust)", "YoY", "Avg. monthly", "Months"];
  page.drawRectangle({ x: MARGIN, y: cursorY - 4, width: PAGE_W - 2 * MARGIN, height: 14, color: rgb(0.94, 0.94, 0.94) });
  headers.forEach((h, i) => page.drawText(h, { x: colX[i] + 2, y: cursorY, size: 7.5, font: fontBold }));
  cursorY -= 14;

  for (const [label, result] of Object.entries(opts.trendResults)) {
    const yoyStr = result.yoyChangePct !== null ? `${result.yoyChangePct >= 0 ? "+" : ""}${result.yoyChangePct.toFixed(0)}%` : "n/a";
    const row = [
      truncate(label, 26),
      directionWord(result),
      `${result.robustSlopePctPerMonth >= 0 ? "+" : ""}${result.robustSlopePctPerMonth.toFixed(1)}%`,
      yoyStr,
      result.meanMonthlyViews.toLocaleString("en-US", { maximumFractionDigits: 0 }),
      String(result.nMonths),
    ];
    row.forEach((cell, i) => page.drawText(cell, { x: colX[i] + 2, y: cursorY, size: 7.8, font }));
    page.drawLine({
      start: { x: MARGIN, y: cursorY - 3 },
      end: { x: PAGE_W - MARGIN, y: cursorY - 3 },
      thickness: 0.3,
      color: rgb(0.85, 0.85, 0.85),
    });
    cursorY -= 13;
  }

  cursorY -= 6;
  const allFlags: string[] = [];
  for (const [label, result] of Object.entries(opts.trendResults)) {
    for (const flag of result.reliabilityFlags) allFlags.push(`${label}: ${flag}`);
  }
  if (opts.extraNotes) allFlags.push(...opts.extraNotes);

  if (allFlags.length > 0) {
    page.drawText("Caveats & how much to trust this", { x: MARGIN, y: cursorY, size: 11, font: fontBold });
    cursorY -= 13;
    for (const flag of allFlags) {
      const lines = wrapText(flag, 105);
      for (const line of lines) {
        page.drawText(`\u2022 ${line}`, { x: MARGIN, y: cursorY, size: 7.6, font, color: rgb(0.33, 0.33, 0.33) });
        cursorY -= 10;
      }
    }
  }

  cursorY -= 10;
  const footer =
    "Data: Wikimedia Foundation Pageviews API (public, CC BY-SA 3.0 unless noted otherwise on the source pages). " +
    "Page-view interest is a proxy for reader curiosity, not purchase intent or demand \u2014 use it to prioritize " +
    "further validation, not as a standalone go/no-go signal.";
  for (const line of wrapText(footer, 110)) {
    page.drawText(line, { x: MARGIN, y: cursorY, size: 7.6, font, color: rgb(0.4, 0.4, 0.4) });
    cursorY -= 9;
  }

  const pdfBytes = await doc.save();
  writeFileSync(opts.outputPath, pdfBytes);
  return opts.outputPath;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function wrapText(s: string, maxCharsPerLine: number): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}
