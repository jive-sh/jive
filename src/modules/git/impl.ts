import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "path";
import * as modules from "@/modules";
import type { HostShellCommand } from "@/modules/host-shell/interface";
import type { GitIdentity, SubmoduleUpdateResult } from "@/modules/git/interface";

type SpawnIo = "inherit" | "ignore" | "pipe";

export const GitImpl = e.Layer.effect(modules.IGit, e.Effect.gen(function*() {
  const toolState = yield* modules.IToolState;
  const fileSystem = yield* ep.FileSystem.FileSystem;
  const hostShell = yield* modules.IHostShell;

  const resolveRepoPath = e.Effect.fn(function*(org: string, repo: string) {
    if (e.Option.isNone(toolState.workspaceRoot)) return e.Option.none();

    const repoPath = path.join(toolState.workspaceRoot.value, `@${org}`, repo);
    const exists = yield* fileSystem.exists(repoPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
    return exists ? e.Option.some(repoPath) : e.Option.none();
  });

  const listDirectoryNames = e.Effect.fn(function*(targetPath: string) {
    return yield* fileSystem.readDirectory(targetPath).pipe(
      e.Effect.catchAll(() => e.Effect.succeed([] as string[])),
    );
  });

  const isDirectory = e.Effect.fn(function*(targetPath: string) {
    return yield* fileSystem.stat(targetPath).pipe(
      e.Effect.map((info) => info.type === "Directory"),
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
  });

  const gitExistsAt = e.Effect.fn(function*(targetPath: string) {
    return yield* fileSystem.exists(path.join(targetPath, ".git")).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
  });

  function httpsRepoUrl(org: string, repo: string): string {
    return `https://github.com/${org}/${repo}.git`;
  }

  function sshRepoUrl(org: string, repo: string): string {
    return `git@github.com:${org}/${repo}.git`;
  }

  const runGit = e.Effect.fn(function*(args: string[], cwd: string, io: SpawnIo) {
    const command: HostShellCommand = {
      command: "git",
      args,
      cwd: e.Option.some(cwd),
      env: {},
      stdin: io === "inherit" ? "inherit" : "ignore",
      stdout: io,
      stderr: io,
      shell: e.Option.none(),
    };

    return yield* hostShell.run(command).pipe(
      e.Effect.map((result) => e.Option.some(result)),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
    );
  });

  const isDirty = e.Effect.fn(function*(repoPath: string) {
    const status = yield* runGit(["status", "--porcelain"], repoPath, "pipe");
    if (e.Option.isNone(status) || status.value.exitCode !== 0) return true;
    return status.value.stdout.trim().length > 0;
  });

  const currentBranchName = e.Effect.fn(function*(repoPath: string) {
    const branchResult = yield* runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath, "pipe");
    if (e.Option.isNone(branchResult) || branchResult.value.exitCode !== 0) return e.Option.none<string>();

    const branch = branchResult.value.stdout.trim();
    return branch ? e.Option.some(branch) : e.Option.none<string>();
  });

  const fetchDefaultBranch = e.Effect.fn(function*(org: string, repo: string, readOnlyToken: string) {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (readOnlyToken) {
      headers.Authorization = `Bearer ${readOnlyToken}`;
    }

    const response = yield* e.Effect.promise(() => fetch(`https://api.github.com/repos/${org}/${repo}`, { headers }));
    if (!response.ok) return e.Option.none<string>();

    const payload = yield* e.Effect.promise(() => response.json() as Promise<{ default_branch?: unknown }>);
    return typeof payload.default_branch === "string" && payload.default_branch
      ? e.Option.some(payload.default_branch)
      : e.Option.none<string>();
  });

  const localOrgs = e.Effect.fn(function*() {
    if (e.Option.isNone(toolState.workspaceRoot)) return [] as string[];

    const entries = yield* listDirectoryNames(toolState.workspaceRoot.value);
    const orgs: string[] = [];

    for (const entry of entries) {
      if (!entry.startsWith("@")) continue;

      const entryPath = path.join(toolState.workspaceRoot.value, entry);
      const directory = yield* isDirectory(entryPath);
      if (directory) orgs.push(entry.slice(1));
    }

    return orgs;
  })();

  const remoteRepos = e.Effect.fn(function*(org: string, readOnlyToken = "") {
    const baseHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (readOnlyToken) {
      baseHeaders.Authorization = `Bearer ${readOnlyToken}`;
    }

    const orgResponse = yield* e.Effect.promise(() =>
      fetch(`https://api.github.com/orgs/${org}/repos?per_page=100&type=all`, { headers: baseHeaders }),
    );

    if (orgResponse.ok) {
      const repos = yield* e.Effect.promise(() => orgResponse.json() as Promise<Array<{ name: string }>>);
      return repos.map((repo) => repo.name);
    }

    const userResponse = yield* e.Effect.promise(() =>
      fetch(`https://api.github.com/users/${org}/repos?per_page=100&type=all`, { headers: baseHeaders }),
    );
    if (!userResponse.ok) return [] as string[];

    const repos = yield* e.Effect.promise(() => userResponse.json() as Promise<Array<{ name: string }>>);
    return repos.map((repo) => repo.name);
  });

  const localRepos = e.Effect.fn(function*(org: string) {
    if (e.Option.isNone(toolState.workspaceRoot)) return [] as string[];

    const orgDir = path.join(toolState.workspaceRoot.value, `@${org}`);
    const orgExists = yield* fileSystem.exists(orgDir).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    );
    if (!orgExists) return [] as string[];

    const entries = yield* listDirectoryNames(orgDir);
    const repos: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(orgDir, entry);
      const directory = yield* isDirectory(entryPath);
      if (directory) repos.push(entry);
    }

    return repos;
  });

  const submoduleExists = e.Effect.fn(function*(org: string, repo: string) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) return false;
    return yield* gitExistsAt(repoPath.value);
  });

  const addSubmodule = e.Effect.fn(function*(org: string, repo: string) {
    if (e.Option.isNone(toolState.workspaceRoot)) return false;

    const submodulePath = `@${org}/${repo}`;
    const addResult = yield* runGit(
      ["submodule", "add", "--", httpsRepoUrl(org, repo), submodulePath],
      toolState.workspaceRoot.value,
      "inherit",
    );
    if (e.Option.isNone(addResult) || addResult.value.exitCode !== 0) return false;

    const repoPath = path.join(toolState.workspaceRoot.value, submodulePath);
    const remoteResult = yield* runGit(["remote", "set-url", "origin", sshRepoUrl(org, repo)], repoPath, "ignore");
    return e.Option.isSome(remoteResult) && remoteResult.value.exitCode === 0;
  });

  const removeSubmodule = e.Effect.fn(function*(org: string, repo: string) {
    if (e.Option.isNone(toolState.workspaceRoot)) return false;

    const submodulePath = `@${org}/${repo}`;
    const deinitResult = yield* runGit(["submodule", "deinit", "-f", "--", submodulePath], toolState.workspaceRoot.value, "ignore");
    if (e.Option.isNone(deinitResult)) return false;

    const rmResult = yield* runGit(["rm", "-f", "--", submodulePath], toolState.workspaceRoot.value, "inherit");
    if (e.Option.isNone(rmResult) || rmResult.value.exitCode !== 0) return false;

    const gitModulesPath = path.join(toolState.workspaceRoot.value, ".git", "modules", `@${org}`, repo);
    yield* fileSystem.remove(gitModulesPath, { recursive: true, force: true }).pipe(
      e.Effect.catchAll(() => e.Effect.void),
    );

    return true;
  });

  const updateSubmoduleIfAllowed = e.Effect.fn(function*(org: string, repo: string, readOnlyToken: string) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) return { _tag: "Missing" } as const satisfies SubmoduleUpdateResult;

    const dirty = yield* isDirty(repoPath.value);
    if (dirty) return { _tag: "SkippedDirty" } as const satisfies SubmoduleUpdateResult;

    const defaultBranch = yield* fetchDefaultBranch(org, repo, readOnlyToken);
    if (e.Option.isNone(defaultBranch)) {
      return { _tag: "SkippedUnknownDefaultBranch" } as const satisfies SubmoduleUpdateResult;
    }

    const currentBranch = yield* currentBranchName(repoPath.value);
    if (e.Option.isNone(currentBranch) || currentBranch.value !== defaultBranch.value) {
      return {
        _tag: "SkippedOffDefaultBranch",
        currentBranch: e.Option.getOrElse(currentBranch, () => "(detached)"),
        defaultBranch: defaultBranch.value,
      } as const satisfies SubmoduleUpdateResult;
    }

    const pullResult = yield* runGit(
      ["pull", "--ff-only", "origin", defaultBranch.value],
      repoPath.value,
      "inherit",
    );
    if (e.Option.isNone(pullResult) || pullResult.value.exitCode !== 0) {
      return { _tag: "SkippedPullFailed" } as const satisfies SubmoduleUpdateResult;
    }

    return { _tag: "Updated" } as const satisfies SubmoduleUpdateResult;
  });

  const configureRepoRemoteAndUser = e.Effect.fn(function*(org: string, repo: string, identity: GitIdentity) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) return false;

    const setRemote = yield* runGit(["remote", "set-url", "origin", sshRepoUrl(org, repo)], repoPath.value, "ignore");
    const setName = yield* runGit(["config", "--local", "user.name", identity.userName], repoPath.value, "ignore");
    const setEmail = yield* runGit(["config", "--local", "user.email", identity.userEmail], repoPath.value, "ignore");
    const setSshCommand = yield* runGit(
      ["config", "--local", "core.sshCommand", `ssh -i \"${identity.authPrivateKeyPath}\" -o IdentitiesOnly=yes`],
      repoPath.value,
      "ignore",
    );

    if (e.Option.isNone(setRemote) || setRemote.value.exitCode !== 0) return false;
    if (e.Option.isNone(setName) || setName.value.exitCode !== 0) return false;
    if (e.Option.isNone(setEmail) || setEmail.value.exitCode !== 0) return false;
    if (e.Option.isNone(setSshCommand) || setSshCommand.value.exitCode !== 0) return false;

    if (!identity.signingPublicKey) return true;

    const setGpgFormat = yield* runGit(["config", "--local", "gpg.format", "ssh"], repoPath.value, "ignore");
    const setSigningKey = yield* runGit(["config", "--local", "user.signingkey", identity.signingPublicKey], repoPath.value, "ignore");
    const setSignCommits = yield* runGit(["config", "--local", "commit.gpgsign", "true"], repoPath.value, "ignore");

    return e.Option.isSome(setGpgFormat)
      && setGpgFormat.value.exitCode === 0
      && e.Option.isSome(setSigningKey)
      && setSigningKey.value.exitCode === 0
      && e.Option.isSome(setSignCommits)
      && setSignCommits.value.exitCode === 0;
  });

  const runInRepo = e.Effect.fn(function*(org: string, repo: string, command: readonly string[]) {
    const repoPath = yield* resolveRepoPath(org, repo);
    if (e.Option.isNone(repoPath)) return false;
    if (command.length === 0) return false;

    const [executable, ...args] = command;
    if (!executable) return false;

    const result = yield* hostShell.run({
      command: executable,
      args,
      cwd: e.Option.some(repoPath.value),
      env: {},
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      shell: e.Option.none(),
    }).pipe(
      e.Effect.map((value) => e.Option.some(value)),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
    );

    return e.Option.isSome(result) && result.value.exitCode === 0;
  });

  return {
    requiredCLICommands: ["git"],
    localOrgs,
    remoteRepos,
    localRepos,
    submoduleExists,
    addSubmodule,
    removeSubmodule,
    updateSubmoduleIfAllowed,
    configureRepoRemoteAndUser,
    runInRepo,
  };
}));
