import { interfaces } from "effective-modules";
import type { IAccountKey } from "./account-key/interface";
import type { IAuth } from "./auth/interface";
import type { IBrowser } from "./browser/interface";
import type { IBun } from "./bun/interface";
import type { IGit } from "./git/interface";
import type { IGitHub } from "./github/interface";
import type { IJiveServer } from "./jive-server/interface";
import type { INpm } from "./npm/interface";
import type { ISession, ISignInPrompt } from "./session/interface";
import type { ISigningAgent } from "./signing-agent/interface";
import type { ITemplates } from "./templates/interface";
import type { IToolState } from "./tool-state/interface";

export enum Module {
  accountKey = "accountKey",
  auth = "auth",
  browser = "browser",
  bun = "bun",
  git = "git",
  github = "github",
  jiveServer = "jiveServer",
  npm = "npm",
  session = "session",
  signInPrompt = "signInPrompt",
  signingAgent = "signingAgent",
  templates = "templates",
  toolState = "toolState",
}

export const modules = interfaces<Module, {
  [Module.accountKey]: IAccountKey;
  [Module.auth]: IAuth;
  [Module.browser]: IBrowser;
  [Module.bun]: IBun;
  [Module.git]: IGit;
  [Module.github]: IGitHub;
  [Module.jiveServer]: IJiveServer;
  [Module.npm]: INpm;
  [Module.session]: ISession;
  [Module.signInPrompt]: ISignInPrompt;
  [Module.signingAgent]: ISigningAgent;
  [Module.templates]: ITemplates;
  [Module.toolState]: IToolState;
}>(Module);
