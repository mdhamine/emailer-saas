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
  return `\n\n--\n${env("SENDER_NAME")}\n\nNot interested? Just reply "unsubscribe" and I won't email you again.`;
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
