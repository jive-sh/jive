import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { modules } from "@/modules";
import type { OpenedSignInRequest } from "@/modules/jive-server/interface";
import type { ISignInPrompt } from "./interface";

/** For a command run in a terminal: prints the code and page, and opens the page. */
export class TerminalSignInPromptImpl extends implementing(modules.signInPrompt).uses(modules.browser) implements ISignInPrompt {
  *show(request: OpenedSignInRequest): EffectGen<void> {
    yield* e.Effect.log(`Sign in to Jive at ${request.loginUrl}`);
    yield* e.Effect.log(`Check the page shows the code ${request.confirmationCode}, then approve with your passkey.`);
    yield* e.pipe(
      e.Effect.gen(() => this.dependencies.browser.open(request.loginUrl)),
      e.Effect.catch((reason) => e.Effect.logWarning(`${reason}; open the page yourself`)),
    );
  }
}

/**
 * For the signing agent, which runs at login with no terminal: opens the page, and on macOS shows the code in a
 * notification so the person can compare it with the page. The agent's log has both either way.
 */
export class DesktopSignInPromptImpl extends implementing(modules.signInPrompt).uses(modules.browser, OSPlatform) implements ISignInPrompt {
  *show(request: OpenedSignInRequest): EffectGen<void> {
    const osPlatform = this.dependencies.OSPlatform;
    yield* e.Effect.log(`A sign request needs a Jive session: opening ${request.loginUrl} (code ${request.confirmationCode})`);
    yield* e.pipe(
      e.Effect.gen(() => this.dependencies.browser.open(request.loginUrl)),
      e.Effect.catch((reason) => e.Effect.logWarning(reason)),
    );
    const { os } = yield* osPlatform.getCurrentPlatform();
    if (os !== "darwin") return;
    const script = `display notification "Check jive.sh shows ${request.confirmationCode}, then approve with your passkey." with title "Jive sign-in for git signing"`;
    yield* e.pipe(
      e.Effect.gen(() => osPlatform.spawnProcess({ command: "osascript", args: ["-e", script] })),
      e.Effect.catch((reason) => e.Effect.logWarning(`could not show the sign-in notification: ${reason}`)),
    );
  }
}
