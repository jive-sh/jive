import * as e from "effect";
import type { EffectGen } from "effective-modules";
import { jiveServerFailure, type JiveServerError } from "@/modules/jive-server/interface";
import type { SignInFailed } from "@/modules/session/interface";

/**
 * The person's SSH key, which lives on `@jive-sh/server` with their account (Alex, 2026-11-01: "the ssh key is no
 * longer stored client side"). This machine keeps only its public key, so git and ssh can name it; every signature
 * is made by the server, given this machine's session.
 */

export interface AccountKey {
  /** The OpenSSH public key line, `ssh-ed25519 <base64> <handle>@jive.sh`. */
  readonly publicKey: string;
  /** Where the public key is kept, for `user.signingKey` and ssh's `IdentityFile`. */
  readonly publicKeyFile: string;
}

/** This machine has no Jive session, or the server has ended the one it had; `jive login` makes a new one. */
export class NoJiveSession extends e.Data.TaggedError("NoJiveSession")<{}> {}

/** The public key came back from the server but could not be written to `publicKeyFile`. */
export class AccountKeyNotSaved extends e.Data.TaggedError("AccountKeyNotSaved")<{
  readonly publicKeyFile: string;
  readonly detail: string;
}> {}

/** What went wrong with the account key, in words for a log or a person. */
export function accountKeyFailure(error: NoJiveSession | AccountKeyNotSaved | SignInFailed | JiveServerError): string {
  switch (error._tag) {
    case "NoJiveSession":
      return "this machine is not signed in to Jive";
    case "AccountKeyNotSaved":
      return `could not write ${error.publicKeyFile}: ${error.detail}`;
    case "SignInFailed":
      return error.reason;
    case "JiveServerUnreachable":
    case "JiveServerRefused":
      return jiveServerFailure(error);
  }
}

export interface IAccountKey {
  /** Signs in when needed, fetches the account key's public half from the server (`ssh:publicKey`), and keeps it on this machine. */
  ensure(): EffectGen<AccountKey, SignInFailed | JiveServerError | AccountKeyNotSaved>;
  /** The public key this machine kept, without reaching the server. */
  cached(): EffectGen<e.Option.Option<AccountKey>>;
  /**
   * Signs `data` with the account's key, using this machine's session and never signing in: the signing agent runs
   * with nobody watching, so a missing or ended session fails with `NoJiveSession` for the person to run `jive login`.
   */
  sign(data: Uint8Array): EffectGen<Uint8Array, NoJiveSession | JiveServerError>;
}
