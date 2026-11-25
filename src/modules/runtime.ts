import * as e from "effect";
import { FetchHttpClient } from "effect/http";
import { AbstractsImpl } from "./abstracts/impl";
import { AccountKeyImpl } from "./account-key/impl";
import { BrowserImpl } from "./browser/impl";
import { BunImpl } from "./bun/impl";
import { DaemonClientImpl } from "./daemon-client/impl";
import { ExtensionDaemonImpl } from "./extension-daemon/impl";
import { ExtensionSignInImpl } from "./extension-sign-in/impl";
import { GitImpl } from "./git/impl";
import { GitHubImpl } from "./github/impl";
import { JiveServerImpl } from "./jive-server/impl";
import { NpmCredentialPosterNotDecidedImpl } from "./npm-credential-poster/not-decided";
import { GitHubActionsIdentityImpl } from "./pipeline-identity/impl";
import { TerminalPromptImpl } from "./prompt/impl";
import { ProvisioningImpl } from "./provisioning/impl";
import { SessionImpl } from "./session/impl";
import { ExtensionSignInPromptImpl, TerminalSignInPromptImpl } from "./session/sign-in-prompt";
import { SigningAgentImpl } from "./signing-agent/impl";
import { ToolStateImpl } from "./tool-state/impl";

/**
 * Every module jive owns, composed most-dependent first. What is left for the entrypoint to provide is the host: its
 * processes and facts (`OSPlatformImpl.Layer`) and its filesystem, paths and terminal (`BunServices.layer`), which a
 * test replaces to give the modules a home and an install directory of its own. The CLI and `jive-daemon` share one
 * session file, and differ in how a sign-in reaches the person: the CLI prints it, and the daemon hands it to the Jive
 * extension, the only one that asks the daemon to sign in (the signing agent never does).
 */

/** What the session signs in through: the server, and in a CI/CD job the job's identity. */
const serverLayer = e.pipe(
  GitHubActionsIdentityImpl.Layer,
  e.Layer.provideMerge(JiveServerImpl.Layer),
  e.Layer.provideMerge(FetchHttpClient.layer),
);

export const ModulesLayer = e.pipe(
  AbstractsImpl.Layer,
  e.Layer.provideMerge(GitImpl.Layer),
  e.Layer.provideMerge(GitHubImpl.Layer),
  e.Layer.provideMerge(BunImpl.Layer),
  e.Layer.provideMerge(ToolStateImpl.Layer),
  e.Layer.provideMerge(ProvisioningImpl.Layer),
  e.Layer.provideMerge(TerminalPromptImpl.Layer),
  e.Layer.provideMerge(DaemonClientImpl.Layer),
  e.Layer.provideMerge(AccountKeyImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(TerminalSignInPromptImpl.Layer),
  e.Layer.provideMerge(BrowserImpl.Layer),
  e.Layer.provideMerge(serverLayer),
);

/** `jive-daemon`'s two sockets, the signing agent and the API socket, on one session. */
export const DaemonLayer = e.pipe(
  SigningAgentImpl.Layer,
  e.Layer.provideMerge(ExtensionDaemonImpl.Layer),
  e.Layer.provideMerge(AccountKeyImpl.Layer),
  e.Layer.provideMerge(NpmCredentialPosterNotDecidedImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(ExtensionSignInPromptImpl.Layer),
  e.Layer.provideMerge(ExtensionSignInImpl.Layer),
  e.Layer.provideMerge(serverLayer),
);
