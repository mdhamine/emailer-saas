import type { Launch } from "./producthunt";
import { env, sleep } from "./util";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Launch names that are already a domain (e.g. "distribution.dev") skip the AI lookup.
const DOMAIN_NAME = /^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/i;
const NOT_A_HOMEPAGE = /(producthunt\.com|twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|github\.com|apps\.apple\.com|play\.google\.com|medium\.com|wikipedia\.org)/i;

// Confirm the URL loads and the page actually mentions the product (guards against a wrong guess).
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
async function resolvePhRedirect(url: string): Promise<string | null> {
  let current = url;
  for (let i = 0; i < 6; i++) {
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return null;
    }
    if (!/(^|\.)producthunt\.com$/i.test(host)) {
      return NOT_A_HOMEPAGE.test(current) ? null : new URL(current).origin;
    }
    try {
      const r = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      const loc = r.headers.get("location");
      if (!loc) return null;
      current = new URL(loc, current).toString();
    } catch {
      return null;
    }
  }
  return null;
}

// Groq (OpenAI-compatible API). Chat models tried in order; a 404 moves to the next one.
// llama-3.3-70b-versatile and llama-3.1-8b-instant were shut down on 2026-08-16.
// Set GROQ_MODEL in the environment to override the first choice without a redeploy of code.
// Free-tier limits are small, so retry politely on 429.
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

export async function findSite(l: Launch): Promise<string | null> {
  const name = l.name.trim();

  // 1) Launch name is already a domain
  if (DOMAIN_NAME.test(name)) {
    const guess = `https://${name}`;
    if (await looksRight(guess, name)) return guess;
  }

  // 2) Follow Product Hunt's redirect to the real site (no AI needed)
  const resolved = await resolvePhRedirect(l.website);
  if (resolved && (await looksRight(resolved, name))) return resolved;

  // 3) Last resort: ask Groq (no web search, so this is a best guess from memory)
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
    // Groq is only a best-guess fallback; don't fail the whole launch if it is down or a model is retired.
    console.error("groq fallback failed:", (e as Error).message);
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
  if (!url || !/^https?:\/\//i.test(url) || NOT_A_HOMEPAGE.test(url)) return null;

  const origin = new URL(url).origin;
  return (await looksRight(origin, name)) ? origin : null;
}
