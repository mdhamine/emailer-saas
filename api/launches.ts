import { fetchLaunches, dayWindow } from "../lib/producthunt";
import { findContact } from "../lib/finder";

// Read-only debug endpoint. Open in a browser:
//   /api/launches?key=YOUR_CRON_SECRET                 -> list fetched launches (+ any direct productLinks)
//   /api/launches?key=...&check=1                      -> also try to find an email for the first 10
//   /api/launches?key=...&probe=1                      -> show what the first launch's website link returns from Vercel
//   /api/launches?key=...&date=2026-11-24&n=20         -> specific UTC day, max 20 launches
// Delete this file when you no longer need it.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!process.env.CRON_SECRET || url.searchParams.get("key") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const window = dayWindow(url.searchParams.get("date") ?? undefined);
  const n = Math.min(Number(url.searchParams.get("n") ?? 40), 40);
  const check = url.searchParams.get("check") === "1";
  const probe = url.searchParams.get("probe") === "1";

  try {
    const launches = await fetchLaunches(window, n);
    const emails: Record<string, string | null> = {};

    if (check) {
      await Promise.all(
        launches.slice(0, 10).map(async (l) => {
          try {
            const c = await findContact(l.website);
            emails[l.id] = c ? `${c.email} (${c.source})` : null;
          } catch (e) {
            emails[l.id] = `error: ${(e as Error).message}`;
          }
        }),
      );
    }

    let probeResult: unknown = undefined;
    if (probe && launches[0]) {
      try {
        const r = await fetch(launches[0].website, {
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
          },
        });
        probeResult = {
          launch: launches[0].name,
          status: r.status,
          location: r.headers.get("location"),
          server: r.headers.get("server"),
          contentType: r.headers.get("content-type"),
          bodyStart: (await r.text()).slice(0, 200),
        };
      } catch (e) {
        probeResult = { error: (e as Error).message };
      }
    }

    return Response.json({
      window,
      count: launches.length,
      probe: probeResult,
      launches: launches.map((l) => ({
        name: l.name,
        votes: l.votesCount,
        website: l.website,
        resolved: l.websiteResolved,
        productLinks: l.productLinks,
        ...(check && l.id in emails ? { email: emails[l.id] } : {}),
      })),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
