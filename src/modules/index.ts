import { interfaces } from "effective-modules";
import type { IAbstracts } from "./abstracts/interface";
import type { IAccountKey } from "./account-key/interface";
import type { IBrowser } from "./browser/interface";
import type { IBun } from "./bun/interface";
import type { ICommandEcho } from "./command-echo/interface";
import type { IDaemonClient } from "./daemon-client/interface";
import type { IExtensionDaemon } from "./extension-daemon/interface";
import type { IGit } from "./git/interface";
import type { IGitHub } from "./github/interface";
import type { IJiveServer } from "./jive-server/interface";
import type { IMachineIdentity } from "./machine-identity/interface";
import type { IMachineSignIn } from "./machine-sign-in/interface";
import type { INpmCredentialPoster } from "./npm-credential-poster/interface";
import type { IPipelineIdentity } from "./pipeline-identity/interface";
import type { IPrompt } from "./prompt/interface";
import type { IProvisioning } from "./provisioning/interface";
import type { ISession, ISignInPrompt, ISignInRoute } from "./session/interface";
import type { ISigningAgent } from "./signing-agent/interface";
import type { IToolState } from "./tool-state/interface";

export enum Module {
  abstracts = "abstracts",
  accountKey = "accountKey",
  browser = "browser",
  bun = "bun",
  commandEcho = "commandEcho",
  daemonClient = "daemonClient",
  extensionDaemon = "extensionDaemon",
  git = "git",
  github = "github",
  jiveServer = "jiveServer",
  machineIdentity = "machineIdentity",
  machineSignIn = "machineSignIn",
  npmCredentialPoster = "npmCredentialPoster",
  pipelineIdentity = "pipelineIdentity",
  prompt = "prompt",
  provisioning = "provisioning",
  session = "session",
  signInPrompt = "signInPrompt",
  signInRoute = "signInRoute",
  signingAgent = "signingAgent",
  toolState = "toolState",
}

export const modules = interfaces<Module, {
  [Module.abstracts]: IAbstracts;
  [Module.accountKey]: IAccountKey;
  [Module.browser]: IBrowser;
  [Module.bun]: IBun;
  [Module.commandEcho]: ICommandEcho;
  [Module.daemonClient]: IDaemonClient;
  [Module.extensionDaemon]: IExtensionDaemon;
  [Module.git]: IGit;
  [Module.github]: IGitHub;
  [Module.jiveServer]: IJiveServer;
  [Module.machineIdentity]: IMachineIdentity;
  [Module.machineSignIn]: IMachineSignIn;
  [Module.npmCredentialPoster]: INpmCredentialPoster;
  [Module.pipelineIdentity]: IPipelineIdentity;
  [Module.prompt]: IPrompt;
  [Module.provisioning]: IProvisioning;
  [Module.session]: ISession;
  [Module.signInPrompt]: ISignInPrompt;
  [Module.signInRoute]: ISignInRoute;
  [Module.signingAgent]: ISigningAgent;
  [Module.toolState]: IToolState;
}>(Module);
