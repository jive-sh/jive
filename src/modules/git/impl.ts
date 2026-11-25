import * as e from "effect";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { SIGNING_COMMAND_NAME, SSH_COMMAND_NAME, TOOL_NAME, installedCommandPath } from "@/constants";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import { PACKAGES_DIRECTORY, isPackageName, packageRelativePath } from "@/modules/tool-state/workspace-layout";
import { GITHUB_HTTPS, GITHUB_SSH, githubHttpsUrl, repoOfGitHubRemote } from "./github-remote";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import type { GitIdentity } from "./identity";
import { LoadOutcome, type IGit, type LoadedRepository, type LoadedSubmodule, type RepositorySettings } from "./interface";

/** One line of `git submodule status`: a state character (space, -, + or U), the commit, then the path. */
const SUBMODULE_STATUS_LINE = /^([ +\-U])[0-9a-f]+ (\S+)/;
/** One line of `git config --get-regexp` over .gitmodules' paths and URLs: the submodule's name, the field, its value. */
const SUBMODULE_FIELD_LINE = /^submodule\.(.+)\.(path|url) (.+)$/;
/** One line of `git config --get-regexp` over .gitmodules' URLs: the key, then the URL. */
const SUBMODULE_URL_LINE = /^(submodule\..+\.url) (.+)$/;
/** Submodules nest at most this deep; a loop past it means a submodule names itself. */
const MAX_SUBMODULE_DEPTH = 16;
/** Under the workspace's git directory: where `load` clones a repo to read its package name, before moving it in place. */
const LOAD_STAGING_DIRECTORY = "jive-load";
/** Under the workspace's git directory: the copy of the index's .gitmodules that `load` adds its entry to. */
const STAGED_GITMODULES_FILE = "jive-load-gitmodules";
const GITLINK_MODE = "160000";

/** One entry of a .gitmodules. */
interface SubmoduleEntry {
  readonly name: string;
  readonly path: string;
  readonly url: string;
}

export class GitImpl extends implementing(modules.git).uses(modules.toolState, modules.bun, OSPlatform, e.FileSystem.FileSystem) implements IGit {
  *removeSubmodule(repoId: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError> {
    const { submoduleName, location: { relativePath } } = yield* this.loadedRepository(repoId);
    const workspaceRoot = yield* this.workspaceRoot();
    yield* this.git(["submodule", "deinit", "-f", relativePath], workspaceRoot);
    yield* this.git(["rm", "-f", relativePath], workspaceRoot);
    const gitDirectory = yield* this.absoluteGitDirectory(workspaceRoot);
    yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).remove(path.join(gitDirectory, "modules", submoduleName), { recursive: true, force: true }),
      e.Effect.catchTag("PlatformError", ({ message }) => e.Effect.fail(BadPreconditionsError.withoutFix(
        `Failed to remove the git directory of submodule ${relativePath}`, message,
      ))),
    );
  }

  *localOrgs(): EffectGen<string[], BadPreconditionsError> {
    const repositories = yield* this.loadedRepositories();
    return [...new Set(repositories.map(({ repo }) => repo.org))].sort();
  }

  *localRepos(org: string): EffectGen<RepoIdentifier[], BadArgumentError | BadPreconditionsError> {
    const repos = (yield* this.loadedRepositories()).map(({ repo }) => repo).filter(repo => repo.org === org);
    if (repos.length === 0) {
      return yield* new BadArgumentError({ argument: "org", reason: `Org @${org} does not exist in this workspace` });
    }
    return repos.sort((left, right) => left.repo.localeCompare(right.repo));
  }

  *loadedRepository(repo: RepoIdentifier): EffectGen<LoadedRepository, BadArgumentError | BadPreconditionsError> {
    const maybeLoaded = (yield* this.loadedRepositories()).find(loaded => loaded.repo.equals(repo));
    if (maybeLoaded === undefined) {
      return yield* new BadArgumentError({ argument: "repo", reason: `There is no repo "${repo.toString()}" in this workspace` });
    }
    if (!(yield* this.pathExists(path.join(maybeLoaded.location.absolutePath, ".git")))) {
      return yield* new BadPreconditionsError({
        cause: `${repo.toString()} is a submodule at ${maybeLoaded.location.relativePath}, but it isn't checked out`,
        fix: `Run \`${TOOL_NAME} init\`, which checks out every submodule`,
      });
    }
    return maybeLoaded;
  }

  *loadAsSubmodule(repo: RepoIdentifier): EffectGen<LoadedSubmodule, BadArgumentError | BadPreconditionsError> {
    const workspaceRoot = yield* this.workspaceRoot();
    const gitDirectory = yield* this.absoluteGitDirectory(workspaceRoot);
    const staging = path.join(gitDirectory, LOAD_STAGING_DIRECTORY, repo.org, repo.repo);
    return yield* e.pipe(
      e.Effect.gen(() => this.placeAsSubmodule({ repo, workspaceRoot, gitDirectory, staging })),
      // The staging clone is gone on every path: moved into place, or removed here.
      e.Effect.ensuring(e.pipe(
        this.getDependency(e.FileSystem.FileSystem).remove(path.join(gitDirectory, LOAD_STAGING_DIRECTORY), { recursive: true, force: true }),
        e.Effect.ignore,
      )),
    );
  }

  *clone({ repo, directory }: { readonly repo: RepoIdentifier; readonly directory: string }): EffectGen<void, BadPreconditionsError> {
    yield* this.git([...yield* this.fetchConfig(), "clone", githubHttpsUrl(repo), directory], path.dirname(directory));
  }

  *repositoryRoot(directory: string): EffectGen<string, BadPreconditionsError> {
    const { stdout } = yield* this.git(["rev-parse", "--show-toplevel"], directory, "capture");
    return stdout.trim();
  }

  *localIdentity(repository: string): EffectGen<e.Option.Option<GitIdentity>, BadPreconditionsError> {
    // `config --get` exits 1 for an unset key, which reads as empty here.
    const { stdout: name } = yield* this.gitAllowingFailure(["config", "--local", "--get", "user.name"], repository);
    const { stdout: email } = yield* this.gitAllowingFailure(["config", "--local", "--get", "user.email"], repository);
    return name.trim() !== "" && email.trim() !== "" ? e.Option.some({ name: name.trim(), email: email.trim() }) : e.Option.none();
  }

  *createRepository(directory: string): EffectGen<void, BadPreconditionsError> {
    yield* this.git(["init", "-b", "main"], directory, "capture");
  }

  /** The workspace's submodules whose URL names a GitHub repo, from its root .gitmodules. */
  private *loadedRepositories(): EffectGen<ReadonlyArray<LoadedRepository>, BadPreconditionsError> {
    const workspaceRoot = yield* this.workspaceRoot();
    return (yield* this.submoduleEntries(workspaceRoot)).flatMap(({ name, path: relativePath, url }) => e.Option.toArray(e.Option.map(
      repoOfGitHubRemote(url),
      (repo): LoadedRepository => ({ repo, submoduleName: name, location: { relativePath, absolutePath: path.join(workspaceRoot, relativePath) } }),
    )));
  }

  /**
   * Gets the repo to `packages/<its package name>` as a submodule: already there, adopted from a checkout already in
   * place, or cloned to `staging` first, since its package name decides where it goes.
   */
  private *placeAsSubmodule({ repo, workspaceRoot, gitDirectory, staging }: {
    readonly repo: RepoIdentifier;
    readonly workspaceRoot: string;
    readonly gitDirectory: string;
    readonly staging: string;
  }): EffectGen<LoadedSubmodule, BadArgumentError | BadPreconditionsError> {
    const location = (relativePath: string) => ({ relativePath, absolutePath: path.join(workspaceRoot, relativePath) });
    const maybeRegistered = (yield* this.submoduleEntries(workspaceRoot)).find(entry =>
      e.Option.match(repoOfGitHubRemote(entry.url), { onNone: () => false, onSome: (named) => named.equals(repo) }));
    if (maybeRegistered !== undefined && (yield* this.isGitlink({ workspaceRoot, relativePath: maybeRegistered.path }))) {
      const registered = location(maybeRegistered.path);
      if (!(yield* this.pathExists(path.join(registered.absolutePath, ".git")))) {
        yield* this.git([...yield* this.fetchConfig(), "submodule", "update", "--init", "--", registered.relativePath], workspaceRoot);
      }
      const packageName = yield* this.packageNameIn({ repo, directory: registered.absolutePath });
      yield* this.assertInPlace({ repo, packageName, relativePath: registered.relativePath });
      yield* logLoading({ repo, workspaceRoot, destination: registered.absolutePath });
      return { packageName, location: registered, outcome: LoadOutcome.AlreadyLoaded() };
    }

    const maybeCheckout = yield* this.uncommittedCheckoutOf({ repo, workspaceRoot });
    if (e.Option.isSome(maybeCheckout)) {
      const adopted = location(maybeCheckout.value);
      const packageName = yield* this.packageNameIn({ repo, directory: adopted.absolutePath });
      yield* this.assertInPlace({ repo, packageName, relativePath: adopted.relativePath });
      yield* logLoading({ repo, workspaceRoot, destination: adopted.absolutePath });
      yield* this.stageSubmodule({ repo, workspaceRoot, gitDirectory, relativePath: adopted.relativePath });
      return { packageName, location: adopted, outcome: LoadOutcome.Adopted() };
    }

    const fs = this.getDependency(e.FileSystem.FileSystem);
    const failToMove = (what: string) => ({ message }: { readonly message: string }) => BadPreconditionsError.withoutFix(what, message);
    yield* e.pipe(fs.remove(staging, { recursive: true, force: true }), e.Effect.mapError(failToMove(`Failed to clear ${staging}`)));
    yield* e.pipe(fs.makeDirectory(path.dirname(staging), { recursive: true }), e.Effect.mapError(failToMove(`Failed to create ${path.dirname(staging)}`)));
    yield* this.git([...yield* this.fetchConfig(), "clone", githubHttpsUrl(repo), staging], workspaceRoot);
    const packageName = yield* this.packageNameIn({ repo, directory: staging });
    const cloned = location(packageRelativePath(packageName));
    yield* logLoading({ repo, workspaceRoot, destination: cloned.absolutePath });
    if (yield* this.pathExists(cloned.absolutePath)) {
      const contents = yield* this.readDirectory(cloned.absolutePath);
      if (contents.length > 0) {
        return yield* new BadPreconditionsError({
          cause: `${cloned.relativePath} already exists and is not a checkout of ${repo.org}/${repo.repo}`,
          fix: `Move ${cloned.relativePath} away, then run this again`,
        });
      }
      yield* e.pipe(fs.remove(cloned.absolutePath, { recursive: true }), e.Effect.mapError(failToMove(`Failed to remove the empty ${cloned.relativePath}`)));
    }
    yield* e.pipe(fs.makeDirectory(path.dirname(cloned.absolutePath), { recursive: true }), e.Effect.mapError(failToMove(`Failed to create ${path.dirname(cloned.relativePath)}`)));
    yield* e.pipe(fs.rename(staging, cloned.absolutePath), e.Effect.mapError(failToMove(`Failed to move the clone of ${repo.org}/${repo.repo} to ${cloned.relativePath}`)));
    yield* this.stageSubmodule({ repo, workspaceRoot, gitDirectory, relativePath: cloned.relativePath });
    return { packageName, location: cloned, outcome: LoadOutcome.Cloned() };
  }

  /** The package name in `directory`'s package.json: jive loads only packages, and the name decides where one goes. */
  private *packageNameIn({ repo, directory }: { readonly repo: RepoIdentifier; readonly directory: string }): EffectGen<string, BadPreconditionsError> {
    const maybeName = yield* this.dependencies.bun.packageName(directory);
    if (e.Option.isNone(maybeName) || !isPackageName(maybeName.value)) {
      return yield* new BadPreconditionsError({
        cause: `${repo.org}/${repo.repo} has no package.json with a valid package name, and jive keeps each repo at ${PACKAGES_DIRECTORY}/<its package name>`,
        fix: `Give ${repo.org}/${repo.repo} a package.json naming its package, then run this again`,
      });
    }
    return maybeName.value;
  }

  private *assertInPlace({ repo, packageName, relativePath }: { readonly repo: RepoIdentifier; readonly packageName: string; readonly relativePath: string }): EffectGen<void, BadPreconditionsError> {
    const expected = packageRelativePath(packageName);
    if (relativePath !== expected) {
      return yield* new BadPreconditionsError({
        cause: `${repo.org}/${repo.repo} is at ${relativePath}, but jive keeps the package ${packageName} at ${expected}`,
        fix: `Move it with \`git mv ${relativePath} ${expected}\` (or move the checkout there), then run this again`,
      });
    }
  }

  /**
   * A git checkout of `repo` at `packages/<name>` or `packages/@<scope>/<name>` that the workspace doesn't have as a
   * submodule yet, found by its remotes' URLs.
   */
  private *uncommittedCheckoutOf({ repo, workspaceRoot }: { readonly repo: RepoIdentifier; readonly workspaceRoot: string }): EffectGen<e.Option.Option<string>, BadPreconditionsError> {
    const candidates: Array<string> = [];
    const packagesDirectory = path.join(workspaceRoot, PACKAGES_DIRECTORY);
    if (!(yield* this.isDirectory(packagesDirectory))) return e.Option.none();
    for (const entry of (yield* this.readDirectory(packagesDirectory)).sort()) {
      const relativePath = path.posix.join(PACKAGES_DIRECTORY, entry);
      if (!entry.startsWith("@")) {
        candidates.push(relativePath);
      } else if (yield* this.isDirectory(path.join(workspaceRoot, relativePath))) {
        for (const scoped of (yield* this.readDirectory(path.join(workspaceRoot, relativePath))).sort()) candidates.push(path.posix.join(relativePath, scoped));
      }
    }
    for (const relativePath of candidates) {
      const directory = path.join(workspaceRoot, relativePath);
      if (!(yield* this.pathExists(path.join(directory, ".git")))) continue;
      if (yield* this.isGitlink({ workspaceRoot, relativePath })) continue;
      const { stdout } = yield* this.gitAllowingFailure(["config", "--local", "--get-regexp", "^remote\\..*\\.url$"], directory);
      const namesRepo = stdout.split("\n").some(line => e.Option.match(repoOfGitHubRemote(line.slice(line.indexOf(" ") + 1)), {
        onNone: () => false,
        onSome: (named) => named.equals(repo),
      }));
      if (namesRepo) return e.Option.some(relativePath);
    }
    return e.Option.none();
  }

  /**
   * Registers the checkout at `relativePath` as a submodule, as `git submodule add` would, without staging anything
   * else: the index's .gitmodules gets this one entry (never the working tree's other, uncommitted edits), the index
   * gets the gitlink at the checkout's HEAD, the working tree's .gitmodules gets the entry too, the checkout's git
   * directory moves under the workspace's `.git/modules`, and the submodule is initialised in `.git/config`.
   */
  private *stageSubmodule({ repo, workspaceRoot, gitDirectory, relativePath }: {
    readonly repo: RepoIdentifier;
    readonly workspaceRoot: string;
    readonly gitDirectory: string;
    readonly relativePath: string;
  }): EffectGen<void, BadPreconditionsError> {
    const url = githubHttpsUrl(repo);
    const { stdout: head } = yield* e.pipe(
      e.Effect.gen(() => this.git(["rev-parse", "--verify", "HEAD"], path.join(workspaceRoot, relativePath), "capture")),
      e.Effect.mapError(() => new BadPreconditionsError({ cause: `${relativePath} has no commit yet`, fix: `Commit in ${relativePath}, then run this again` })),
    );
    const fields = { path: relativePath, url };
    const staged = path.join(gitDirectory, STAGED_GITMODULES_FILE);
    yield* e.pipe(
      e.Effect.gen(() => this.stageGitmodulesEntry({ workspaceRoot, staged, relativePath, fields })),
      e.Effect.ensuring(e.Effect.ignore(this.getDependency(e.FileSystem.FileSystem).remove(staged, { force: true }))),
    );
    for (const [field, value] of Object.entries(fields)) {
      yield* this.git(["config", "-f", ".gitmodules", `submodule.${relativePath}.${field}`, value], workspaceRoot, "capture");
    }
    yield* this.git(["update-index", "--add", "--cacheinfo", `${GITLINK_MODE},${head.trim()},${relativePath}`], workspaceRoot, "capture");
    yield* this.git(["submodule", "absorbgitdirs", "--", relativePath], workspaceRoot, "capture");
    yield* this.git(["submodule", "init", "--", relativePath], workspaceRoot, "capture");
  }

  /** Stages the index's .gitmodules plus one entry, copied to `staged` to add it, so the working tree's copy stays out. */
  private *stageGitmodulesEntry({ workspaceRoot, staged, relativePath, fields }: {
    readonly workspaceRoot: string;
    readonly staged: string;
    readonly relativePath: string;
    readonly fields: Readonly<Record<string, string>>;
  }): EffectGen<void, BadPreconditionsError> {
    const { stdout: indexed } = yield* this.gitAllowingFailure(["cat-file", "blob", ":.gitmodules"], workspaceRoot);
    yield* e.pipe(
      this.getDependency(e.FileSystem.FileSystem).writeFileString(staged, indexed),
      e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix(`Failed to write ${staged}`, message)),
    );
    for (const [field, value] of Object.entries(fields)) {
      yield* this.git(["config", "-f", staged, `submodule.${relativePath}.${field}`, value], workspaceRoot, "capture");
    }
    const { stdout: blob } = yield* this.git(["hash-object", "-w", staged], workspaceRoot, "capture");
    yield* this.git(["update-index", "--add", "--cacheinfo", `100644,${blob.trim()},.gitmodules`], workspaceRoot, "capture");
  }

  private *isGitlink({ workspaceRoot, relativePath }: { readonly workspaceRoot: string; readonly relativePath: string }): EffectGen<boolean, BadPreconditionsError> {
    const { stdout } = yield* this.git(["ls-files", "--stage", "--", relativePath], workspaceRoot, "capture");
    return stdout.split("\n").some(line => line.startsWith(`${GITLINK_MODE} `) && line.endsWith(`\t${relativePath}`));
  }

  /** `repository`'s .gitmodules entries; none when it has no .gitmodules. */
  private *submoduleEntries(repository: string): EffectGen<ReadonlyArray<SubmoduleEntry>, BadPreconditionsError> {
    if (!(yield* this.pathExists(path.join(repository, ".gitmodules")))) return [];
    const { stdout } = yield* this.gitAllowingFailure(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$"], repository);
    const fieldsByName = new Map<string, { path?: string; url?: string }>();
    for (const line of stdout.split("\n")) {
      const match = SUBMODULE_FIELD_LINE.exec(line.trim());
      if (match === null) continue;
      const name = match[1]!;
      fieldsByName.set(name, { ...fieldsByName.get(name), [match[2]!]: match[3]! });
    }
    return [...fieldsByName].flatMap(([name, fields]) =>
      fields.path !== undefined && fields.url !== undefined ? [{ name, path: fields.path, url: fields.url }] : []);
  }

  private *absoluteGitDirectory(repository: string): EffectGen<string, BadPreconditionsError> {
    const { stdout } = yield* this.git(["rev-parse", "--absolute-git-dir"], repository, "capture");
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

  *useHttpsSubmoduleUrls(repository: string): EffectGen<number, BadPreconditionsError> {
    let changed = 0;
    for (const { key, url } of yield* this.submoduleUrls(repository)) {
      const maybeRepo = repoOfGitHubRemote(url);
      if (e.Option.isNone(maybeRepo)) continue;
      const https = githubHttpsUrl(maybeRepo.value);
      if (url === https) continue;
      yield* this.git(["config", "-f", ".gitmodules", key, https], repository, "capture");
      changed += 1;
    }
    return changed;
  }

  /** `repository`'s .gitmodules URLs with their config keys; none when it has no .gitmodules, which is never created. */
  private *submoduleUrls(repository: string): EffectGen<ReadonlyArray<{ readonly key: string; readonly url: string }>, BadPreconditionsError> {
    if (!(yield* this.pathExists(path.join(repository, ".gitmodules")))) return [];
    const { stdout } = yield* this.gitAllowingFailure(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.url$"], repository);
    return stdout.split("\n").flatMap((line) => {
      const match = SUBMODULE_URL_LINE.exec(line.trim());
      return match === null ? [] : [{ key: match[1]!, url: match[2]! }];
    });
  }

  /** Returns how many submodules it checked out. */
  private *fetchSubmodules(root: string): EffectGen<number, BadPreconditionsError> {
    const fetchConfig = yield* this.fetchConfig();
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

  *configureRepository({ repository, settings }: { readonly repository: string; readonly settings: RepositorySettings }): EffectGen<void, BadPreconditionsError> {
    for (const [key, value] of Object.entries(yield* this.repositoryConfig(settings))) {
      yield* this.git(["config", "--local", key, value], repository, "capture");
    }
  }

  /**
   * Each pass moves every .gitmodules the previous one revealed to https and checks out the submodules it names (a
   * repository git doesn't track can hold submodules of its own), until a pass does neither.
   */
  *checkOutSubmodulesOverHttps(root: string): EffectGen<{ readonly rewritten: number; readonly checkedOut: number }, BadPreconditionsError> {
    let rewritten = 0;
    let checkedOut = 0;
    for (let depth = 0; depth < MAX_SUBMODULE_DEPTH; depth += 1) {
      const repositories = yield* this.repositoriesUnder(root);
      let rewrittenThisPass = 0;
      for (const repository of repositories) {
        rewrittenThisPass += yield* this.useHttpsSubmoduleUrls(repository);
      }
      let checkedOutThisPass = 0;
      for (const repository of repositories) {
        checkedOutThisPass += yield* this.fetchSubmodules(repository);
      }
      rewritten += rewrittenThisPass;
      checkedOut += checkedOutThisPass;
      if (rewrittenThisPass === 0 && checkedOutThisPass === 0) return { rewritten, checkedOut };
    }
    return yield* BadPreconditionsError.withoutFix(`Submodules under ${root} nest more than ${MAX_SUBMODULE_DEPTH} deep`);
  }

  /**
   * Everything jive sets in a repository, and nothing else (the design Alex aligned on, 2026-11-01: "the agent talks
   * to the jive server and forwards the ssh signature request and the jive server does it"). Commits are signed by
   * `jive-ssh-sign`, which runs ssh-keygen through the agent, with the account key's public half as `user.signingKey`;
   * fetches and pushes go over SSH through `jive-ssh`, the https URLs being rewritten to SSH ones. Both ask
   * `jive-daemon` first, so a missing session or an unreachable server is named before ssh or ssh-keygen runs. No
   * GitHub sign-in or token is involved. Commits carry the workspace's git identity, so a machine without a global one
   * commits as the person too (Alex, 2026-11-19: "I think jive init can actually, for now, have an interactvie flow
   * where it asks for an email and username").
   */
  private *repositoryConfig({ accountKey, gitIdentity }: RepositorySettings): EffectGen<Record<string, string>> {
    return {
      "user.name": gitIdentity.name,
      "user.email": gitIdentity.email,
      "gpg.format": "ssh",
      "user.signingKey": accountKey.publicKeyFile,
      "commit.gpgSign": "true",
      "gpg.ssh.program": yield* this.installedCommand(SIGNING_COMMAND_NAME),
      ...yield* this.sshConfig(),
      [`url.${GITHUB_SSH}.insteadOf`]: GITHUB_HTTPS,
    };
  }

  /** For one git command that fetches a submodule not yet configured: over SSH, through `jive-ssh`. */
  private *fetchConfig(): EffectGen<ReadonlyArray<string>> {
    return [
      ...Object.entries(yield* this.sshConfig()).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
      "-c", `url.${GITHUB_SSH}.insteadOf=${GITHUB_HTTPS}`,
    ];
  }

  /**
   * git runs `core.sshCommand` through a shell, so the path is quoted when it holds anything else than a path's plain
   * characters. `ssh.variant=ssh` tells git it is OpenSSH, so git passes `-o SendEnv=GIT_PROTOCOL` and keeps protocol
   * v2; `simple` would drop git to protocol v0, and the default makes git guess from the command's name.
   */
  private *sshConfig(): EffectGen<Record<string, string>> {
    const command = yield* this.installedCommand(SSH_COMMAND_NAME);
    return {
      "core.sshCommand": /^[\w./+-]+$/.test(command) ? command : `'${command.replaceAll("'", `'\\''`)}'`,
      "ssh.variant": "ssh",
    };
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

/** Where `jive load` puts the repo, and in which workspace: the nearest git repository, whose level the person chose by where they ran it. */
function logLoading({ repo, workspaceRoot, destination }: { readonly repo: RepoIdentifier; readonly workspaceRoot: string; readonly destination: string }) {
  return e.Effect.log(`Loading ${repo.org}/${repo.repo} into ${destination}, in the workspace at ${workspaceRoot}`);
}
