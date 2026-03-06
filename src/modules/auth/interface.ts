import * as e from "effect";

export interface ActiveGitIdentity {
  readonly userName: string;
  readonly userEmail: string;
  readonly readOnlyAuthPrivateKeyPath: string;
}

export class IAuth extends e.Context.Tag("IAuth")<IAuth, {
  readonly warnOnMissingOpenSshAtStartup: e.Effect.Effect<void>;
  readonly login: e.Effect.Effect<void>;
  readonly whoami: e.Effect.Effect<void>;
  readonly readOnlyToken: e.Effect.Effect<string>;
  readonly activeGitIdentity: e.Effect.Effect<e.Option.Option<ActiveGitIdentity>>;
  readonly ensureWriteTokenForActiveUser: e.Effect.Effect<e.Option.Option<string>>;
}>() {}
