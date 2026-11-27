import { Resend } from "resend";
import type { Launch } from "./producthunt";
import { env } from "./util";
import { markEmailed } from "./dedupe";

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

export async function sendPitch(d: Draft): Promise<string> {
  const { data, error } = await resend.emails.send({
    from: `${env("SENDER_NAME")} <${env("FROM_EMAIL")}>`,
    to: d.to,
    replyTo: replyAddress(),
    subject: d.subject,
    text: d.body,
  });
  if (error) throw new Error(error.message);
  markEmailed(d.to); // record only after Resend accepts the email
  return data!.id;
}

// Run report: one email to yourself after every run (what was sent, what failed, why things were skipped).
export async function sendReport(subject: string, text: string): Promise<void> {
  const { error } = await resend.emails.send({
    from: `${env("SENDER_NAME")} <${env("FROM_EMAIL")}>`,
    to: env("OWNER_EMAIL"),
    subject,
    text,
  });
  if (error) throw new Error(error.message);
}
