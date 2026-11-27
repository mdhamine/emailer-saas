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

// Groq (OpenAI-compatible API). The default model has built-in web search.
// Free-tier limits are small, so retry politely on 429.
async function groq(prompt: string): Promise<string> {
  const model = process.env.GROQ_MODEL ?? "groq/compound";
  const url = "https://api.groq.com/openai/v1/chat/completions";

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
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
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
  throw new Error("Groq rate limited (429)");
}

export async function findSite(l: Launch): Promise<string | null> {
  const name = l.name.trim();

  if (DOMAIN_NAME.test(name)) {
    const guess = `https://${name}`;
    if (await looksRight(guess, name)) return guess;
  }

  const prompt = `Find the official website (homepage) of this startup, which launched on Product Hunt.

Name: ${l.name}
Tagline: ${l.tagline}
Description: ${l.description ?? "(none)"}

Search the web. The answer must be the product's own homepage, not Product Hunt, social media, app stores, GitHub, or news articles.
If you are not confident, answer null.

Respond with ONLY this JSON and nothing else: {"url": "https://..." }  or  {"url": null}`;

  const text = await groq(prompt);
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
