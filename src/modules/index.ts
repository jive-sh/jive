import { interfaces } from "effective-modules";
import type { IAccountKey } from "./account-key/interface";
import type { IBrowser } from "./browser/interface";
import type { IBun } from "./bun/interface";
import type { IExtensionDaemon } from "./extension-daemon/interface";
import type { IExtensionSignIn } from "./extension-sign-in/interface";
import type { IGit } from "./git/interface";
import type { IJiveServer } from "./jive-server/interface";
import type { INpmCredentialPoster } from "./npm-credential-poster/interface";
import type { IPipelineIdentity } from "./pipeline-identity/interface";
import type { IProvisioning } from "./provisioning/interface";
import type { ISession, ISignInPrompt } from "./session/interface";
import type { ISigningAgent } from "./signing-agent/interface";
import type { IToolState } from "./tool-state/interface";

export enum Module {
  accountKey = "accountKey",
  browser = "browser",
  bun = "bun",
  extensionDaemon = "extensionDaemon",
  extensionSignIn = "extensionSignIn",
  git = "git",
  jiveServer = "jiveServer",
  npmCredentialPoster = "npmCredentialPoster",
  pipelineIdentity = "pipelineIdentity",
  provisioning = "provisioning",
  session = "session",
  signInPrompt = "signInPrompt",
  signingAgent = "signingAgent",
  toolState = "toolState",
}

export const modules = interfaces<Module, {
  [Module.accountKey]: IAccountKey;
  [Module.browser]: IBrowser;
  [Module.bun]: IBun;
  [Module.extensionDaemon]: IExtensionDaemon;
  [Module.extensionSignIn]: IExtensionSignIn;
  [Module.git]: IGit;
  [Module.jiveServer]: IJiveServer;
  [Module.npmCredentialPoster]: INpmCredentialPoster;
  [Module.pipelineIdentity]: IPipelineIdentity;
  [Module.provisioning]: IProvisioning;
  [Module.session]: ISession;
  [Module.signInPrompt]: ISignInPrompt;
  [Module.signingAgent]: ISigningAgent;
  [Module.toolState]: IToolState;
}>(Module);
