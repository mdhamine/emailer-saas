import type { Launch } from "./producthunt";
import { env, sleep } from "./util";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Launch names that are already a domain (e.g. "distribution.dev") skip the lookup.
const DOMAIN_NAME = /^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/i;

// Checked against the HOSTNAME only (the old regex ran on the whole URL and also matched
// things like box.com / wix.com because "x.com" was unanchored).
const BAD_HOSTS =
  /(^|\.)(producthunt\.com|twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|youtu\.be|tiktok\.com|github\.com|apps\.apple\.com|play\.google\.com|medium\.com|wikipedia\.org|reddit\.com|crunchbase\.com|g2\.com|alternativeto\.net|techcrunch\.com|news\.ycombinator\.com)$/i;

function isBadHost(u: string): boolean {
  try {
    return BAD_HOSTS.test(new URL(u).hostname);
  } catch {
    return true;
  }
}

// One log line per failure so Vercel logs say exactly why a launch ended up as no_site.
function why(name: string, step: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event: "site", name, step, ...extra }));
}

// Confirm the URL loads and the page mentions the product. Used only for GUESSES (domain-name,
// search, Groq), never for Product Hunt's own redirect.
async function looksRight(url: string, name: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (!r.ok) return false;
    const html = (await r.text()).slice(0, 300_000).toLowerCase();
    const key = name.toLowerCase().replace(/\.[a-z]{2,}$/, "").split(/\s+/)[0];
    return key.length < 3 || html.includes(key);
  } catch {
    return false;
  }
}

// Follow Product Hunt's producthunt.com/r/... redirect by hand to reach the startup's real site.
async function resolvePhRedirect(url: string, name: string): Promise<string | null> {
  let current = url;
  for (let i = 0; i < 6; i++) {
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return null;
    }
    if (!/(^|\.)producthunt\.com$/i.test(host)) {
      return isBadHost(current) ? null : new URL(current).origin;
    }
    try {
      const r = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      const loc = r.headers.get("location");
      if (!loc) {
        // Typical cause: Product Hunt / Cloudflare blocks the request (403/503) from Vercel's IPs.
        why(name, "ph_redirect_no_location", { status: r.status, server: r.headers.get("server") });
        return null;
      }
      current = new URL(loc, current).toString();
    } catch (e) {
      why(name, "ph_redirect_error", { error: (e as Error).message });
      return null;
    }
  }
  why(name, "ph_redirect_too_many_hops");
  return null;
}

// Optional fallback: real web search (set BRAVE_API_KEY). Much better than asking an LLM to guess.
async function searchSite(l: Launch): Promise<string | null> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  try {
    const q = encodeURIComponent(`${l.name} ${l.tagline}`);
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=8`, {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      why(l.name, "search_http_error", { status: r.status });
      return null;
    }
    const data: any = await r.json();
    for (const res of data.web?.results ?? []) {
      if (!res?.url || isBadHost(res.url)) continue;
      const origin = new URL(res.url).origin;
      if (await looksRight(origin, l.name)) return origin;
    }
  } catch (e) {
    why(l.name, "search_error", { error: (e as Error).message });
  }
  return null;
}

// Groq (OpenAI-compatible API). Chat models tried in order; a 404 moves to the next one.
// Set GROQ_MODEL in the environment to override the first choice without a code change.
const MODEL_CANDIDATES = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

async function groq(prompt: string): Promise<string> {
  const candidates = [...new Set([process.env.GROQ_MODEL, ...MODEL_CANDIDATES].filter(Boolean) as string[])];
  let lastError = "no model tried";

  for (const model of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${env("GROQ_API_KEY").trim()}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 429 && attempt < 2) {
        await sleep(8000);
        continue;
      }
      if (res.status === 404) {
        lastError = `Groq 404 for model ${model}: ${(await res.text()).slice(0, 200)}`;
        break; // try next candidate model
      }
      if (!res.ok) throw new Error(`Groq ${res.status} (${model}): ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
  }
  throw new Error(`${lastError}. Tried: ${candidates.join(", ")}`);
}

async function guessWithGroq(l: Launch): Promise<string | null> {
  const prompt = `What is the official website (homepage) of this startup, which launched on Product Hunt?

Name: ${l.name}
Tagline: ${l.tagline}
Description: ${l.description ?? "(none)"}

The answer must be the product's own homepage, not Product Hunt, social media, app stores, GitHub, or news articles.
If you are not confident, answer null. Do not invent a URL.

Respond with ONLY this JSON and nothing else: {"url": "https://..." }  or  {"url": null}`;

  let text: string;
  try {
    text = await groq(prompt);
  } catch (e) {
    why(l.name, "groq_failed", { error: (e as Error).message });
    return null;
  }
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;

  let url: string | null = null;
  try {
    url = JSON.parse(m[0]).url;
  } catch {
    return null;
  }
  if (!url || !/^https?:\/\//i.test(url) || isBadHost(url)) return null;

  const origin = new URL(url).origin;
  return (await looksRight(origin, l.name)) ? origin : null;
}

export async function findSite(l: Launch): Promise<string | null> {
  const name = l.name.trim();

  // 1) Launch name is already a domain
  if (DOMAIN_NAME.test(name)) {
    const guess = `https://${name}`;
    if (await looksRight(guess, name)) return guess;
  }

  // 2) Product Hunt's own redirect is authoritative: trust it, no name check
  const resolved = await resolvePhRedirect(l.website, name);
  if (resolved) return resolved;

  // 3) Real web search (only if BRAVE_API_KEY is set)
  const searched = await searchSite(l);
  if (searched) return searched;

  // 4) Last resort: LLM guess from memory
  const guessed = await guessWithGroq(l);
  if (guessed) return guessed;

  why(name, "no_site", { website: l.website.slice(0, 80) });
  return null;
}
