/**
 * wikimediaClient.ts — thin, well-behaved HTTP client for the two Wikimedia
 * APIs this skill relies on. Uses Node 18+'s built-in `fetch`, so there is
 * no HTTP library dependency at all.
 *
 * 1. The Analytics REST API (AQS) — pageview counts.
 *    https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/...
 * 2. The Action API — resolves a free-text topic into the correct article
 *    title on each language edition (titles are independent wiki pages
 *    linked via Wikidata, not translations of a string).
 *
 * See references/api-notes.md for endpoint details, edge cases, and how
 * these request/response shapes were verified without live network access
 * during development.
 */

const CONTACT = process.env.WIKIMEDIA_CONTACT ?? "https://github.com/anthropics (skill: wikipedia-trend-insight)";
const USER_AGENT = `wikipedia-trend-insight-skill/1.0 (${CONTACT})`;

const PAGEVIEWS_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";

export class WikimediaError extends Error {}

async function get(url: string, maxRetries = 4): Promise<Response> {
  let delay = 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT, accept: "application/json" } });
      if (resp.status === 200 || resp.status === 404) return resp;
      if (resp.status === 429 || resp.status === 503) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new WikimediaError(`GET ${url} -> HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
      if (err instanceof WikimediaError) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new WikimediaError(`GET ${url} failed after ${maxRetries} retries: ${lastErr}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DayPoint {
  date: string; // YYYY-MM-DD
  views: number;
}

export interface FetchPageviewsOptions {
  granularity?: "daily" | "monthly";
  access?: "all-access" | "desktop" | "mobile-app" | "mobile-web";
  agent?: "user" | "all-agents" | "spider" | "automated";
}

/** Fetch a pageview time series for one article on one project.
 *
 * project:   e.g. "en.wikipedia.org", "pl.wikipedia.org"
 * article:   exact title as it exists on that project — use resolveTitles.ts
 *            to get this right across languages, never hand-translate it
 * start/end: "YYYYMMDD" — day-of-month required even for monthly
 *            granularity; the API buckets by month regardless
 *
 * Returns points sorted by date, WITHOUT gap-filling — that's
 * analyzeTrend.ts's job, done explicitly so the decision to treat a missing
 * month as zero is visible rather than implicit here.
 */
export async function fetchPageviews(
  project: string,
  article: string,
  start: string,
  end: string,
  options: FetchPageviewsOptions = {},
): Promise<DayPoint[]> {
  const granularity = options.granularity ?? "monthly";
  const access = options.access ?? "all-access";
  const agent = options.agent ?? "user"; // excludes bot/spider traffic by default

  const encodedArticle = encodeURIComponent(article.replace(/ /g, "_"));
  const url = [PAGEVIEWS_BASE, project, access, agent, encodedArticle, granularity, start, end].join("/");

  const resp = await get(url);
  if (resp.status === 404) return [];

  const body = (await resp.json()) as { items?: Array<{ timestamp: string; views: number }> };
  const points = (body.items ?? []).map((it) => ({
    date: `${it.timestamp.slice(0, 4)}-${it.timestamp.slice(4, 6)}-${it.timestamp.slice(6, 8)}`,
    views: it.views,
  }));
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

export interface ResolvedArticle {
  title: string;
  pageid: number | null;
  wikibaseItem: string | null;
}

/** Find the best-matching article for a free-text topic query on one wiki,
 * plus its Wikidata QID (the key used to find the SAME topic's title on
 * every other language edition — see resolveTitles.ts). */
export async function resolveArticleTitle(sourceProject: string, query: string): Promise<ResolvedArticle | null> {
  const actionApi = `https://${sourceProject}/w/api.php`;

  const searchUrl = `${actionApi}?${new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1",
    format: "json",
  })}`;
  const searchResp = await get(searchUrl);
  const searchBody = (await searchResp.json()) as { query?: { search?: Array<{ title: string }> } };
  const results = searchBody.query?.search ?? [];
  if (results.length === 0) return null;
  const title = results[0].title;

  const propsUrl = `${actionApi}?${new URLSearchParams({
    action: "query",
    titles: title,
    prop: "pageprops",
    ppprop: "wikibase_item",
    format: "json",
  })}`;
  const propsResp = await get(propsUrl);
  const propsBody = (await propsResp.json()) as {
    query?: { pages?: Record<string, { pageid?: number; pageprops?: { wikibase_item?: string } }> };
  };
  const pages = propsBody.query?.pages ?? {};
  const page = Object.values(pages)[0] ?? {};

  return {
    title,
    pageid: page.pageid ?? null,
    wikibaseItem: page.pageprops?.wikibase_item ?? null,
  };
}

/** Given a Wikidata QID, return {project: articleTitleOnThatProject}.
 * A project with no article in that language maps to null — callers should
 * surface that explicitly (it's often the finding, for a localization
 * question) rather than silently omitting the language. */
export async function sitelinksForItem(qid: string, projects: string[]): Promise<Record<string, string | null>> {
  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: "wbgetentities",
    ids: qid,
    props: "sitelinks",
    format: "json",
  })}`;
  const resp = await get(url);
  const body = (await resp.json()) as {
    entities?: Record<string, { sitelinks?: Record<string, { title: string }> }>;
  };
  const sitelinks = body.entities?.[qid]?.sitelinks ?? {};

  const out: Record<string, string | null> = {};
  for (const project of projects) {
    const lang = project.split(".")[0];
    const siteKey = `${lang}wiki`;
    out[project] = sitelinks[siteKey]?.title ?? null;
  }
  return out;
}
