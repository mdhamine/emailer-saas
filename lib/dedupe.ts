import fs from "node:fs";
import path from "node:path";
import { getDomain } from "tldts";

const FILE = process.env.EMAILED_FILE || "data/emailed.json";
const FREE = new Set([
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "hotmail.com",
  "icloud.com",
]);

type Store = {
  domains: Record<string, string>;
  addresses: Record<string, string>;
};

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { domains: {}, addresses: {} };
  }
}

function save(s: Store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

function parse(email: string) {
  const e = email.trim().toLowerCase();
  return { email: e, domain: getDomain(e.split("@").pop() ?? "") };
}

// True if we've already emailed this company (or this exact address for free-mail).
export function alreadyEmailed(email: string): boolean {
  const { email: e, domain } = parse(email);
  if (!domain) return true; // unparseable address: skip it
  const s = load();
  return FREE.has(domain) ? e in s.addresses : domain in s.domains;
}

// Call only after a send succeeds.
export function markEmailed(email: string) {
  const { email: e, domain } = parse(email);
  if (!domain) return;
  const s = load();
  const now = new Date().toISOString();
  if (FREE.has(domain)) s.addresses[e] = now;
  else s.domains[domain] = now;
  save(s);
}
