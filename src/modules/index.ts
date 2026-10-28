import { interfaces } from "effective-modules";
import type { IAuth } from "./auth/interface";
import type { IBun } from "./bun/interface";
import type { IDaemon } from "./daemon/interface";
import type { IGit } from "./git/interface";
import type { IGitHub } from "./github/interface";
import type { INpm } from "./npm/interface";
import type { ISsh } from "./ssh/interface";
import type { ITemplates } from "./templates/interface";
import type { IToolState } from "./tool-state/interface";
import type { IYubiKey } from "./yubikey/interface";

export enum Module {
  auth = "auth",
  bun = "bun",
  daemon = "daemon",
  git = "git",
  github = "github",
  npm = "npm",
  ssh = "ssh",
  templates = "templates",
  toolState = "toolState",
  yubikey = "yubikey",
}

export const modules = interfaces<Module, {
  [Module.auth]: IAuth;
  [Module.bun]: IBun;
  [Module.daemon]: IDaemon;
  [Module.git]: IGit;
  [Module.github]: IGitHub;
  [Module.npm]: INpm;
  [Module.ssh]: ISsh;
  [Module.templates]: ITemplates;
  [Module.toolState]: IToolState;
  [Module.yubikey]: IYubiKey;
}>(Module);
