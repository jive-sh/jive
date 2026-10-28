import * as e from "effect";
import * as path from "node:path";
import * as process from "node:process";
import parseGitRemote from "git-url-parse";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "@/constants";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import type { CurrentUser } from "@/modules/auth/interface";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import type { IGit } from "./interface";

/** One line of `git submodule status`: a state character (space, -, + or U), the commit, then the path. */
const SUBMODULE_STATUS_LINE = /^[ +\-U]?([0-9a-f]+) (\S+)/;

export class GitImpl extends implementing(modules.git).uses(modules.toolState, modules.github, OSPlatform, e.FileSystem.FileSystem) implements IGit {
  private readonly credentialHelperExecutablePath = path.join(path.dirname(process.execPath), GIT_CREDENTIAL_HELPER_NAME);

  *removeSubmodule(repoId: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const { relativePath } = yield* this.dependencies.toolState.repoPath(repoId);
    const workspaceRoot = yield* this.workspaceRoot();
    yield* this.git(["submodule", "deinit", "-f", relativePath], workspaceRoot);
    yield* this.git(["rm", "-f", relativePath], workspaceRoot);
    yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).remove(path.join(workspaceRoot, ".git", "modules", relativePath), { recursive: true, force: true }),
      e.Effect.catchTag("PlatformError", ({ message }) => e.Effect.fail(BadPreconditionsError.withoutFix(
        `Failed to remove the git directory of submodule ${relativePath}`, message,
      ))),
    );
    // TODO: I noticed that .git/modules can become out of sync with where the submodules actually are.
    //       There should ideally be a cleanup task run on configure, remove, and clone.
    // TODO: should we be committing the jive repo after the unload is done? Seems like maybe.
  }

  *localOrgs(): EffectGen<string[], BadPreconditionsError> {
    const workspaceRoot = yield* this.workspaceRoot();
    const entries = yield* this.readDirectory(workspaceRoot);
    const orgs: string[] = [];
    for (const entry of entries.sort()) {
      if (entry.startsWith("@") && (yield* this.isDirectory(path.resolve(workspaceRoot, entry)))) {
        orgs.push(entry.slice(1));
      }
    }
    return orgs;
  }

  *localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError> {
    const orgLocation = yield* this.dependencies.toolState.orgPath(new RepoIdentifier(org, ""));
    if (!(yield* this.isDirectory(orgLocation.absolutePath))) {
      return yield* new BadArgumentError({
        argument: "org",
        reason: `Org ${orgLocation.relativePath} does not exist in this workspace`,
      });
    }
    const repos = yield* this.readDirectory(orgLocation.absolutePath);
    return repos.sort().map(repo => new RepoIdentifier(org, repo));
  }

  *configureWorkspace(user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const workspaceRoot = yield* this.workspaceRoot();
    const args = ["config", "--get", "remote.origin.url"];
    const { stdout } = yield* this.git(args, workspaceRoot, "capture");
    const [firstLine] = stdout.split("\n");
    if (!firstLine) {
      return yield* new BadPreconditionsError({
        cause: `Invalid root workspace at ${workspaceRoot}. \`git ${args.join(" ")}\` returned no results`,
        fix: `Configure the "origin" remote in this git repo`
      });
    }
    // It could be either an ssh or http remote.
    const { owner, name } = parseGitRemote(firstLine);
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

  *submoduleExists(repoId: RepoIdentifier): EffectGen<boolean, BadArgumentError | BadPreconditionsError> {
    const orgLocation = yield* this.dependencies.toolState.orgPath(repoId);
    if (!(yield* this.isDirectory(orgLocation.absolutePath))) {
      return false;
    }
    const repoLocation = yield* this.dependencies.toolState.repoPath(repoId);
    if (!(yield* this.isDirectory(repoLocation.absolutePath))) {
      return false;
    }
    const submodules = yield* this.getSubmodules();
    return submodules.some(submodule => submodule.equals(repoId));
  }

  *cloneAsSubmodule(repoId: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const { relativePath } = yield* this.dependencies.toolState.repoPath(repoId);
    const { https } = this.dependencies.github.remoteUrls(repoId);
    yield* this.git([
      "-c", `credential.helper=${this.credentialHelperExecutablePath}`,
      "-c", "credential.useHttpPath=true",
      "submodule", "add", https, relativePath,
    ], yield* this.workspaceRoot());
    yield* this.configureSubmodule(repoId, user);
  }

  *configureSubmodule(repoId: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const exists = yield* this.submoduleExists(repoId);
    if (!exists) {
      return yield* new BadArgumentError({
        argument: "repo",
        reason: `Repo ${repoId.packageName()} is not a submodule`
      });
    }
    yield* this.configureGitRepo(repoId, user);
  }

  *getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError> {
    const { stdout } = yield* this.git(["submodule", "status"], yield* this.workspaceRoot(), "capture");
    const relativePaths = stdout
      .split("\n")
      .map(line => SUBMODULE_STATUS_LINE.exec(line)?.[2])
      .filter((relativePath): relativePath is string => relativePath !== undefined);
    return yield* e.Effect.all(relativePaths.map(RepoIdentifier.fromRelativePath));
  }

  private *configureGitRepo(repoId: RepoIdentifier, user: CurrentUser): EffectGen<void, BadPreconditionsError> {
    const { absolutePath } = yield* this.dependencies.toolState.repoPath(repoId);
    // TODO: ensure this path is an actual git repo.
    const config: Record<string, string> = {
      "user.name": user.username,
      "user.email": user.email,
      "credential.helper": this.credentialHelperExecutablePath,
      "credential.useHttpPath": "true",
      "gpg.format": "ssh",
      "commit.gpgSign": "true",
      "core.sshCommand": `ssh -i ${JSON.stringify(user.sshKey.location)} -o IdentitiesOnly=yes`, // sshCommand needs to point to privkey file
      "user.signingKey": user.sshKey.location, // signingKey needs to point to pubkey file
    };
    for (const [key, value] of Object.entries(config)) {
      yield* this.git(["config", "--local", key, value], absolutePath);
    }
    const { ssh, https } = this.dependencies.github.remoteUrls(repoId);
    yield* this.git(["remote", "set-url", "origin", https], absolutePath);
    yield* this.git(["remote", "set-url", "--push", "origin", ssh], absolutePath);
  }

  /** Runs git in `cwd`, failing when it exits nonzero; "capture" returns its output instead of showing it. */
  private *git(args: ReadonlyArray<string>, cwd: string, output: "inherit" | "capture" = "inherit"): EffectGen<{ stdout: string }, BadPreconditionsError> {
    const commandLine = `git ${args.join(" ")}`;
    if (output === "inherit") {
      yield* e.Effect.log(`Running ${commandLine}`);
    }
    const stdio = output === "inherit" ? "inherit" : "pipe";
    const result = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.OSPlatform.spawnProcess({ command: "git", args, cwd, stdout: stdio, stderr: stdio })),
      e.Effect.mapError(message => BadPreconditionsError.withoutFix(`Failed to run ${commandLine}`, message)),
    );
    if (result.exitCode !== 0) {
      return yield* new BadPreconditionsError({
        cause: `${commandLine} exited with code ${result.exitCode}${result.stderr ? `:\n${result.stderr.trim()}` : ""}`,
        fix: `Fix what git reported, then run the ${TOOL_NAME} command again`,
      });
    }
    return { stdout: result.stdout };
  }

  private *workspaceRoot(): EffectGen<string, BadPreconditionsError> {
    const { workspaceRoot } = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.toolState.assertInWorkspace()),
      e.Effect.mapError(BadPreconditionsError.fromNotInWorkspaceError),
    );
    return workspaceRoot;
  }

  private *isDirectory(targetPath: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).stat(targetPath),
      e.Effect.map(info => info.type === "Directory"),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
  }

  private *readDirectory(directory: string): EffectGen<string[], BadPreconditionsError> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).readDirectory(directory),
      e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to read ${directory} as a directory`, message)),
    );
  }
}
