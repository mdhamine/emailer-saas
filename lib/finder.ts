const PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/team", "/company", "/support", "/privacy", "/terms"];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|js|woff2?|ico)$/i;
const BAD_LOCAL =
  /^(no-?reply|do-?not-?reply|abuse|postmaster|privacy|legal|dmarc|unsubscribe|mailer-daemon|sentry|webmaster|security|dpo|gdpr)/i;
const GENERIC = /^(hello|hi|hey|contact|info|support|team|help|sales|admin|office|press|hola)$/i;
const BAD_DOMAINS = new Set(["example.com", "domain.com", "email.com", "sentry.io", "yourdomain.com", "wixpress.com"]);

export type Contact = { email: string; source: string; text: string };

function log(website: string, reason: string) {
  console.log(JSON.stringify({ event: "finder", website, reason }));
}

function stripTracking(u: string): string {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) {
      if (k.startsWith("utm_") || k === "ref") x.searchParams.delete(k);
    }
    return x.toString();
  } catch {
    return u;
  }
}

const PH_HOST = /(^|\.)producthunt\.com$/i;

function isPH(u: string): boolean {
  try {
    return PH_HOST.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

// Pull a non-Product-Hunt URL out of a redirect page body (meta refresh, JS redirect, or a plain link).
function urlFromBody(body: string, base: string): string | null {
  const patterns = [
    /http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)/i,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
    /<a[^>]+href=["'](https?:\/\/[^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (!m) continue;
    try {
      const abs = new URL(m[1].replace(/&amp;/g, "&"), base).toString();
      if (!isPH(abs)) return abs;
    } catch {
      /* try next pattern */
    }
  }
  return null;
}

// Product Hunt gives a producthunt.com/r/... redirect link. Follow the redirect by hand
// until we reach the startup's real site. Never returns a producthunt.com URL.
export async function resolveWebsite(url: string): Promise<string | null> {
  let current = url;
  for (let i = 0; i < 8; i++) {
    if (!isPH(current)) {
      try {
        new URL(current);
      } catch {
        return null;
      }
      return stripTracking(current);
    }
    try {
      const r = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: HEADERS });
      const loc = r.headers.get("location");
      if (loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      // No Location header: the redirect may be done in the HTML body instead.
      const body = (await r.text()).slice(0, 200_000);
      const fromBody = urlFromBody(body, current);
      if (!fromBody) return null;
      current = fromBody;
    } catch {
      return null;
    }
  }
  return null;
}

async function get(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: HEADERS,
    });
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || (type && !type.includes("html"))) return null;
    return { html: (await r.text()).slice(0, 1_500_000), finalUrl: r.url };
  } catch {
    return null;
  }
}

function decodeCf(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rootDomain(host: string): string {
  return host.replace(/^www\./, "").split(".").slice(-2).join(".");
}

function extract(html: string, found: Map<string, { mailto: boolean; page: string }>, page: string) {
  const add = (raw: string, mailto: boolean) => {
    const email = raw.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return;
    if (FILE_EXT.test(email)) return;
    const [local, domain] = email.split("@");
    if (BAD_LOCAL.test(local) || BAD_DOMAINS.has(domain)) return;
    const prev = found.get(email);
    found.set(email, { mailto: mailto || !!prev?.mailto, page: prev?.page ?? page });
  };
  for (const m of html.matchAll(/mailto:([^"'?\s<>]+)/gi)) {
    try {
      add(decodeURIComponent(m[1]), true);
    } catch {
      add(m[1], true);
    }
  }
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) add(decodeCf(m[1]), true);
  const deobf = html
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
  for (const m of deobf.matchAll(EMAIL_RE)) add(m[0], false);
}

export async function findContact(website: string): Promise<Contact | null> {
  const site = await resolveWebsite(website);
  if (!site || isPH(site)) {
    log(website, "could not resolve PH redirect to real site");
    return null;
  }

  let home = await get(site);
  if (!home) {
    // retry with/without www
    try {
      const u = new URL(site);
      u.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : "www." + u.hostname;
      home = await get(u.toString());
    } catch {
      /* ignore */
    }
  }
  if (!home) {
    log(site, "homepage fetch failed (blocked, timeout, or non-HTML)");
    return null;
  }

  const origin = new URL(home.finalUrl).origin;
  const siteRoot = rootDomain(new URL(home.finalUrl).hostname);

  const others = await Promise.all(PATHS.map((p) => get(origin + p)));
  const pages = [
    { path: "/", html: home.html },
    ...others.map((o, i) => (o ? { path: PATHS[i], html: o.html } : null)),
  ].filter(Boolean) as { path: string; html: string }[];

  const found = new Map<string, { mailto: boolean; page: string }>();
  for (const p of pages) extract(p.html, found, p.path);
  if (found.size === 0) {
    log(site, `no email found on ${pages.length} page(s)`);
    return null;
  }

  const scored = [...found.entries()].map(([email, meta]) => {
    const [local, domain] = email.split("@");
    const score = (rootDomain(domain) === siteRoot ? 10 : 0) + (GENERIC.test(local) ? 0 : 5) + (meta.mailto ? 3 : 0);
    return { email, meta, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Reject addresses on unrelated domains (e.g. a third-party widget's support address)
  if (best.score < 10 && !/gmail\.com|outlook\.com|proton\.me|protonmail\.com/.test(best.email)) {
    log(site, `only off-domain emails found (${best.email})`);
    return null;
  }

  return {
    email: best.email,
    source: `${best.meta.mailto ? "mailto" : "text"} on ${best.meta.page}`,
    text: visibleText(home.html).slice(0, 2500),
  };
}
