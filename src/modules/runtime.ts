import * as e from "effect";
import { FetchHttpClient } from "effect/http";
import { AccountKeyImpl } from "./account-key/impl";
import { BrowserImpl } from "./browser/impl";
import { BunImpl } from "./bun/impl";
import { ExtensionDaemonImpl } from "./extension-daemon/impl";
import { ExtensionSignInImpl } from "./extension-sign-in/impl";
import { GitImpl } from "./git/impl";
import { JiveServerImpl } from "./jive-server/impl";
import { NpmCredentialPosterNotDecidedImpl } from "./npm-credential-poster/not-decided";
import { GitHubActionsIdentityImpl } from "./pipeline-identity/impl";
import { ProvisioningImpl } from "./provisioning/impl";
import { SessionImpl } from "./session/impl";
import { DesktopSignInPromptImpl, ExtensionSignInPromptImpl, TerminalSignInPromptImpl } from "./session/sign-in-prompt";
import { SigningAgentImpl } from "./signing-agent/impl";
import { ToolStateImpl } from "./tool-state/impl";

/**
 * Every module jive owns, composed most-dependent first. What is left for the entrypoint to provide is the host: its
 * processes and facts (`OSPlatformImpl.Layer`) and its filesystem, paths and terminal (`BunServices.layer`), which a
 * test replaces to give the modules a home and an install directory of its own. The CLI, the signing agent and the
 * extension daemon share one session and differ in how a sign-in reaches the person: the CLI prints it, the agent,
 * with no terminal, notifies, and the extension daemon hands it to the extension that asked for it.
 */

/** What the session signs in through: the server, and in a CI/CD job the job's identity. */
const serverLayer = e.pipe(
  GitHubActionsIdentityImpl.Layer,
  e.Layer.provideMerge(JiveServerImpl.Layer),
  e.Layer.provideMerge(FetchHttpClient.layer),
);

const accountLayer = (signInPrompt: typeof TerminalSignInPromptImpl.Layer | typeof DesktopSignInPromptImpl.Layer) => e.pipe(
  AccountKeyImpl.Layer,
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(signInPrompt),
  e.Layer.provideMerge(BrowserImpl.Layer),
  e.Layer.provideMerge(serverLayer),
);

export const ModulesLayer = e.pipe(
  BunImpl.Layer,
  e.Layer.provideMerge(GitImpl.Layer),
  e.Layer.provideMerge(ToolStateImpl.Layer),
  e.Layer.provideMerge(ProvisioningImpl.Layer),
  e.Layer.provideMerge(accountLayer(TerminalSignInPromptImpl.Layer)),
);

export const SigningAgentLayer = e.pipe(
  SigningAgentImpl.Layer,
  e.Layer.provideMerge(accountLayer(DesktopSignInPromptImpl.Layer)),
);

export const ExtensionDaemonLayer = e.pipe(
  ExtensionDaemonImpl.Layer,
  e.Layer.provideMerge(NpmCredentialPosterNotDecidedImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(ExtensionSignInPromptImpl.Layer),
  e.Layer.provideMerge(ExtensionSignInImpl.Layer),
  e.Layer.provideMerge(serverLayer),
);
