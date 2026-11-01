import * as e from "effect";
import type { EffectGen } from "effective-modules";

/**
 * Making sure a resource instance exists, through `@jive-sh/server`'s `provision`: the one way any caller, a deploy
 * hook included, provisions a resource. The caller names the kind (the abstract, e.g. `connector-package-registry`)
 * and the instance; the organization's one configured implementation does the work.
 */

/** Provisioning did not finish; nothing that depends on the instance should run. `reason` never holds a token. */
export class ProvisionFailed extends e.Data.TaggedError("ProvisionFailed")<{ readonly reason: string }> {}

export interface IProvisioning {
  /**
   * Waits while another caller provisions the same instance (as long as the server says, for up to 10 minutes), and
   * fails on a refusal or when the outside system needs a person, naming its page.
   */
  ensure(input: { readonly kind: string; readonly instance: unknown }): EffectGen<{ readonly instanceId: string }, ProvisionFailed>;
}
