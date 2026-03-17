import * as e from "effect";

export interface CurrentUser {
  readonly preferredEmail: e.Option.Option<string>;
  readonly userName: string;
  readonly userEmail: string;
  readonly readonlyToken: string;
}

export class NotLoggedInError extends e.Data.TaggedError("NotLoggedInError")<{}> {}

export class IAuth extends e.Context.Tag("IAuth")<IAuth, {
  readonly assertLoggedIn: e.Effect.Effect<CurrentUser, NotLoggedInError>;
  readonly ensureLoggedIn: (opts: {chooseNewUser: boolean;}) => e.Effect.Effect<CurrentUser>;
}>() {}
