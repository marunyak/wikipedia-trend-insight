/**
 * resolveTitles.ts — turn a topic the user mentions in plain language into
 * the *exact* article title on each Wikipedia language edition being
 * compared. See wikimediaClient.ts's doc comment and
 * references/api-notes.md for why this can't be skipped in favor of a
 * literal/translated title.
 */

import { resolveArticleTitle, sitelinksForItem } from "./wikimediaClient.js";
import { pathToFileURL } from "node:url";

export interface TopicResolution {
  query: string;
  matchedTitle?: string;
  wikibaseItem: string | null;
  titles: Record<string, string>; // project -> title
  missing: string[]; // language codes with no article for this topic
  error?: string;
}

/** Resolve `query` to per-language article titles.
 *
 * Tries the search on English Wikipedia first (broadest coverage), and — if
 * that finds nothing — automatically retries on the first requested target
 * language. This matters in practice: a real cheap-model test of this skill
 * (see tests/model-eval.mjs) showed an agent naturally passing the topic in
 * whatever language the user actually asked in — e.g. a Ukrainian-only
 * request ("--languages uk") with the topic itself given as "астрономія",
 * not "astronomy". Searching only against English Wikipedia (the old fixed
 * default) fails outright on a non-English phrase; searching only against
 * the target language fails just as badly the other way (an English phrase
 * against a Polish-only Wikipedia search). Trying both, in this order,
 * covers both directions without requiring the caller to know or guess
 * which language the topic phrase is in.
 *
 * anchorLanguage: force a specific first attempt instead of "en" — pass
 * this when you already know neither "en" nor the target languages match
 * the topic phrase's language (e.g. a French phrase being compared across
 * German/Spanish editions).
 */
export async function resolveTopic(
  query: string,
  languages: string[],
  anchorLanguage?: string,
): Promise<TopicResolution> {
  const projects = languages.map((lang) => `${lang}.wikipedia.org`);

  const attempts = anchorLanguage ? [anchorLanguage] : ["en"];
  if (!anchorLanguage && languages[0] && languages[0] !== "en") {
    attempts.push(languages[0]);
  }

  let found: Awaited<ReturnType<typeof resolveArticleTitle>> = null;
  let lastAnchorProject = "";
  for (const lang of attempts) {
    lastAnchorProject = `${lang}.wikipedia.org`;
    found = await resolveArticleTitle(lastAnchorProject, query);
    if (found && found.wikibaseItem) break;
  }

  if (!found || !found.wikibaseItem) {
    return {
      query,
      wikibaseItem: null,
      titles: {},
      missing: languages,
      error:
        `Could not find a Wikidata-linked article for '${query}' after trying ${attempts.join(", ")}. ` +
        `Try a more specific phrase, or pass an explicit anchorLanguage matching the phrase's own language.`,
    };
  }

  const qid = found.wikibaseItem;
  const links = await sitelinksForItem(qid, projects);

  const titles: Record<string, string> = {};
  for (const project of projects) {
    const t = links[project];
    if (t) titles[project] = t;
  }
  const missing = languages.filter((lang, i) => !links[projects[i]]);

  return {
    query,
    matchedTitle: found.title,
    wikibaseItem: qid,
    titles,
    missing,
  };
}

// --- CLI entry point ---
async function main() {
  const args = process.argv.slice(2);
  const query = args[0];
  const langIdx = args.indexOf("--languages");
  const anchorIdx = args.indexOf("--anchor-language");
  if (!query || langIdx === -1) {
    console.error('Usage: tsx resolveTitles.ts "<topic>" --languages pl cs en [--anchor-language en]');
    process.exit(1);
  }
  const languages: string[] = [];
  for (let i = langIdx + 1; i < args.length && !args[i].startsWith("--"); i++) {
    languages.push(args[i]);
  }
  const anchorLanguage = anchorIdx !== -1 ? args[anchorIdx + 1] : "en";

  const result = await resolveTopic(query, languages, anchorLanguage);
  console.log(JSON.stringify(result, null, 2));
}

// Only run as CLI when executed directly, not when imported. Compared via
// pathToFileURL (not a hand-built "file://" string) because a hand-built
// string doesn't percent-encode the path the same way import.meta.url
// does — on any path containing a space or other special character (e.g.
// "wikipedia-trend-insight-ts 2", which macOS creates automatically when
// you re-extract a zip into a folder that already exists), the comparison
// silently fails, this block never runs, and the script exits with no
// output and no error at all. This exact bug shipped in an earlier version
// of this skill — don't reintroduce the fragile comparison.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
