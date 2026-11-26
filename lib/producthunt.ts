import { env } from "./util";
import { resolveWebsite } from "./finder";

export type Launch = {
  id: string;
  name: string;
  tagline: string;
  description: string | null;
  website: string;
  websiteResolved?: boolean;
  url: string;
  votesCount: number;
  productLinks?: { type: string; url: string }[];
};

const QUERY = `
query($after: DateTime!, $before: DateTime!, $first: Int!) {
  posts(postedAfter: $after, postedBefore: $before, order: VOTES, first: $first) {
    edges { node { id name tagline description website url votesCount productLinks { type url } } }
  }
}`;

// Stateless de-duplication: each run covers exactly ONE full UTC day
// (yesterday 00:00Z -> today 00:00Z), so consecutive daily runs never overlap
// or leave gaps, even if Vercel fires the cron a few minutes late.
export function dayWindow(dateStr?: string): { after: string; before: string } {
  const start = dateStr
    ? new Date(`${dateStr}T00:00:00Z`)
    : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const after = dateStr ? start : new Date(start.getTime() - 86_400_000);
  const before = dateStr ? new Date(start.getTime() + 86_400_000) : start;
  return { after: after.toISOString(), before: before.toISOString() };
}

export async function fetchLaunches(window: { after: string; before: string }, first = 40): Promise<Launch[]> {
  const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env("PH_TOKEN").trim()}`,
    },
    body: JSON.stringify({ query: QUERY, variables: { ...window, first } }),
  });

  const raw = await res.text();
  if (!res.ok) {
    console.log(JSON.stringify({ event: "ph_fetch", status: res.status, body: raw.slice(0, 300) }));
    throw new Error(`Product Hunt API ${res.status}: ${raw.slice(0, 300)}`);
  }

  const json: any = JSON.parse(raw);
  if (json.errors) {
    console.log(JSON.stringify({ event: "ph_fetch", errors: json.errors }));
    throw new Error(`Product Hunt API: ${JSON.stringify(json.errors)}`);
  }

  const isPH = (u: string) => /(^|\.)producthunt\.com$/i.test(new URL(u).hostname);
  const safeIsPH = (u: string) => {
    try {
      return isPH(u);
    } catch {
      return true;
    }
  };

  const launches: Launch[] = json.data.posts.edges.map((e: any) => {
    const l = e.node as Launch;
    // Prefer a direct WEBSITE link (not a producthunt.com redirect) if the API provides one
    const direct = (l.productLinks ?? []).find((p) => /^website$/i.test(p.type) && !safeIsPH(p.url));
    return direct ? { ...l, website: direct.url } : l;
  });

  // Resolve every producthunt.com/r/... redirect to the startup's real URL now, so the
  // rest of the app (finder, digest, debug endpoint) never sees a Product Hunt link.
  let idx = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (idx < launches.length) {
        const l = launches[idx++];
        const real = safeIsPH(l.website) ? await resolveWebsite(l.website) : l.website;
        if (real && !safeIsPH(real)) {
          l.website = real;
          l.websiteResolved = true;
        } else {
          l.websiteResolved = false;
        }
      }
    }),
  );
  console.log(
    JSON.stringify({
      event: "ph_fetch",
      window,
      count: launches.length,
      resolved: launches.filter((l) => l.websiteResolved).length,
      sample: launches.slice(0, 3).map((l) => ({ name: l.name, website: l.website, resolved: l.websiteResolved })),
    }),
  );
  return launches;
}
