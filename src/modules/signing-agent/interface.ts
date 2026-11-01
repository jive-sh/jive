import type { EffectGen } from "effective-modules";

/**
 * The SSH agent git and ssh talk to. It holds no key: it lists the account's public key, which this machine keeps,
 * and forwards each sign request's data to `@jive-sh/server`, which signs with the account's key.
 */
export interface ISigningAgent {
  /** Answers one agent message (without its length prefix). Anything it cannot do is answered with a failure. */
  answer(message: Uint8Array): EffectGen<Uint8Array>;
}
