import type { Launch } from "./producthunt";

export type Pitch = {
  fit_score: number;
  subject: string;
  body: string;
  reason: string;
};

export async function writePitch(
  launch: Launch,
  _siteText: string,
): Promise<Pitch> {
  return {
    fit_score: 10, // no AI scoring, so every launch with an email passes the filter
    subject: `${launch.name} inquiry`,
    body: `Heyy, are you the technical founder of ${launch.name} ?`,
    reason: "fixed template",
  };
}
