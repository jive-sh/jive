import * as e from "effect";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { SSH_KEYGEN_COMMAND_NAME, TOOL_NAME, installedCommandPath } from "@/constants";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import type { AccountKey } from "@/modules/account-key/interface";
import type { CurrentUser } from "@/modules/auth/interface";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import type { IGit } from "./interface";

/** One line of `git submodule status`: a state character (space, -, + or U), the commit, then the path. */
const SUBMODULE_STATUS_LINE = /^([ +\-U])[0-9a-f]+ (\S+)/;
/** One line of `git config --get-regexp` over .gitmodules' URLs: the key, then the URL. */
const SUBMODULE_URL_LINE = /^(submodule\..+\.url) (.+)$/;
/** Submodules nest at most this deep; a loop past it means a submodule names itself. */
const MAX_SUBMODULE_DEPTH = 16;

export class GitImpl extends implementing(modules.git).uses(modules.toolState, modules.github, OSPlatform, e.FileSystem.FileSystem) implements IGit {
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

  *submoduleExists(repoId: RepoIdentifier): EffectGen<boolean, BadArgumentError | BadPreconditionsError> {
    const repoLocation = yield* this.dependencies.toolState.repoPath(repoId);
    if (!(yield* this.isDirectory(repoLocation.absolutePath))) {
      return false;
    }
    const submodules = yield* this.getSubmodules();
    return submodules.some(submodule => submodule.equals(repoId));
  }

  *cloneAsSubmodule(repoId: RepoIdentifier, user: CurrentUser): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const { relativePath, absolutePath } = yield* this.dependencies.toolState.repoPath(repoId);
    const { https } = this.dependencies.github.remoteUrls(repoId);
    const workspaceRoot = yield* this.workspaceRoot();
    yield* this.git([...yield* this.fetchConfig(user.accountKey), "submodule", "add", https, relativePath], workspaceRoot);
    yield* this.checkOutSubmodulesOverHttps(absolutePath, user);
    for (const repository of yield* this.repositoriesUnder(absolutePath)) {
      yield* this.configureRepository(repository, user);
    }
  }

  *getSubmodules(): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError> {
    const urls = yield* this.submoduleUrls(yield* this.workspaceRoot());
    return urls.flatMap(({ url }) => e.Option.toArray(this.dependencies.github.repoOfRemote(url)));
  }

  *repositoryRoot(directory: string): EffectGen<string, BadPreconditionsError> {
    const { stdout } = yield* this.git(["rev-parse", "--show-toplevel"], directory, "capture");
    return stdout.trim();
  }

  *repositoriesUnder(root: string): EffectGen<ReadonlyArray<string>, BadPreconditionsError> {
    const repositories: Array<string> = [];
    const pending = [root];
    while (pending.length > 0) {
      const repository = pending.shift()!;
      repositories.push(repository);
      const { stdout: submodules } = yield* this.git(["submodule", "--quiet", "foreach", "pwd"], repository, "capture");
      pending.push(...submodules.split("\n").map(line => line.trim()).filter(Boolean));
      // A repository in the working tree that git doesn't track (cloned there, never added as a submodule) is listed
      // as an untracked directory: git stops at its .git.
      const { stdout: untracked } = yield* this.git(["ls-files", "--others", "--exclude-standard", "--directory"], repository, "capture");
      for (const entry of untracked.split("\n").map(line => line.trim()).filter(line => line.endsWith("/"))) {
        const directory = path.join(repository, entry);
        if (yield* this.pathExists(path.join(directory, ".git"))) pending.push(directory.replace(/\/$/, ""));
      }
    }
    return repositories;
  }

  private *useHttpsSubmoduleUrls(repository: string): EffectGen<number, BadPreconditionsError> {
    const { github } = this.dependencies;
    let changed = 0;
    for (const { key, url } of yield* this.submoduleUrls(repository)) {
      const maybeRepo = github.repoOfRemote(url);
      if (e.Option.isNone(maybeRepo)) continue;
      const { https } = github.remoteUrls(maybeRepo.value);
      if (url === https) continue;
      yield* this.git(["config", "-f", ".gitmodules", key, https], repository, "capture");
      changed += 1;
    }
    return changed;
  }

  /** Returns how many submodules it checked out. */
  private *fetchSubmodules(root: string, user: CurrentUser): EffectGen<number, BadPreconditionsError> {
    const fetchConfig = yield* this.fetchConfig(user.accountKey);
    yield* this.git([...fetchConfig, "submodule", "sync", "--recursive"], root, "capture");
    let checkedOut = 0;
    for (let depth = 0; depth < MAX_SUBMODULE_DEPTH; depth += 1) {
      // Only submodules not checked out (status "-"): `submodule update` on one already checked out would move its HEAD.
      const { stdout } = yield* this.git(["submodule", "status", "--recursive"], root, "capture");
      const missing = stdout.split("\n").flatMap((line) => {
        const match = SUBMODULE_STATUS_LINE.exec(line);
        return match !== null && match[1] === "-" ? [match[2]!] : [];
      });
      if (missing.length === 0) return checkedOut;
      checkedOut += missing.length;
      for (const relativePath of missing) {
        const parent = path.join(root, path.dirname(relativePath));
        const parentRoot = yield* this.repositoryRoot(parent);
        yield* this.git([...fetchConfig, "submodule", "update", "--init", "--", path.relative(parentRoot, path.join(root, relativePath))], parentRoot);
      }
    }
    return yield* BadPreconditionsError.withoutFix(`Submodules under ${root} nest more than ${MAX_SUBMODULE_DEPTH} deep`);
  }

  *configureRepository(repository: string, user: CurrentUser): EffectGen<void, BadPreconditionsError> {
    const config = yield* this.signingConfig({ name: user.username, email: user.email }, user.accountKey);
    for (const [key, value] of Object.entries(config)) {
      yield* this.git(["config", "--local", key, value], repository, "capture");
    }
    const { stdout } = yield* this.gitAllowingFailure(["config", "--get", "remote.origin.url"], repository);
    const maybeRepo = this.dependencies.github.repoOfRemote(stdout);
    if (e.Option.isNone(maybeRepo)) return;
    const { ssh, https } = this.dependencies.github.remoteUrls(maybeRepo.value);
    yield* this.git(["remote", "set-url", "origin", https], repository, "capture");
    yield* this.git(["remote", "set-url", "--push", "origin", ssh], repository, "capture");
  }

  /** Each pass checks out the level of submodules the previous one revealed, until a pass rewrites nothing. */
  *checkOutSubmodulesOverHttps(root: string, user: CurrentUser): EffectGen<number, BadPreconditionsError> {
    let rewritten = 0;
    for (let depth = 0; depth < MAX_SUBMODULE_DEPTH; depth += 1) {
      const repositories = yield* this.repositoriesUnder(root);
      let changed = 0;
      for (const repository of repositories) {
        changed += yield* this.useHttpsSubmoduleUrls(repository);
      }
      let checkedOut = 0;
      for (const repository of repositories) {
        checkedOut += yield* this.fetchSubmodules(repository, user);
      }
      rewritten += changed;
      // A checkout can reveal a .gitmodules not yet rewritten, so only a pass that does neither is the last.
      if (changed === 0 && checkedOut === 0) return rewritten;
    }
    return yield* BadPreconditionsError.withoutFix(`Submodules under ${root} nest more than ${MAX_SUBMODULE_DEPTH} deep`);
  }

  /** `repository`'s .gitmodules URLs with their config keys; none when it has no .gitmodules. */
  private *submoduleUrls(repository: string): EffectGen<ReadonlyArray<{ readonly key: string; readonly url: string }>, BadPreconditionsError> {
    if (!(yield* this.pathExists(path.join(repository, ".gitmodules")))) return [];
    const { stdout } = yield* this.gitAllowingFailure(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.url$"], repository);
    return stdout.split("\n").flatMap((line) => {
      const match = SUBMODULE_URL_LINE.exec(line.trim());
      return match === null ? [] : [{ key: match[1]!, url: match[2]! }];
    });
  }

  /**
   * The git config that signs with the account key and pushes through the signing agent. Signing runs
   * `jive-ssh-keygen`, which is ssh-keygen pointed at the agent; `user.signingKey` and ssh's identity name the public
   * key, the only part of the key this machine has. `core.sshCommand` points these repositories at the agent without
   * changing where the person's ssh config sends every other github.com connection.
   */
  private *signingConfig(identity: { readonly name: string; readonly email: string }, accountKey: AccountKey): EffectGen<Record<string, string>> {
    return {
      "user.name": identity.name,
      "user.email": identity.email,
      "user.signingKey": accountKey.publicKeyFile,
      "gpg.format": "ssh",
      "gpg.ssh.program": yield* this.installedCommand(SSH_KEYGEN_COMMAND_NAME),
      "commit.gpgSign": "true",
      "tag.gpgSign": "true",
      "core.sshCommand": yield* this.sshCommand(accountKey),
    };
  }

  /** For one git command that fetches: a nested submodule its .gitmodules names over SSH fetches through the agent. */
  private *fetchConfig(accountKey: AccountKey): EffectGen<ReadonlyArray<string>> {
    return [
      "-c", `core.sshCommand=${yield* this.sshCommand(accountKey)}`,
    ];
  }

  private *sshCommand(accountKey: AccountKey): EffectGen<string> {
    const { agentSocket } = jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory());
    return `ssh -o IdentityAgent=${JSON.stringify(agentSocket)} -o IdentityFile=${JSON.stringify(accountKey.publicKeyFile)} -o IdentitiesOnly=yes`;
  }

  private *installedCommand(commandName: string): EffectGen<string> {
    return installedCommandPath(yield* this.dependencies.OSPlatform.getExecutablePath(), commandName);
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

  /** For a git query whose nonzero exit means "nothing found" (`config --get` of an unset key): its output, empty then. */
  private *gitAllowingFailure(args: ReadonlyArray<string>, cwd: string): EffectGen<{ stdout: string }, BadPreconditionsError> {
    const result = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.OSPlatform.spawnProcess({ command: "git", args, cwd, stdout: "pipe", stderr: "pipe" })),
      e.Effect.mapError(message => BadPreconditionsError.withoutFix(`Failed to run git ${args.join(" ")}`, message)),
    );
    return { stdout: result.exitCode === 0 ? result.stdout : "" };
  }

  private *workspaceRoot(): EffectGen<string, BadPreconditionsError> {
    const { workspaceRoot } = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.toolState.assertInWorkspace()),
      e.Effect.mapError(BadPreconditionsError.fromNotInWorkspaceError),
    );
    return workspaceRoot;
  }

  private *pathExists(targetPath: string): EffectGen<boolean> {
    return yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).exists(targetPath),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed(false)),
    );
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
