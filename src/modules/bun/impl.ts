import { BadArgumentError, BadPreconditionsError, modules } from "@/modules";
import { IN } from "@/modules/host-shell/interface";
import { Implementing, type GenEffect } from "@/temp-libs/effective-modules";
import type { IBun } from "./interface";
import type { RepoIdentifier } from "../tool-state/repo-identifier";

export class BumImpl extends Implementing(modules.bun).Uses(modules.hostShell) implements IBun {
  *install(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    yield* this.dependencies.hostShell.run("bun", "install", IN.Repo({repo})).inheritIO;
  }
  *link(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    yield* this.dependencies.hostShell.run("bun", "link", IN.Repo({repo})).inheritIO;
  }
  *unlink(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    yield* this.dependencies.hostShell.run("bun", "unlink", IN.Repo({repo})).inheritIO;
  }
}
