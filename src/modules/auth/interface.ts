import { Data } from "effect";
import { type EffectGen } from "effective-modules";
import type { AccountKey } from "@/modules/account-key/interface";
import type { GithubAccessToken } from "@/modules/github/interface";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";

/** Who is working in a workspace: their GitHub account, and their Jive account's key, which signs their commits. */
export interface CurrentUser {
  readonly username: string;
  readonly email: string;
  readonly githubAccessToken: GithubAccessToken;
  readonly accountKey: AccountKey;
}

export class NotLoggedInError extends Data.TaggedError("NotLoggedInError")<{
  reason?: string;
}> {}

export interface IAuth {
  /** The workspace's signed-in user, failing when GitHub sign-in or the account key is missing. Reaches no server but GitHub. */
  assertLoggedIn(): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError>;
  /**
   * Signs in to GitHub when needed (always, with `chooseNewUser`), makes sure the Jive account's key exists and is on
   * this machine, and registers it on GitHub as both an authentication key and a signing key.
   */
  ensureLoggedIn(opts: {chooseNewUser: boolean;}): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError>;
}
