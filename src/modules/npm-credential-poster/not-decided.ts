import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import { CredentialRefused, type INpmCredentialPoster } from "./interface";

const REASON = "Jive can't accept npm credentials from the extension yet: which Jive service takes them is still being decided";

/** The extension daemon's poster until that decision: never posts, and says so before the extension touches npm. */
export class NpmCredentialPosterNotDecidedImpl extends implementing(modules.npmCredentialPoster) implements INpmCredentialPoster {
  *unavailableBecause(): EffectGen<e.Option.Option<string>> {
    return e.Option.some(REASON);
  }

  *postNpmCredential(): EffectGen<void, CredentialRefused> {
    return yield* new CredentialRefused({ reason: REASON });
  }
}
