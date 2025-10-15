import { Command } from "@effect/cli";
import { Console } from "effect";

import { ArgBunCommands, ArgGitCommands, ArgOrgRepoName } from "@/arguments";
import { pending } from "@/common/utils";

const onGitCommand = Command
  .make("git", { commands: ArgGitCommands }, ({ commands }) => pending(`run git command(s): ${commands.join(" ")}`))
  .pipe(Command.withDescription("Run git commands within the repo context."));

const onRunCommand = Command
  .make("run", { commands: ArgBunCommands }, ({ commands }) => pending(`run bun command: ${commands.join(" ")}`))
  .pipe(Command.withDescription("Run bun commands within the repo context."));

const onExpoCommand = Command
  .make("expo", {}, () => pending("manage Expo plugin for repo."))
  .pipe(Command.withDescription("Interact with the Expo plugin."));

const onK8sCommand = Command
  .make("k8s", {}, () => pending("manage Kubernetes plugin for repo."))
  .pipe(Command.withDescription("Interact with the Kubernetes plugin."));

const onTunnelCommand = Command
  .make("tunnel", {}, () => pending("manage tunnel plugin for repo."))
  .pipe(Command.withDescription("Interact with tunneling support for the repo."));

export const onCommand = Command
  .make("on", { repo: ArgOrgRepoName }, ({ repo }) =>
    Console.log(`Select a subcommand to operate on repo "${repo}".`)
  )
  .pipe(Command.withDescription("Run commands scoped to a specific repo."))
  .pipe(Command.withSubcommands([
    onGitCommand,
    onRunCommand,
    onExpoCommand,
    onK8sCommand,
    onTunnelCommand
  ]));
