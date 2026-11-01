import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { OpenedSignInRequest } from "@/modules/jive-server/interface";
import type { ISignInPrompt } from "./interface";

/**
 * How a sign-in reaches the person: the jive.sh page opens, and they sign in with their passkey there (Alex,
 * 2026-11-01: "a human just signs in with the passkey"). The CLI also prints the page, in case it didn't open.
 */
export class TerminalSignInPromptImpl extends implementing(modules.signInPrompt).uses(modules.browser) implements ISignInPrompt {
  *show(request: OpenedSignInRequest): EffectGen<void> {
    yield* e.Effect.log(`Sign in to Jive with your passkey at ${request.loginUrl}`);
    yield* e.pipe(
      e.Effect.gen(() => this.dependencies.browser.open(request.loginUrl)),
      e.Effect.catch((reason) => e.Effect.logWarning(`${reason}; open the page yourself`)),
    );
  }
}

/** For the signing agent, which runs at login with no terminal: opens the page; the agent's log names it too. */
export class DesktopSignInPromptImpl extends implementing(modules.signInPrompt).uses(modules.browser) implements ISignInPrompt {
  *show(request: OpenedSignInRequest): EffectGen<void> {
    yield* e.Effect.log(`A sign request needs a Jive session: opening ${request.loginUrl}`);
    yield* e.pipe(
      e.Effect.gen(() => this.dependencies.browser.open(request.loginUrl)),
      e.Effect.catch((reason) => e.Effect.logWarning(reason)),
    );
  }
}
