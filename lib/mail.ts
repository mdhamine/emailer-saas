import { Resend } from "resend";
import type { Launch } from "./producthunt";
import { env } from "./util";

const resend = new Resend(process.env.RESEND_API_KEY);

export type Draft = {
  launch: Launch;
  to: string;
  source: string;
  fit_score: number;
  subject: string;
  body: string;
  reason: string;
};

function replyAddress(): string {
  return process.env.REPLY_TO || env("FROM_EMAIL");
}

function footer(): string {
  return `\n\n--\n${env("SENDER_NAME")}\n${env("POSTAL_ADDRESS")}\n\nNot interested? Just reply "unsubscribe" and I won't email you again.`;
}

export async function sendPitch(d: Draft): Promise<string> {
  const { data, error } = await resend.emails.send({
    from: `${env("SENDER_NAME")} <${env("FROM_EMAIL")}>`,
    to: d.to,
    replyTo: replyAddress(),
    subject: d.subject,
    text: d.body + footer(),
    headers: {
      "List-Unsubscribe": `<mailto:${replyAddress()}?subject=unsubscribe>`,
    },
  });
  if (error) throw new Error(error.message);
  return data!.id;
}

// Dry-run mode: one digest to yourself showing what WOULD be sent (plus debug info).
export async function sendDigest(drafts: Draft[], debug = ""): Promise<void> {
  const text = drafts.length
    ? drafts
        .map(
          (d, i) =>
            `#${i + 1}  ${d.launch.name} (fit ${d.fit_score}/10)\nTo: ${d.to}  [found via ${d.source}]\nPH: ${d.launch.url}\nWhy: ${d.reason}\nSubject: ${d.subject}\n\n${d.body}`,
        )
        .join("\n\n==========\n\n")
    : "No drafts passed the filters today.";
  const { error } = await resend.emails.send({
    from: `${env("SENDER_NAME")} <${env("FROM_EMAIL")}>`,
    to: env("OWNER_EMAIL"),
    subject: `[DRY RUN] ${drafts.length} outreach drafts`,
    text: text + (debug ? `\n\n--- DEBUG ---\n${debug}` : ""),
  });
  if (error) throw new Error(error.message);
}
