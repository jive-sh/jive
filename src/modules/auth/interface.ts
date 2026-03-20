import * as e from "effect";
import type { GithubAccessToken } from "@/modules/github/interface";
import type { SshKey } from "@/modules/ssh/interface";
import type { BadArgumentError, BadPreconditionsError } from "..";

export interface CurrentUser {
  readonly username: string;
  readonly email: string;
  readonly githubAccessToken: GithubAccessToken;
  readonly sshKey: SshKey;
}

export class NotLoggedInError extends e.Data.TaggedError("NotLoggedInError")<{
  reason?: string;
}> {}

export class IAuth extends e.Context.Tag("IAuth")<IAuth, {
  readonly assertLoggedIn: e.Effect.Effect<CurrentUser, BadPreconditionsError>;
  readonly ensureLoggedIn: (opts: {chooseNewUser: boolean;}) => e.Effect.Effect<CurrentUser, BadArgumentError | BadPreconditionsError>;
}>() {}
