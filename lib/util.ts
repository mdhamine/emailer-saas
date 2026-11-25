export function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key}`);
  return v;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const blocklist = (process.env.BLOCKLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isBlocked(email: string): boolean {
  const e = email.toLowerCase();
  const domain = e.split("@")[1];
  return blocklist.some((b) => b === e || b === domain || b === `@${domain}`);
}
