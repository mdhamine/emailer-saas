import { fetchLaunches, dayWindow, type Launch } from "../lib/producthunt";
import { findContact } from "../lib/finder";
import { findSite } from "../lib/site";
import { writePitch } from "../lib/pitch";
import { sendPitch, sendDigest, type Draft } from "../lib/mail";
import { isBlocked, sleep } from "../lib/util";

const MIN_FIT = Number(process.env.MIN_FIT ?? 7);
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN ?? 15);
const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function prepare(l: Launch): Promise<{ draft?: Draft; skip?: string }> {
  try {
    const site = await findSite(l);
    if (!site) return { skip: "no_site" };
    const contact = await findContact(site);
    if (!contact) return { skip: "no_email" };
    const email = contact.email.toLowerCase();
    if (isBlocked(email)) return { skip: "blocklisted" };
    const pitch = await writePitch(l, contact.text);
    if (pitch.fit_score < MIN_FIT) return { skip: "low_fit" };
    return { draft: { launch: l, to: email, source: contact.source, ...pitch } };
  } catch (e) {
    return { skip: `error: ${(e as Error).message}` };
  }
}

export async function GET(req: Request): Promise<Response> {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Optional ?date=YYYY-MM-DD to run a specific UTC day (handy for testing)
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  const window = dayWindow(date);
  const launches = await fetchLaunches(window, Number(process.env.LAUNCH_COUNT ?? 20));
  const results = await pool(launches, 2, prepare); // low concurrency keeps free-tier API limits happy

  const skips: Record<string, number> = {};
  const errors: string[] = [];
  const drafts: Draft[] = [];
  const seenEmails = new Set<string>(); // de-dupe within this run only
  for (const r of results) {
    if (r.draft) {
      if (seenEmails.has(r.draft.to)) skips.duplicate_in_run = (skips.duplicate_in_run ?? 0) + 1;
      else {
        seenEmails.add(r.draft.to);
        drafts.push(r.draft);
      }
    } else {
      const key = r.skip!.split(":")[0];
      skips[key] = (skips[key] ?? 0) + 1;
      if (key === "error") errors.push(r.skip!);
    }
  }

  drafts.sort((a, b) => b.fit_score - a.fit_score);
  const batch = drafts.slice(0, MAX_PER_RUN);

  let sent = 0;
  if (DRY_RUN) {
    const debug = JSON.stringify(
      {
        window,
        launches: launches.length,
        drafted: drafts.length,
        skips,
        errors: [...new Set(errors)].slice(0, 5),
        details: results.slice(0, 10).map((r, i) => ({
          name: launches[i].name,
          website: launches[i].website,
          result: r.draft ? `drafted:${r.draft.to}` : r.skip,
        })),
      },
      null,
      2,
    );
    await sendDigest(batch, debug);
  } else {
    for (const d of batch) {
      try {
        const id = await sendPitch(d);
        console.log(JSON.stringify({ event: "sent", to: d.to, launch: d.launch.name, subject: d.subject, id })); // Vercel logs only
        sent++;
        await sleep(2000); // gentle pacing
      } catch (e) {
        errors.push(`send ${d.to}: ${(e as Error).message}`);
      }
    }
  }

  return Response.json({
    window,
    dryRun: DRY_RUN,
    launches: launches.length,
    drafted: drafts.length,
    sent,
    skips,
    errors: [...new Set(errors)].slice(0, 5),
    // First 10 launches with what happened to each (visible only to whoever has CRON_SECRET)
    details: results.slice(0, 10).map((r, i) => ({
      name: launches[i].name,
      website: launches[i].website,
      result: r.draft ? `drafted:${r.draft.to}` : r.skip,
    })),
  });
}
