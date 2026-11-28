import * as e from "effect";
import { FetchHttpClient } from "effect/http";
import { AbstractsImpl } from "./abstracts/impl";
import { AccountKeyImpl } from "./account-key/impl";
import { BrowserImpl } from "./browser/impl";
import { BunImpl } from "./bun/impl";
import { CommandEchoImpl } from "./command-echo/impl";
import { DaemonClientImpl } from "./daemon-client/impl";
import { ExtensionDaemonImpl } from "./extension-daemon/impl";
import { GitImpl } from "./git/impl";
import { GitHubImpl } from "./github/impl";
import { JiveServerImpl } from "./jive-server/impl";
import { FileMachineIdentityImpl } from "./machine-identity/impl";
import { MachineSignInImpl } from "./machine-sign-in/impl";
import { NpmCredentialPosterNotDecidedImpl } from "./npm-credential-poster/not-decided";
import { GitHubActionsIdentityImpl } from "./pipeline-identity/impl";
import { TerminalPromptImpl } from "./prompt/impl";
import { ProvisioningImpl } from "./provisioning/impl";
import { SessionImpl } from "./session/impl";
import { TerminalSignInPromptImpl } from "./session/sign-in-prompt";
import { InsideDaemonSignInRouteImpl, ThroughDaemonSignInRouteImpl } from "./session/sign-in-route";
import { SigningAgentImpl } from "./signing-agent/impl";
import { ToolStateImpl } from "./tool-state/impl";

/**
 * Every module jive owns, composed most-dependent first. What is left for the entrypoint to provide is the host: its
 * processes and facts (`OSPlatformImpl.Layer`) and its filesystem, paths, terminal and stdio (`BunServices.layer`), which a
 * test replaces to give the modules a home and an install directory of its own. The CLI and `jive-daemon` share one
 * session file. Only the daemon signs in, with the machine's key: the CLI asks it on its socket and prints the page.
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
  e.Layer.provideMerge(CommandEchoImpl.Layer),
  e.Layer.provideMerge(ToolStateImpl.Layer),
  e.Layer.provideMerge(ProvisioningImpl.Layer),
  e.Layer.provideMerge(TerminalPromptImpl.Layer),
  e.Layer.provideMerge(AccountKeyImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(ThroughDaemonSignInRouteImpl.Layer),
  e.Layer.provideMerge(DaemonClientImpl.Layer),
  e.Layer.provideMerge(TerminalSignInPromptImpl.Layer),
  e.Layer.provideMerge(BrowserImpl.Layer),
  e.Layer.provideMerge(serverLayer),
);

/** `jive-daemon`'s two sockets, the signing agent and the API socket, on one session, which only it signs in. */
export const DaemonLayer = e.pipe(
  SigningAgentImpl.Layer,
  e.Layer.provideMerge(ExtensionDaemonImpl.Layer),
  e.Layer.provideMerge(AccountKeyImpl.Layer),
  e.Layer.provideMerge(NpmCredentialPosterNotDecidedImpl.Layer),
  e.Layer.provideMerge(MachineSignInImpl.Layer),
  e.Layer.provideMerge(FileMachineIdentityImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(InsideDaemonSignInRouteImpl.Layer),
  e.Layer.provideMerge(serverLayer),
);
