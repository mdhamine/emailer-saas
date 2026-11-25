# Product Hunt outreach agent (Vercel Cron + Resend) - stateless

Daily: fetch yesterday's PH launches -> scrape site for contact email -> Claude scores fit and drafts a pitch -> Resend sends (or emails you a dry-run digest). No database, no Redis, nothing sto
red.

## Deploy
1. `npm i`, `vercel link`
2. Add every variable from `.env.example` in Vercel > Settings > Environment Variables.
3. `vercel --prod`
4. Test (keep DRY_RUN=true):
   `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP.vercel.app/api/cron`
5. Check the digest in your inbox. When pitches look good, set `DRY_RUN=false` and redeploy.

## How it stays stateless
- **No duplicate launches:** each run covers one full UTC day (yesterday 00:00Z to today 00:00Z). Daily runs never overlap.
- **Unsubscribes:** emails tell people to reply "unsubscribe" (replies go to REPLY_TO). Add their email or domain to the `BLOCKLIST` env var and redeploy. Do this promptly (CAN-SPAM requires honoring requests within 10 business days).
- **Bounces/complaints:** check the Resend dashboard and add offenders to `BLOCKLIST`.
- **Send history:** only in Vercel function logs and the Resend dashboard.

## Caveats
- Don't trigger the endpoint manually in live mode for the same day twice: it will email the same people again.
- If the same founder launches again on a later day, they can be pitched again (nothing remembers). Use BLOCKLIST for people you've already contacted if that matters.
- If deploy rejects `maxDuration: 300`, lower it to 60 in vercel.json and set MAX_PER_RUN to ~8.
