# wikipedia-trend-insight

An [Agent Skill](https://agentskills.io/specification) (TypeScript/Node)
that analyzes
[Wikimedia pageview data](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html)
and produces a one-page, shareable PDF report — chart, findings, and the
assumptions/caveats behind them.

`SKILL.md` is the agent-facing instructions (read that for how to actually
use this). This README is for humans setting it up or extending it.

## What's here

```
wikipedia-trend-insight-ts/
├── SKILL.md                    agent instructions
├── package.json                runtime deps: pdf-lib, @pdf-lib/fontkit
├── assets/fonts/                bundled DejaVu Sans (Unicode PDF text — see api-notes.md)
├── tsconfig.json                production build (src/ -> dist/)
├── tsconfig.tests.json          dev-only build that also compiles tests/
├── src/
│   ├── wikimediaClient.ts       HTTP layer (Node's built-in fetch, no HTTP dep)
│   ├── resolveTitles.ts         topic → correct per-language title, via Wikidata
│   ├── cache.ts                 on-disk cache keyed by exact request params
│   ├── stats.ts                 hand-rolled OLS + Student's t p-value (no stats dep)
│   ├── analyzeTrend.ts          gap-filling, growth fit, outlier detection, flags
│   ├── makeReport.ts            one-page PDF, hand-drawn chart via pdf-lib (no canvas dep)
│   └── analyzeTopic.ts          orchestrator CLI — the one thing the agent runs
├── tests/
│   └── offline.test.ts          synthetic-data tests for everything downstream of a fetch
└── references/
    ├── api-notes.md             endpoints, edge cases, design rationale, verification log
    └── roadmap.md               how to extend this toward heavier research/larger data
```

## Setup

```bash
npm install
npm run build
```

## Try it

```bash
node dist/analyzeTopic.js \
  --topic "intermittent fasting" \
  --languages pl cs \
  --years 2 \
  --output /tmp/report.pdf \
  --user-question "Порівняй зростання інтересу до інтервального голодування в польськомовній та чеськомовній Wikipedia за останні два роки."
```

Other flags: `--pairs lang:Exact_Title` to override auto-resolved titles,
`--access`/`--agent` to filter by platform or bot traffic, `--end` for a
custom end date. See `SKILL.md` for when to use each.

Offline tests (no network needed):

```bash
npm test
```

Cheap-model validation (needs an OpenRouter API key, costs a fraction of a
cent — see `tests/model-eval.mjs` for what it checks and why):

```bash
OPENROUTER_API_KEY=sk-or-... npm run eval:model
```

## Dependency footprint

Two runtime dependencies: `pdf-lib` and `@pdf-lib/fontkit` (for embedding a
Unicode font, since pdf-lib's built-in fonts can't render Cyrillic or many
Central/Eastern European characters — a bundled DejaVu Sans in `assets/`
covers this). No HTTP client, charting library, or stats library — Node's
built-in `fetch` and a small hand-rolled regression in `stats.ts` cover what
those would otherwise add. Full reasoning in `references/api-notes.md`.

## Verification status

Three layers of testing, each covering something different — worth keeping
separate rather than collapsing into one "it's tested" claim:

1. **Code correctness (offline, synthetic data):** `npm run build` compiles
   cleanly; `tests/offline.test.ts` passes — trend math, outlier detection,
   and PDF generation are all covered without needing network access.
2. **Model reasoning, on a real cheap model:** `tests/model-eval.mjs` was
   actually run against `anthropic/claude-haiku-4.5` via OpenRouter (not
   hypothetical — see `references/api-notes.md` for the full transcript
   and analysis). Result: 2 of 3 tool calls were correct immediately; the
   third surfaced a real bug (a non-English topic phrase failed to resolve
   because title search only ever tried English Wikipedia first), which is
   now fixed in `resolveTitles.ts`. Separately, the model's interpretation
   of a realistic result (one real trend, one statistically flat series,
   one series with too little data) was checked and got every distinction
   right — it didn't just report every number as "growing."
3. **Full live end-to-end (real Wikimedia API, real PDF, real font
   embedding):** confirmed — `node dist/analyzeTopic.js --topic "chess"
   --languages en de --years 1 --output /tmp/chess.pdf` was run for real
   and produced a PDF with no crash, validating the font fix, the
   silent-failure fix, and the path-with-spaces fix all together. That same
   run surfaced one more real bug (the current, in-progress month was
   being included by default and its partial total looked like a false
   outlier in every series) — now fixed; see `references/api-notes.md`
   for the full story. Open a freshly generated PDF yourself if you want to
   re-confirm:
   ```bash
   npm install && npm run build
   node dist/analyzeTopic.js --topic "chess" --languages en de --years 1 --output /tmp/chess.pdf
   ```

