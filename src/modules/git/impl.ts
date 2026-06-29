import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "node:path";
import * as process from "node:process";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "@/constants";
import { BadArgumentError, BadPreconditionsError, modules } from "@/modules";
import { type CurrentUser } from "@/modules/auth/interface";
import { RepoIdentifier } from "@/modules/tool-state/interface";
import { IN } from "../host-shell/interface";
import parseGitRemote from "git-url-parse";
import { Implementing, type GenEffect } from "@/temp-libs/effective-modules";
import type { IGit } from "./interface";

export class GitImpl extends Implementing(modules.git).Uses(modules.toolState, modules.hostShell, ep.FileSystem.FileSystem, modules.github) implements IGit {
  private readonly credentialHelperExecutablePath = path.join(path.dirname(process.execPath), GIT_CREDENTIAL_HELPER_NAME);
  private isDirectory(path: string) {
    return e.Effect.gen(this, function*() {
      const fs = this.getDependency(ep.FileSystem.FileSystem);
      const exists = yield* fs.exists(path);
      if (!exists) return false;
      return (yield* fs.stat(path)).type === "Directory";
    });
  }
  private configureGitRepo(repoId: RepoIdentifier, user: CurrentUser) {
    const { hostShell, github, toolState } = this.dependencies;
    return e.Effect.gen(this, function*() {
      const {relativePath: relative} = yield* toolState.repoPath(repoId);
      // TODO: ensure this path is an actual git repo.
      const gitConfig = e.Effect.fn(function*(config: Record<string, string>) {
        for (const [k, v] of Object.entries(config)) {
          yield* hostShell.run("git", `config --local ${hostShell.cliArgEncode(k)} ${hostShell.cliArgEncode(v)}`, IN.RelativeDirectory({relative})).inheritIO;
        }
      });
      const sshCommand = (identityFile: string): string =>
        `ssh -i ${hostShell.cliArgEncode(identityFile)} -o IdentitiesOnly=yes`;
      yield* gitConfig({
        "user.name": user.username,
        "user.email": user.email,
        "credential.helper": this.credentialHelperExecutablePath,
        "credential.useHttpPath": "true",
        "gpg.format": "ssh",
        "commit.gpgSign": "true",
        "core.sshCommand": sshCommand(user.sshKey.location), // sshCommand needs to point to privkey file
        "user.signingKey": user.sshKey.location // signingKey needs to point to pubkey file
      });
      const { ssh, https } = github.remoteUrls(repoId);
      yield* hostShell.run("git", `remote set-url origin ${https}`, IN.RelativeDirectory({relative})).inheritIO;
      yield* hostShell.run("git", `remote set-url --push origin ${ssh}`, IN.RelativeDirectory({relative})).inheritIO;
    });
  }
  *removeSubmodule(repoId: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    const {relativePath} = yield* this.dependencies.toolState.repoPath(repoId);
    yield* this.dependencies.hostShell.run("git", `submodule deinit -f ${relativePath}`, IN.WorkspaceRoot()).inheritIO;
    yield* this.dependencies.hostShell.run("git", `rm -f ${relativePath}`, IN.WorkspaceRoot()).inheritIO;
    yield* this.dependencies.hostShell.run("rm", `-rf .git/modules/${relativePath}`, IN.WorkspaceRoot(), {usingBunShell: true}).inheritIO;
    // TODO: it might be necessary to rm -rf the absolute folder.
    // TODO: I noticed that .git/modules can become out of sync with where the submodules actually are.
    //       There should ideally be a cleanup task run on configure, remove, and clone.
    // TODO: should we be committing the jive repo after the unload is done? Seems like maybe.
  }
  *localOrgs(): GenEffect<string[], BadPreconditionsError> {
    const { workspaceRoot } = yield* e.pipe(
      this.dependencies.toolState.assertInWorkspace,
      e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
    );
    const entries = yield* e.pipe(
      this.getDependency(ep.FileSystem.FileSystem).readDirectory(workspaceRoot),
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
        cause: `Failed to read workspace root ${workspaceRoot} as directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    const orgs: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.startsWith("@")) {
        continue;
      }
      const orgDir = path.resolve(workspaceRoot, entry)
      const entryIsDirectory = yield* e.pipe(
        orgDir,
        this.isDirectory,
        e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
          cause: `Failed to determine if potential org at ${orgDir} is a directory due to unexpected ${name}`,
          fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
        }))
      );
      if (entryIsDirectory) {
        orgs.push(entry.slice(1));
      }
    }
    return orgs;
  }
  *localRepos(org: string): GenEffect<RepoIdentifier[], BadArgumentError | BadPreconditionsError> {
    const dummyRepoId = new RepoIdentifier(org, "fake-repo");
    const orgDoesNotExistError = new BadArgumentError({
      argument: "org",
      reason: `Org ${dummyRepoId.orgName()} does not exist in this workspace`
    });
    const orgDir = yield* this.dependencies.toolState.orgPath(dummyRepoId);
    const orgIsDirectory = yield* e.pipe(
      orgDir.absolutePath,
      this.isDirectory,
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
        cause: `Failed to determine if potential org at ${orgDir} is a directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    if (!orgIsDirectory) {
      return yield* orgDoesNotExistError;
    }
    const repos = yield* e.pipe(
      this.getDependency(ep.FileSystem.FileSystem).readDirectory(orgDir.absolutePath
      ),
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
        cause: `Failed to read org at ${orgDir} due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    const repoIds: RepoIdentifier[] = 
      repos.sort()
      .map(repo => new RepoIdentifier(org, repo));
    return repoIds;
  }
  *configureWorkspace(user: CurrentUser): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    const { workspaceRoot } = yield* e.pipe(
      this.dependencies.toolState.assertInWorkspace,
      e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
    );
    const args = "config --get remote.origin.url";
    const { stderr, stdout } = yield* this.dependencies.hostShell.run("git", args, IN.WorkspaceRoot()).captureOutput;
    const [firstLine] = stdout.split("\n");
    if (!firstLine) {
      return yield* new BadPreconditionsError({
        cause: `Invalid root workspace at ${workspaceRoot}. \`git ${args}\` returned no results`,
        fix: `Configure the "origin" remote in this git repo`
      });
    }
    // It could be either an ssh or http remote.
    const {owner, name} = parseGitRemote(firstLine);
    if (!owner) {
      return yield* new BadPreconditionsError({
        cause: `Invalid org in origin remote for root workspace ${workspaceRoot}. Remote was ${firstLine}`,
        fix: `Reconfigure the "origin" remote in this repo to something valid`
      });
    }
    if (!name) {
      return yield* new BadPreconditionsError({
        cause: `Invalid repo name in origin remote for root workspace ${workspaceRoot}. Remote was ${firstLine}`,
        fix: `Reconfigure the "origin" remote in this repo to something valid`
      });
    }
    yield* this.configureGitRepo(new RepoIdentifier(owner, name), user);
  }
  *submoduleExists(repoId: RepoIdentifier): GenEffect<boolean, BadArgumentError | BadPreconditionsError> {
    yield* e.pipe(
      this.dependencies.toolState.assertInWorkspace,
      e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
    )
    // First verify org as dir
    const orgLocation = yield* this.dependencies.toolState.orgPath(repoId);
    const orgIsDir = yield* e.pipe(
      orgLocation.absolutePath,
      this.isDirectory,
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
        cause: `Failed to determine if potential org at ${orgLocation} is a directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    if (!orgIsDir) {
      return false;
    }
    // Next verify repo as dir
    const repoLocation = yield* this.dependencies.toolState.repoPath(repoId);
    const repoIsDir = yield* e.pipe(
      repoLocation.absolutePath,
      this.isDirectory,
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new BadPreconditionsError({
        cause: `Failed to determine if potential repo at ${repoLocation} is a directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    if (!repoIsDir) {
      return false;
    }
    // Finally verify that it is a submodule
    const submodules = yield* this.getSubmodules();
    return submodules.filter(RepoIdentifier.prototype.equals).length > 0;
  }
  *cloneAsSubmodule(repoId: RepoIdentifier, user: CurrentUser): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    const { toolState, github, hostShell } = this.dependencies;
    const { relativePath } = yield* toolState.repoPath(repoId);
    const { https } = github.remoteUrls(repoId)
    yield* hostShell.run("git", [
      `-c credential.helper=${this.credentialHelperExecutablePath}`,
      `-c credential.useHttpPath=true`,
      `submodule add ${hostShell.cliArgEncode(https)} ${hostShell.cliArgEncode(relativePath)}`,
    ].join(" "), IN.WorkspaceRoot()).inheritIO;
    yield* this.configureSubmodule(repoId, user);
  }
  *configureSubmodule(repoId: RepoIdentifier, user: CurrentUser): GenEffect<void, BadArgumentError | BadPreconditionsError> {
    const exists = yield* this.submoduleExists(repoId);
    if (!exists) {
      return yield* new BadArgumentError({
        argument: "repo",
        reason: `Repo ${repoId.packageName()} is not a submodule`
      });
    }
    yield* this.configureGitRepo(repoId, user);
  }
  *getSubmodules(): GenEffect<RepoIdentifier[], BadArgumentError | BadPreconditionsError> {
    const { toolState, hostShell } = this.dependencies;
    yield* e.pipe(
      toolState.assertInWorkspace,
      e.Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
    );
    const {stdout, stderr} = yield* hostShell.run("git", "submodule status", IN.WorkspaceRoot()).captureOutput;
    const submodules = yield* e.Effect.all(stdout
      .split("\n")
      .map(line => line.split(" "))
      .map(([commitSha, relPath]) => relPath ?? "")
      .filter(relPath => relPath.length)
      .map(RepoIdentifier.fromRelativePath));
    return submodules;
  }
}
