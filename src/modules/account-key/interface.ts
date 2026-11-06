import * as e from "effect";
import type { EffectGen } from "effective-modules";

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

export class AccountKeyError extends e.Data.TaggedError("AccountKeyError")<{ readonly reason: string }> {}

export interface IAccountKey {
  /** Signs in when needed, fetches the account key's public half from the server (`ssh:publicKey`), and keeps it on this machine. */
  ensure(): EffectGen<AccountKey, AccountKeyError>;
  /** The public key this machine kept, without reaching the server. */
  cached(): EffectGen<e.Option.Option<AccountKey>>;
  /**
   * Signs `data` with the account's key, signing in first when there is no session. A session the server has ended
   * (unused for a day, or revoked) is dropped and signed in again once, as `ensure` does.
   */
  sign(data: Uint8Array): EffectGen<Uint8Array, AccountKeyError>;
}
