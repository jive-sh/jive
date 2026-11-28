import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatformImpl } from "jive-abstract-library";
import { modules } from "@/modules";
import { DaemonClientImpl } from "@/modules/daemon-client/impl";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import { GitHubActionsIdentityImpl } from "@/modules/pipeline-identity/impl";
import { SessionImpl } from "@/modules/session/impl";
import { TerminalSignInPromptImpl } from "@/modules/session/sign-in-prompt";
import { ThroughDaemonSignInRouteImpl } from "@/modules/session/sign-in-route";

/**
 * A program signing in the way \`jive login\` does, for \`extension-daemon.test.ts\` to start as processes of their own:
 * it asks \`jive-daemon\` on the socket in \`$HOME/.jive\`, prints the page instead of opening it, and prints the session
 * token it ends with. It never reaches a server: signing in goes through the daemon only.
 */

const layer = e.pipe(
  SessionImpl.Layer,
  e.Layer.provideMerge(ThroughDaemonSignInRouteImpl.Layer),
  e.Layer.provideMerge(TerminalSignInPromptImpl.mockLayer({ *show(page) { yield* e.Effect.sync(() => console.log(`page ${page.loginUrl}`)); } })),
  e.Layer.provideMerge(DaemonClientImpl.Layer),
  e.Layer.provideMerge(GitHubActionsIdentityImpl.mockLayer({})),
  e.Layer.provideMerge(JiveServerImpl.mockLayer({})),
  e.Layer.provideMerge(OSPlatformImpl.Layer),
  e.Layer.provideMerge(BunServices.layer),
);

const session = await e.Effect.runPromise(e.pipe(
  e.Effect.gen(function* () { return yield* (yield* modules.session).signIn(); }),
  e.Effect.provide(layer),
));
console.log(`signed in ${session.sessionToken}`);
