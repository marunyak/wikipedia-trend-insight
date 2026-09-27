---
name: wikipedia-trend-insight
description: Analyze Wikipedia page-view data to answer "is interest in this topic growing, in which languages, and can we trust that?" for B2C product decisions (new course/topic to add, which language to localize into next). Produces a chart and a one-page shareable PDF report grounded in the Wikimedia Pageviews API, with explicit statistical confidence and caveats — not just eyeballed line-chart growth. Use this skill whenever the user asks to compare, track, or validate interest in a topic across Wikipedia language editions, wants to know if a topic's popularity is rising before investing in it, or asks for a report/PDF on Wikipedia trends. Trigger even if they don't say "Wikipedia" explicitly but describe the underlying idea (e.g. "which language should we launch our course in next", "is there growing interest in X", "how do these topics compare across markets") — check whether Wikipedia page-view data would answer it before doing anything else.
---

# Wikipedia Trend Insight

**Don't just eyeball a line going up.** The whole point of this skill is
that "views went up" is not the same as "there's a statistically real,
non-spike trend on a big enough sample to act on." Every step below exists
to keep that distinction visible instead of collapsing it into one
confident number.

## Setup (once per environment)

```bash
npm install
npm run build      # compiles src/ -> dist/ (plain JS, only pdf-lib as a runtime dependency)
```

Everything the agent runs after that is plain compiled JS
(`node dist/analyzeTopic.js ...`) — no ts-node/tsx needed at run time, only
at dev time. This is deliberate: `npm run build` once, then `node` for every
actual invocation, is the most reproducible path in an unfamiliar sandbox or
CI, since it doesn't depend on a TS-execution tool being present at request
time.

## Core workflow

1. **Understand what's actually being asked.** Identify: the topic(s), the
   language edition(s) to compare, and the time window. Default to 2 years
   if unspecified — long enough to see a real trend past seasonal noise,
   short enough to stay relevant. A vague topic ("astronomy") is fine —
   `resolveTitles.ts` runs a real search, not a literal title lookup. Pass
   `--topic` in whatever language you have it in — resolution automatically
   tries English first, then falls back to the first `--languages` entry, so
   a Ukrainian-only request with the topic given in Ukrainian ("астрономія")
   resolves correctly without you needing to translate it yourself. Only
   pass `--anchor-language` explicitly if the topic phrase is in some third
   language that's neither English nor among the requested editions.

2. **Run the compiled orchestrator:**

   ```bash
   node dist/analyzeTopic.js \
     --topic "intermittent fasting" \
     --languages pl cs \
     --years 2 \
     --output /mnt/user-data/outputs/intermittent_fasting_pl_cs.pdf \
     --user-question "Порівняй зростання інтересу до інтервального голодування в польськомовній та чеськомовній Wikipedia за останні два роки."
   ```

   It prints a JSON summary to stdout — read this to write your answer, you
   generally don't need to open the PDF yourself. Present the PDF to the
   user as the shareable artifact.

3. **Sanity-check the resolution before trusting the numbers.** The JSON
   summary's `resolutionNotes` field lists any language where no article was
   found — read this out loud rather than silently dropping that language,
   since "no article exists yet in this language" is often itself the
   answer to a localization question. If `resolveTitles` may have matched
   the wrong article (ambiguous name, disambiguation page, same name
   different concept), verify via
   `https://<lang>.wikipedia.org/api/rest_v1/page/summary/<title>` and
   re-run with `--pairs lang:Exact_Title ...` to override instead of
   re-guessing.

4. **Turn the JSON into a plain-language answer**, not a data dump:
   - Lead with direction and trustworthiness, not the raw %. "Growing, and
     it's a real trend" reads very differently from "up 40%, but that's one
     viral month on a small sample" — say which one it is.
   - Always mention `reliabilityFlags` in your own words. Never quote
     `robustPctPerMonth` without noting when `direction` is `"flat"` or
     `"insufficient_data"` — those mean "no clear trend yet," not a hedged
     "growing."
   - When comparing languages/topics, use `rankedByRobustGrowth` — series
     with too little data already sort to the bottom regardless of their
     raw percentage.
   - Close with 1-2 concrete next steps proportional to what the data
     showed.

5. **Share the PDF.** It's already one page with the caveats section built
   in — don't restate the whole table in chat, just point to it.

## Changing assumptions on a follow-up

Users can and will refine or contradict their first request. These are all
plain CLI flags, not code changes:

- **"exclude mobile" / "desktop only" / "what about bot traffic too":**
  `--access desktop` (or `mobile-app`/`mobile-web`) and `--agent all-agents`
  (default is `user`, i.e. bots already excluded — only override this if the
  user specifically wants to include or isolate bot/crawler traffic).
- **Different time window:** `--years` or `--end` — already covered above.
- **Wrong article matched:** `--pairs lang:Exact_Title` — already covered
  above.
- Whatever the user changes, mention it plainly in your answer ("this run
  excludes mobile traffic, so..." ) — the JSON summary's `assumptions` field
  and the PDF's caveats section both surface non-default access/agent
  choices for exactly this reason; don't let a changed assumption go unsaid.

## Custom "which topic/language is worth pursuing" criteria

The default ranking (`rankedByRobustGrowth`) sorts by robust growth rate.
Users will often want a different definition of "promising" — e.g. "rank by
year-over-year change instead," "only count ones with at least 5,000
monthly views," "weigh growth and total audience size together." There's no
special flag for this and there doesn't need to be: every per-series object
in the JSON summary already carries `robustPctPerMonth`, `yoyChangePct`,
`meanMonthlyViews`, `nMonths`, and `reliabilityFlags` — re-sort or filter
that array yourself according to whatever criterion the user just described,
rather than re-running the CLI. Say explicitly which criterion you used.

## Handling follow-ups and related requests efficiently

- **"Now add Slovak too" / "last year instead of two":** re-run
  `analyzeTopic.js` with updated `--languages`/`--years`. Already-fetched
  (project, article, date-range) combinations are served from
  `.wikipedia_trend_cache/` automatically (`src/cache.ts`) — only genuinely
  new data triggers a fetch.
- **"Compare a different topic in the same languages":** new
  `--topic`/`--languages` call — the cache is keyed per (project, article),
  so nothing from the previous topic gets reused incorrectly.
- **Wrong-article correction:** use `--pairs lang:Exact_Title ...` for the
  corrected languages, keeping auto-resolution for the rest.
- **"How confident are you in that?" as a bare follow-up:** answer from the
  JSON summary already in the conversation (`reliabilityFlags`, `direction`,
  `nMonths`) without re-running anything.

## Reading the numbers correctly (don't skip this)

- `direction` is only `"growing"`/`"declining"` when the trend is
  statistically significant (p < 0.05) AND the effect size passes a small
  floor (>0.5%/month) — a `"flat"` result means the honest answer is "no
  real trend," not "a slight uptick."
- `robustPctPerMonth` (outlier months down-weighted) is the number to quote
  in your headline. The raw `slopePctPerMonth` is there so you can point out
  *when a single spike is doing all the work*.
- `yoyChangePct` only appears with 24+ months of history — prefer it over
  `robustPctPerMonth` for a non-technical stakeholder when both are
  available ("+35% year over year" is intuitive; "+2.6%/month" is not).
- Page views measure *curiosity*, not *demand* or *willingness to pay* — say
  this explicitly when the stakes of the decision seem to call for it.

## Extending this skill

See `references/roadmap.md` for how to grow this from "one topic, a handful
of languages, two years of monthly data" into heavier research. Read
`references/api-notes.md` before changing anything about how the Wikimedia
APIs are called or about the PDF rendering approach (pdf-lib vector drawing,
chosen specifically to avoid native canvas dependencies — see that file for
why before reaching for a charting library).
