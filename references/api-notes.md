# Wikimedia API notes

## Endpoints used

**Pageviews (Analytics/AQS REST API)** — no key required, but a descriptive
`User-Agent` is required by Wikimedia's API etiquette (set via
`WIKIMEDIA_CONTACT` env var; see `src/wikimediaClient.ts`).

```
GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}
```

- `project`: e.g. `en.wikipedia.org`, `pl.wikipedia.org`
- `access`: `all-access` | `desktop` | `mobile-app` | `mobile-web`
- `agent`: `user` | `all-agents` | `spider` | `automated` — this skill
  defaults to `user` to exclude bot/crawler traffic, which can dominate
  low-traffic articles and produce a fake "trend."
- `article`: exact title, spaces as underscores or `%20`, URL-encoded
- `granularity`: `daily` | `monthly`
- `start`/`end`: `YYYYMMDD` — required even for monthly granularity; the API
  buckets by calendar month regardless of the day-of-month given
- Data starts **2015-07-01**; requesting earlier dates returns empty, not an
  error.
- A 404 means "no data for this exact title in this range" — could mean the
  article didn't exist yet, the title is wrong, or (rarely) a genuinely
  zero-traffic period. Treat as an empty series, not a crash, and say so to
  the user rather than pretending the topic has zero interest.

**Action API** (`https://{project}/w/api.php`) — used only for search
(`list=search`) and page metadata (`prop=pageprops`, specifically the
`wikibase_item` QID) inside `resolveTitles.ts`.

**Wikidata API** (`https://www.wikidata.org/w/api.php`,
`action=wbgetentities`) — used to pull `sitelinks` for a QID, which is how
we get the *correct* article title per language edition without hand-translating.

## Known edge cases to watch for

- **Disambiguation and homonyms.** A free-text search for a short/common
  topic name can match a disambiguation page or the wrong sense of the word.
  `resolveTitles.ts` takes the top search result, which is usually right
  but not guaranteed — `SKILL.md`'s workflow tells the agent to spot-check
  via the page-summary endpoint when the topic is ambiguous, rather than
  trusting it blindly.
- **Page moves/renames.** Pageview history is tied to the *current* title;
  Wikimedia's pageviews API generally does not retroactively merge view
  counts across a rename. A long-running topic that was retitled mid-window
  can show an artificial cliff at the rename date. There's no cheap
  general fix; if a series shows a suspicious hard discontinuity, check the
  article's move log before reporting the "decline" as real interest loss.
- **Redirects.** Views of a redirect page are usually attributed to the
  redirect's title, not the target, in the raw per-article dumps this API
  is built from — for major topics this is rarely material, but for niche
  ones a chunk of real traffic can be hiding under a redirect title the
  article's canonical title doesn't capture. Not currently handled
  automatically; a future version could resolve and sum redirects too (see
  `roadmap.md`).
- **Non-Latin scripts / percent-encoding.** Titles are UTF-8, URL-encoded
  before the request (`wikimediaClient.ts` handles this via
  `encodeURIComponent`) — don't hand-build URLs by string concatenation
  elsewhere in the codebase.
- **Main-page features and news spikes.** A single day of being featured or
  in the news can dwarf months of organic traffic. This is exactly what the
  outlier detection in `analyzeTrend.ts` (median-absolute-deviation based)
  and the `robustPctPerMonth` figure exist to separate from real trend.

## Why Node's built-in `fetch` and no HTTP library

Node 18+ ships a spec-compliant `fetch`. Adding `node-fetch` or `axios`
would be one more dependency for zero behavioral gain here — the retry/
backoff logic in `wikimediaClient.ts`'s `get()` is the same either way.

## Why pdf-lib instead of a charting library + canvas

The obvious "port matplotlib" move would be `chartjs-node-canvas` or
similar, which renders Chart.js output to a PNG via `node-canvas`.
`node-canvas` needs native bindings (`cairo`, `pango`, etc.) compiled for
the host platform — exactly the kind of dependency that installs fine on
a developer's laptop and fails silently or loudly in a locked-down agent
sandbox or CI image with a different libc/architecture. Since the task
brief is explicit that dependencies and setup must be reproducible, that
risk isn't worth it for a chart this simple.

`makeReport.ts` instead draws the line chart directly with pdf-lib's vector
primitives (`drawLine`, `drawCircle`, `drawText`) — pure JS, no native
compilation step, works identically wherever Node runs. The tradeoff is
~150 lines of coordinate math (axis scaling, gridlines, legend layout)
living in this codebase instead of being delegated to a library. Given the
chart only ever needs to show a handful of line series over a monthly
x-axis, that tradeoff is worth it here; it would not be worth it for a
skill that needed general-purpose charting (pie charts, stacked areas,
etc.) — see `roadmap.md` for what to reach for if the chart requirements
grow past what hand-drawn vector code comfortably handles.

## Why hand-rolled statistics (`stats.ts`) instead of a stats library

Same reasoning as pdf-lib: `simple-statistics` covers linear regression and
r², but not the p-value machinery (Student's t CDF) needed to say "is this
trend statistically real." `jstat` has that, but pulls in a much larger
surface area for one function. The regularized-incomplete-beta-function
approach in `stats.ts` is a well-known, numerically stable ~40-line
implementation (the same one commonly used in Numerical Recipes-derived
code); its output was checked against known reference p-values on
synthetic data (a clear growth series, a flat series, a series with an
injected outlier — see `tests/offline.test.ts`), and agreed to the
precision that matters here (p ≈ 0 for a clearly growing series, p > 0.05
for a flat one).

## Native TypeScript execution options considered

Node 22 (what this was developed against) supports
`--experimental-strip-types`, which runs `.ts` files directly without a
build step — but it does not remap `.js`-suffixed import specifiers to
sibling `.ts` files, so a codebase written the NodeNext-idiomatic way (this
one, importing `"./foo.js"` from `foo.ts` in anticipation of the compiled
output) can't be run that way without a build step regardless. Given a
build step is needed either way, `tsc` to plain JS is the most
reproducible run path (`npm run build && node dist/analyzeTopic.js ...`);
`tsx` is offered as a devDependency purely for faster local iteration
during development (`npm run analyze -- --topic ...` without a rebuild
each time).

## Why the report embeds a custom Unicode font (DejaVu Sans) instead of a
   standard PDF font

**This bit was wrong in the first shipped version and is worth understanding
if you touch `makeReport.ts` again.** pdf-lib's 14 "standard" fonts
(`StandardFonts.Helvetica` etc.) can only encode text in WinAnsi — roughly
Windows-1252/Latin-1, a narrow Western European subset. That's fine for
English, but this skill routinely needs to render:
- article titles with Polish/Czech/etc. diacritics not in WinAnsi
  (e.g. Czech "ř", "ů"), and
- `--user-question` text the agent echoes verbatim, which is very often
  Cyrillic (Ukrainian/Russian), since that's a realistic language for the
  people asking these product questions.

Both crash `page.drawText` with a standard font
(`Error: WinAnsi cannot encode "П" (0x041f)`), immediately, on the first
Cyrillic or extended-Latin character.

The fix: bundle a real Unicode TrueType font (`assets/fonts/DejaVuSans*.ttf`
— chosen because it has broad coverage of Latin Extended, Cyrillic, and
Greek, is freely redistributable, and is a common Linux system font so it
was already on hand during development) and embed it via
[`@pdf-lib/fontkit`](https://www.npmjs.com/package/@pdf-lib/fontkit), pdf-lib's
own documented mechanism for custom-font embedding (see pdf-lib's README,
"Embed Font and Measure Text" — `makeReport.ts`'s font-loading code follows
that example precisely: `doc.registerFontkit(fontkit)` then
`doc.embedFont(fontBytes, { subset: true })`). `subset: true` keeps the
embedded font data to only the glyphs actually used in a given report,
since DejaVu Sans's full character set is much larger than any one report
needs.

`findFontsDir()` in `makeReport.ts` locates `assets/fonts/` by walking
up from the compiled module's own location until it finds a `package.json`,
rather than a fixed `"../assets/fonts"` relative path — this makes it robust
to the module living at different depths under different build outputs
(the production build's `dist/` vs. the dev/test build's `dist-test/src/`),
without needing to keep two hardcoded paths in sync.

**What this means for anyone extending the report:** always draw text with
the embedded `font`/`fontBold`/`fontItalic` values passed around inside
`buildReport`, never re-introduce a `StandardFonts.*` reference — doing so
reintroduces the exact crash this section describes, and it will only show
up the first time a non-Latin string reaches that code path, not in a quick
English-only smoke test.

## How this was verified without network access

`@pdf-lib/fontkit` could not be installed in the sandboxed development
environment (no npm registry access), so the actual font-parsing call
(`fontkit.create(fontBytes)`) was never executed end-to-end here. What was
verified instead:
- The exact import/register/embed pattern in `makeReport.ts` was checked
  character-for-character against pdf-lib's own bundled README example for
  custom font embedding, and against pdf-lib's own shipped
  `Fontkit`/`Font` TypeScript interfaces (in
  `node_modules/pdf-lib/cjs/types/fontkit.d.ts` once installed) — the
  `create(buffer, postscriptName?): Font` contract `@pdf-lib/fontkit`'s
  default export must satisfy.
- A structural type stub matching that exact interface was used to confirm
  `makeReport.ts` type-checks correctly against it (`npx tsc` clean).
- The same stub, wired up at runtime with a `create()` that deliberately
  throws, was used to confirm the call actually reaches
  `fontkit.create(...)` — i.e. that `findFontsDir`, `loadFontBytes`,
  `registerFontkit`, and `embedFont` are all wired correctly and the only
  untested step is fontkit's own (well-established, widely-used) TTF
  parsing.
- `DejaVuSans.ttf`'s Unicode coverage (Cyrillic, Latin Extended-A) was
  confirmed via `fc-list`/font metadata rather than assumed.

**Before trusting this fully:** run `npm install && npm run build`, then
the exact command that originally failed
(`--user-question` with Ukrainian text, `--pairs` with a Polish/Czech
diacritic-bearing title) and confirm the PDF opens correctly. If anything
about DejaVu's coverage or fontkit's parsing surprises you, that's the
first place to look.

## Verified against the task's three example queries specifically

**Update:** this section originally described what to check when the
cheap-model validation eventually ran; it has now actually been run
(`tests/model-eval.mjs` against `anthropic/claude-haiku-4.5` via
OpenRouter) and found a real bug, fixed below — this isn't hypothetical
anymore.

**Finding from the actual run:** for query 2 (astronomy, Ukrainian-only),
the model naturally passed the topic as `"астрономія"` — the word the user
actually used — rather than translating it to `"astronomy"` first.
`resolveTopic` at the time always searched English Wikipedia first with no
fallback, so a Ukrainian phrase there would very likely find nothing and
the whole request would fail with "no PDF was created," even though the
model's tool call was completely reasonable — there was never a rule
telling it to translate the topic before passing it. Fixed in
`resolveTitles.ts`: `resolveTopic` now tries English first, and — if that
finds nothing — automatically retries on the first requested language.
Verified against exactly the failing case (English search returning
nothing, Ukrainian search on `uk.wikipedia.org` succeeding) with a mocked
`wikimediaClient` before shipping the fix. `SKILL.md` also now says
explicitly that the topic can be passed in any language and resolution
handles it, so a model doesn't need to guess whether translating first
would help.

**What worked correctly on the first try, no fixes needed:** all three
tool calls otherwise matched real CLI flags with no hallucination (right
topic, right language codes, sensible `--years`, real `--output` paths,
the original question echoed for `--user-question`). More importantly,
step 2 — feeding the model a canned result with one genuinely-growing
series, one flat-and-not-significant series, and one series with only 4
months of history — produced a response that got every distinction right:
led with the significant grower as the actual recommendation, explicitly
called the flat series noise (citing p=0.41) rather than reporting its
positive-but-meaningless percentage, and correctly refused to give the
short-history series a trend verdict at all. This is the check that
mattered most (a model that calls the tool right but then reports
everything as "growing" would defeat the skill's whole purpose), and it
passed clean.

The task brief gives three example prompts. Query 1 (two languages) was
already the basis of the offline test suite. Queries 2 and 3 were checked
separately since they exercise shapes the original tests didn't cover:

- **Query 2** ("is interest in astronomy growing in Ukrainian Wikipedia,
  and how much can this be trusted") is a single-topic, single-language
  request — `analyzeTopic.js --topic "astronomy" --languages uk --years 2`.
  This is the simplest case the orchestrator supports and was confirmed to
  render correctly with exactly one series (chart's `n <= 1` guard in
  `drawChart`'s `xOf` was specifically checked — a single-point or
  single-series chart doesn't divide by zero).
- **Query 3** ("compare interest in learning English across our chosen
  language editions, report which audiences to investigate next and why")
  is a single-topic, multi-language request — the normal
  `--languages <several codes>` path, with `rankedByRobustGrowth` in the
  JSON summary directly answering "which audiences next" (already sorted,
  insufficient-data series pushed to the bottom) and `reliabilityFlags`
  supplying the "why." Two things specific to this query's shape were
  checked by generating synthetic 5- and 8-series reports and visually
  inspecting them:
  1. **The original 5-color chart palette silently recycled colors past 5
     series** — with 8 series, two pairs of lines rendered in identical
     colors, making the chart genuinely ambiguous even though the
     underlying data and findings table were always correct. Fixed by
     switching to a 10-color qualitative palette (`SERIES_COLORS` in
     `makeReport.ts`, matplotlib's "tab10"). Colors still recycle past 10
     series — a reasonable line to draw for "our chosen language editions,"
     but worth knowing if a request ever compares more than that; see
     `roadmap.md`'s note on small multiples for that case.
  2. The findings table and legend both grow linearly with series count
     and were confirmed to still fit on one page at 8 series; this will
     eventually stop being true at some larger N, at which point see
     `roadmap.md`'s note on this exact tradeoff (default: tighten the
     writing / drop to summary rows, not add a second page).
  3. Query 3 also depends on `resolveTitles.ts` picking a sensible article
     for a colloquial phrase like "learning English" — a phrase like that
     is not itself a typical encyclopedic title, so the search may match a
     less-ideal page (e.g. "English as a second language" vs. "English
     language" vs. something narrower). This isn't a code bug to fix so
     much as an agent-judgment step already covered in `SKILL.md`'s "sanity
     check the resolution" instruction — worth the agent trying a more
     encyclopedic phrasing ("English language") if the literal user phrase
     resolves to something off-topic, and verifying either way before
     presenting results.

## First successful live end-to-end run — and what it found

`node dist/analyzeTopic.js --topic "chess" --languages en de --years 1
--output /tmp/chess.pdf` was run for real (network, live Wikimedia API,
real `@pdf-lib/fontkit`) and succeeded — no crash, a PDF was written. This
is the first confirmation that all three previously-separate fixes (the
Cyrillic font crash, the silent resolution-error path, the space-in-path
entry-point bug) work correctly together, not just individually.

It also surfaced one more real bug: `en · Chess` and `de · Schach` — two
completely independent series — both flagged an outlier in the *exact
same* month (the current, in-progress calendar month). Two unrelated
topics spiking in the same month by coincidence is far less likely than
the real explanation: `dateRange()` defaulted the end of the window to
*today*, so the current, still-accumulating month was included as if it
were a complete one, and its artificially-low partial total tripped the
outlier detector in both series at once. The same run also showed a
`--years 1` request returning 13 months of data instead of 12 — a
day-based `years * 365.25` subtraction drifts across month boundaries.

Both are now fixed in `analyzeTopic.ts`'s `dateRange()`: the default end
date (when `--end` isn't given) is the last day of the *previous* complete
month, and the start date is computed with exact calendar-month arithmetic
(`endMonth - totalMonths + 1`) instead of a day-count approximation.
Verified with a standalone script reproducing the exact "today = 2026-09-27"
case from the live run: `--years 1` now returns exactly 12 months ending
in August 2026, with September correctly excluded; `--years 2` returns
exactly 24. Pass `--end` explicitly if a request specifically wants the
current partial month included (e.g. tracking a very recent spike) — just
expect that month's bucket to look artificially low purely from being
incomplete, not from a real drop in interest.

## How the rest of this was tested

Same situation as above: built and tested in a sandboxed environment with
no outbound network access, so `wikimediaClient.ts`'s actual HTTP calls
were never executed live here either. What was verified:

- `npm run build` (`tsc -p tsconfig.json`) compiles clean.
- Everything downstream of a fetched series — `toMonthly`, `analyze`
  (log-linear fit, outlier detection, reliability flags), and
  `buildReport` — was run against synthetic-data test scenarios
  (`tests/offline.test.ts`, all passing): a series built
  to grow ~5%/month is correctly labeled `"growing"` with p < 0.05; a flat
  series is not; an injected 12x spike month is detected and materially
  changes the robust vs. raw growth rate; a 3-month series is correctly
  refused a trend claim; a low-volume series is correctly flagged as noisy.
- The generated PDF was rendered to an image and visually inspected (an
  early version had the legend overlapping the chart's top gridline — this
  is exactly the kind of layout bug that's invisible in code review and
  only shows up by actually looking at the output; see `makeReport.ts`'s
  `drawLegend`/`legendHeightFor` for the fix and don't reintroduce the
  coupling that caused it).

**Before relying on this for a real decision:** run it once against the
live API (`node dist/analyzeTopic.js --topic "chess" --languages en de
--years 1 --output /tmp/chess.pdf` should produce large, obviously-real
series for both languages), and run `tests/model-eval.mjs` (requires an
`OPENROUTER_API_KEY`; costs a fraction of a cent on a Haiku-class model) —
both need live network access this development environment didn't have,
confirmed by a keyless, zero-cost probe to openrouter.ai that returned a
plain 403 from the sandbox's own network allowlist before any real API
call was attempted.

`model-eval.mjs` checks two things separately: whether the model forms a
correct tool call from SKILL.md alone for each of the task brief's three
example queries (right topic, right languages, no hallucinated flags), and
— given a realistic *canned* result with a deliberately flat/insignificant
series and a deliberately low-volume one mixed in with a real growing one —
whether the model's final answer actually reflects `reliabilityFlags` and
`direction === "flat"`/`"insufficient_data"`, or just reports every number
it saw as "growing." The second check matters more than the first: a model
that calls the tool correctly but then ignores the caveats it got back
defeats the entire point of this skill.
