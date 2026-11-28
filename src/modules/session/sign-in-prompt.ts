import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { ISignInPrompt, SignInPage } from "./interface";

/**
 * How a sign-in reaches the person: the jive.sh page opens, and they sign in with their passkey there (Alex,
 * 2026-11-01: "a human just signs in with the passkey"). The CLI also prints the page, in case it didn't open.
 */
export class TerminalSignInPromptImpl extends implementing(modules.signInPrompt).uses(modules.browser) implements ISignInPrompt {
  *show(page: SignInPage): EffectGen<void> {
    yield* e.Effect.log(`Sign in to Jive with your passkey at ${page.loginUrl}`);
    if (page.approvalDevices > 0) yield* e.Effect.log("Approve on your phone");
    yield* e.pipe(
      e.Effect.gen(() => this.dependencies.browser.open(page.loginUrl)),
      e.Effect.catch((reason) => e.Effect.logWarning(`${reason}; open the page yourself`)),
    );
  }
}
