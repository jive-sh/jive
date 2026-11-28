import * as e from "effect";
import type { EffectGen } from "effective-modules";

/**
 * This machine's identity to Jive: an ECDSA P-256 key `jive-daemon` creates the first time it is asked, and the name
 * the operating system gives the machine. The server knows a machine by the key's public half, so a sign-in request
 * names which machine it comes from and only that machine can claim the session it opens
 * (`@jive-sh/server`'s `model/machineKeys.ts`). The private half never leaves the machine.
 */

/** Where the private key is kept, as the server records it: only an owner-only file today. */
export type KeyStorage = "secure-enclave" | "tpm" | "file";

export interface MachineDescription {
  /** Base64url of the raw uncompressed P-256 point (65 bytes). */
  readonly publicKey: string;
  readonly keyStorage: KeyStorage;
  /** What the operating system calls the machine (`Alex's MacBook Pro`, a Linux host name). */
  readonly osName: string;
}

/** The key could not be created, read or used; `detail` says which and why. */
export class MachineKeyUnavailable extends e.Data.TaggedError("MachineKeyUnavailable")<{ readonly detail: string }> {}

export interface IMachineIdentity {
  /** The machine's key and name, creating the key the first time. */
  describe(): EffectGen<MachineDescription, MachineKeyUnavailable>;
  /** The key's ECDSA P-256 SHA-256 signature of `message` (UTF-8), raw `r‖s`, base64url. */
  sign(message: string): EffectGen<string, MachineKeyUnavailable>;
}
