import { type IAuth } from "./auth/interface";
export { AuthImpl } from "./auth/impl";
import { type IBun } from "./bun/interface";
export { BunImpl } from "./bun/impl";
import { type IDaemon } from "./daemon/interface";
export { DaemonImpl } from "./daemon/impl";
import { type IGit } from "./git/interface";
export { GitImpl } from "./git/impl";
import { type IGitHub } from "./github/interface";
export { GitHubImpl } from "./github/impl";
import { type IHostShell } from "./host-shell/interface";
export { HostShellImpl } from "./host-shell/impl";
import { type INpm } from "./npm/interface";
export { NpmImpl } from "./npm/impl";
import { type ISsh } from "./ssh/interface";
export { SshImpl } from "./ssh/impl";
import { type ITemplates } from "./templates/interface";
export { TemplatesImpl } from "./templates/impl";
import { type IToolState } from "./tool-state/interface";
export { ToolStateImpl } from "./tool-state/impl";
import { type IYubiKey } from "./yubikey/interface";
export { YubiKeyImpl } from "./yubikey/impl";

import { interfaces } from "effective-modules";

export enum Module {
  auth = "auth",
  bun = "bun",
  daemon = "daemon",
  git = "git",
  github = "github",
  hostShell = "hostShell",
  npm = "npm",
  ssh = "ssh",
  templates = "templates",
  toolState = "toolState",
  yubikey = "yubikey"
}

export const modules = interfaces<Module, {
  [Module.auth]: IAuth,
  [Module.bun]: IBun,
  [Module.daemon]: IDaemon,
  [Module.git]: IGit,
  [Module.github]: IGitHub,
  [Module.hostShell]: IHostShell,
  [Module.npm]: INpm,
  [Module.ssh]: ISsh,
  [Module.templates]: ITemplates,
  [Module.toolState]: IToolState,
  [Module.yubikey]: IYubiKey
}>(Module);

modules.auth;