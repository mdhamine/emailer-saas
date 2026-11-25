import { env } from "./util";

export type Launch = {
  id: string;
  name: string;
  tagline: string;
  description: string | null;
  website: string;
  url: string;
  votesCount: number;
};

const QUERY = `
query($after: DateTime!, $before: DateTime!, $first: Int!) {
  posts(postedAfter: $after, postedBefore: $before, order: VOTES, first: $first) {
    edges { node { id name tagline description website url votesCount } }
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
      Authorization: `Bearer ${env("PH_TOKEN")}`,
    },
    body: JSON.stringify({ query: QUERY, variables: { ...window, first } }),
  });
  if (!res.ok) throw new Error(`Product Hunt API ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  if (json.errors) throw new Error(`Product Hunt API: ${JSON.stringify(json.errors)}`);
  return json.data.posts.edges.map((e: any) => e.node as Launch);
}
