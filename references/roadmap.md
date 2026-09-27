# Roadmap: growing this past the basic case

Roughly in priority order:

## 1. Robustness of title resolution (do this first — it's the most common
   silent-failure point)
- Handle disambiguation explicitly: when the Action API search's top result
  title contains "(disambiguation)" or the query is a known-ambiguous short
  phrase, surface the top 3 candidates to the agent/user instead of picking
  one blindly.
- Resolve and sum redirect traffic into the canonical article, not just the
  canonical title's own direct views (see the redirects note in
  `api-notes.md`).
- Cache topic→QID resolutions separately from pageview data (they change far
  less often) so repeated related queries about the same topic across a
  session, or across sessions, skip the search+Wikidata round trip entirely.

## 2. More research depth per request
- Support **multiple topics × multiple languages** in one report (currently
  one topic, N languages, or the agent runs the CLI multiple times) — needs
  a small-multiples chart layout and a report that can span to 2 pages
  gracefully past some series-count threshold, while keeping the *default*
  case one page.
- Add a **related-topics** mode: given a topic's Wikidata item, pull related
  items (via `P279`/`P361`/category links) and show them side-by-side, so
  "is astronomy growing" can automatically suggest "you may also want to
  check: astrophysics, space exploration, cosmology."
- Cross-reference **edit activity** (the Analytics API's `edits/per-page`
  endpoint, same family as pageviews) alongside views — a topic with rising
  views AND rising edits is a stronger signal of durable interest than views
  alone, which can be driven by a single news cycle with no lasting
  community engagement.

## 3. Statistical depth
- Replace the median-absolute-deviation outlier flag with a proper seasonal
  decomposition (e.g. STL) once weekly/daily granularity work is common
  enough to need it — MAD-on-monthly-buckets is deliberately simple and
  adequate for month-level trend questions but won't hold up if this skill
  starts answering "what day of week peaks" type questions.
- Add bootstrap confidence intervals on the growth rate instead of only a
  point estimate + p-value, once users start asking "how sure are you"
  numerically rather than qualitatively.
- Detect and flag likely **Wikipedia-internal** traffic causes (e.g. a
  spike that aligns with the article being linked from the Main Page,
  detectable via the page's edit history around that date) versus
  *external* interest — these should probably be weighted very differently
  when a founder is deciding whether real-world interest is rising.

## 4. Scale
- Batch requests: the per-article endpoint is one HTTP call per
  (project, article, range) — for a "watch 30 topics across 10 languages"
  use case, add concurrency (a small pool respecting Wikimedia's
  rate-limit etiquette) rather than looping serially.
- Move the on-disk JSON cache (`src/cache.ts`) to SQLite once the
  number of cached series grows past a few hundred — still zero
  infrastructure to run, just faster lookups and easier pruning by age.
- If this becomes a recurring/scheduled watch ("alert me if interest in X
  starts growing") rather than an on-demand report, that's a different
  product shape (a stored baseline + diff each run) — worth a separate
  `src/watch.ts` rather than bending `analyzeTopic.ts` to do both.

## 5. Description/triggering quality
- Once this skill has real usage, run trigger-eval queries against a held-out
  test set to sharpen `SKILL.md`'s frontmatter `description` — right now
  it's written from first principles, not from observed under/over-triggering.
- If small/cheap models are observed skipping the resolution-verification
  step in practice (see `api-notes.md`'s validation section), make that
  step's instructions in `SKILL.md` more concrete — e.g. give an explicit
  example of a bad auto-resolved match and the exact follow-up call that
  fixes it, rather than describing the failure mode abstractly.

## If the chart requirements grow

The hand-drawn pdf-lib chart (see `api-notes.md` for why it's hand-drawn)
comfortably handles N line series over a monthly x-axis. If a future
version needs pie/stacked/area charts, small multiples, or genuinely
complex layouts, that's the point to reconsider the native-canvas tradeoff
— by then, either accept the native-dependency risk
(`chartjs-node-canvas`) with clear install documentation, or render charts
as SVG (still pure JS, e.g. hand-built or via a lightweight SVG-only
charting lib) and rasterize only if a raster image is truly needed, since
pdf-lib can also place SVG-derived vector paths without rasterizing at all.

## If this needs to run somewhere other than Node

The core logic (`analyzeTrend.ts`, `stats.ts`) has zero Node-specific APIs
and would port to a browser or edge runtime with only the `wikimediaClient`
and `cache` modules needing adjustment (browser `fetch` CORS restrictions
would likely require a small proxy for the Wikimedia calls; `cache.ts`'s
filesystem calls would become `localStorage`/IndexedDB). Not a near-term
need, but worth knowing the boundary is already clean.

## Packaging as an installable CLI

Right now this is a directory an agent `cd`s into and runs
`node dist/analyzeTopic.js`. If it needs to be installed globally or
referenced from multiple agent working directories, add a `bin` entry to
`package.json` pointing at `dist/analyzeTopic.js` (with a `#!/usr/bin/env
node` shebang) and publish/link it — a small change, deliberately not done
up front since it adds install-path complexity that isn't needed yet.

## Test runner

`tests/offline.test.ts` is currently a hand-rolled assertion script, not
wired into a test framework (no Jest/Vitest) — matching the "minimal
dependencies" philosophy while the test suite is this small. If it grows
past a handful of scenarios, switch to `node:test` (built into Node 18+,
zero new dependencies) rather than reaching for a framework.
