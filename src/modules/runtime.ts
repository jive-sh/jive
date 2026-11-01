import * as e from "effect";
import { FetchHttpClient } from "effect/http";
import { OSPlatformImpl } from "jive-abstract-library";
import { AccountKeyImpl } from "./account-key/impl";
import { AuthImpl } from "./auth/impl";
import { BrowserImpl } from "./browser/impl";
import { BunImpl } from "./bun/impl";
import { GitImpl } from "./git/impl";
import { GithubImpl } from "./github/impl";
import { JiveServerImpl } from "./jive-server/impl";
import { NpmImpl } from "./npm/impl";
import { SessionImpl } from "./session/impl";
import { DesktopSignInPromptImpl, TerminalSignInPromptImpl } from "./session/sign-in-prompt";
import { SigningAgentImpl } from "./signing-agent/impl";
import { TemplatesImpl } from "./templates/impl";
import { ToolStateImpl } from "./tool-state/impl";

/**
 * Every module jive owns, composed most-dependent first. What is left for the entrypoint to provide is the host's own
 * services (the filesystem, paths and the terminal), which `BunServices.layer` gives. The CLI and the signing agent
 * differ only in how a sign-in reaches the person: the CLI prints it, the agent, with no terminal, notifies.
 */

const accountLayer = (signInPrompt: typeof TerminalSignInPromptImpl.Layer | typeof DesktopSignInPromptImpl.Layer) => e.pipe(
  AccountKeyImpl.Layer,
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(signInPrompt),
  e.Layer.provideMerge(BrowserImpl.Layer),
  e.Layer.provideMerge(JiveServerImpl.Layer),
  e.Layer.provideMerge(OSPlatformImpl.Layer),
  e.Layer.provideMerge(FetchHttpClient.layer),
);

export const ModulesLayer = e.pipe(
  AuthImpl.Layer,
  e.Layer.provideMerge(BunImpl.Layer),
  e.Layer.provideMerge(GitImpl.Layer),
  e.Layer.provideMerge(GithubImpl.Layer),
  e.Layer.provideMerge(ToolStateImpl.Layer),
  e.Layer.provideMerge(NpmImpl.Layer),
  e.Layer.provideMerge(TemplatesImpl.Layer),
  e.Layer.provideMerge(accountLayer(TerminalSignInPromptImpl.Layer)),
);

export const SigningAgentLayer = e.pipe(
  SigningAgentImpl.Layer,
  e.Layer.provideMerge(accountLayer(DesktopSignInPromptImpl.Layer)),
);
