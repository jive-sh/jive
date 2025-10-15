import { Args } from "@effect/cli";

export const ArgOrgRepoName = Args.text({ name: "org/repo" });
export const ArgPluginName = Args.text({ name: "plugin" });
export const ArgTemplateName = Args.text({ name: "template" });
export const ArgEmail = Args.text({ name: "email" });
export const ArgGitCommands = Args.text({ name: "git commands" }).pipe(Args.atLeast(1));
export const ArgBunCommands = Args.text({ name: "bun commands" }).pipe(Args.atLeast(1));
