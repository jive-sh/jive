import { Data } from "effect";
import { type EffectGen } from "effective-modules";
import type { GithubAccessToken } from "@/modules/github/interface";
import type { SshKey } from "@/modules/ssh/interface";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";

export interface CurrentUser {
  readonly username: string;
  readonly email: string;
  readonly githubAccessToken: GithubAccessToken;
  readonly sshKey: SshKey;
}

export class NotLoggedInError extends Data.TaggedError("NotLoggedInError")<{
  reason?: string;
}> {}

export interface IAuth {
  assertLoggedIn(): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError>;
  ensureLoggedIn(opts: {chooseNewUser: boolean;}): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError>;
}
