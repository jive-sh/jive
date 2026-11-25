import * as e from "effect";
import type { EffectGen } from "effective-modules";

/** GitHub could not say whether the account exists: no answer, or one jive doesn't read (a rate limit). */
export class GitHubUnanswered extends e.Data.TaggedError("GitHubUnanswered")<{
  readonly reason: string;
}> {}

/** What jive asks GitHub itself, read-only and signed in as nobody. */
export interface IGitHub {
  /**
   * Whether GitHub has a user or an organization named `name`, the first word of `jive load <org> <repo>`. A name
   * holding anything but letters, digits and hyphens (`ozyman42/workspace`) is false without asking.
   */
  accountExists(name: string): EffectGen<boolean, GitHubUnanswered>;
}
