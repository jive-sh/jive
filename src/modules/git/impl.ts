import * as e from "effect";
import * as ep from "@effect/platform";
import * as path from "node:path";
import * as process from "node:process";
import { GIT_CREDENTIAL_HELPER_NAME, TOOL_NAME } from "@/constants";
import * as modules from "@/modules";
import { type CurrentUser } from "@/modules/auth/interface";
import { RepoIdentifier } from "@/modules/tool-state/interface";
import { IN } from "../host-shell/interface";
import parseGitRemote from "git-url-parse";

export const GitImpl = e.Layer.effect(modules.IGit, e.Effect.gen(function*() {
  const toolState = yield* modules.IToolState;
  const fileSystem = yield* ep.FileSystem.FileSystem;
  const hostShell = yield* modules.IHostShell;

  const isDirectory = e.Effect.fn(function*(targetPath: string) {
    const exists = yield* fileSystem.exists(targetPath);
    if (!exists) return false;
    return (yield* fileSystem.stat(targetPath)).type === "Directory";
  });

  const httpsRepoUrl = ({org, repo}: {org: string; repo: string;}): string =>
    `https://github.com/${org}/${repo}.git`;

  const sshRepoUrl = ({org, repo}: {org: string; repo: string;}): string =>
    `git@github.com:${org}/${repo}.git`;

  const credentialHelperExecutablePath = (): string =>
    path.join(path.dirname(process.execPath), GIT_CREDENTIAL_HELPER_NAME);

  const shellQuote = (value: string): string =>
    `"${value.split('"').join("\\\"")}"`;

  const sshCommand = (identityFile: string): string =>
    `ssh -i ${shellQuote(identityFile)} -o IdentitiesOnly=yes`;

  const repoPath = e.Effect.fn(function*(repoId: RepoIdentifier) {
    return yield* repoId.repoPath().pipe(
      e.Effect.provideService(modules.IToolState, toolState),
      e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
    );
  });

  const orgPath = e.Effect.fn(function*(repoId: RepoIdentifier) {
    return yield* repoId.orgPath().pipe(
      e.Effect.provideService(modules.IToolState, toolState),
      e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
    );
  });

  const listLocalOrgs = e.Effect.gen(function*() {
    const { workspaceRoot } = yield* e.pipe(
      toolState.assertInWorkspace,
      e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
    );
    const entries = yield* e.pipe(
      fileSystem.readDirectory(workspaceRoot),
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new modules.BadPreconditionsError({
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
        isDirectory,
        e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new modules.BadPreconditionsError({
          cause: `Failed to determine if potential org at ${orgDir} is a directory due to unexpected ${name}`,
          fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
        }))
      );
      if (entryIsDirectory) {
        orgs.push(entry.slice(1));
      }
    }
    return orgs;
  });

  const listLocalRepos = e.Effect.fn(function*(org: string) {
    const dummyRepoId = new RepoIdentifier(org, "fake-repo");
    const orgDoesNotExistError = new modules.BadArgumentError({
      argument: "org",
      reason: `Org ${dummyRepoId.orgName()} does not exist in this workspace`
    });
    const orgDir = yield* orgPath(dummyRepoId);
    const orgIsDirectory = yield* e.pipe(
      orgDir.absolute,
      isDirectory,
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new modules.BadPreconditionsError({
        cause: `Failed to determine if potential org at ${orgDir} is a directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    if (!orgIsDirectory) {
      return yield* orgDoesNotExistError;
    }
    const repos = yield* e.pipe(
      fileSystem.readDirectory(orgDir.absolute),
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new modules.BadPreconditionsError({
        cause: `Failed to read org at ${orgDir} due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    const repoIds: RepoIdentifier[] = 
      repos.sort()
      .map(repo => new RepoIdentifier(org, repo));
    return repoIds;
  });

  const getSubmodules = e.Effect.fn(function*() {
    yield* toolState.assertInWorkspace;
    const {stdout, stderr} = yield* hostShell.run("git", "submodule status", IN.WorkspaceRoot()).captureOutput;
    const submodules = yield* e.Effect.all(stdout
      .split("\n")
      .map(line => line.split(" "))
      .map(([commitSha, relPath]) => relPath ?? "")
      .filter(relPath => relPath.length)
      .map(RepoIdentifier.fromRelativePath));
    return submodules;
  }, e.flow(
    e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
  ));

  const submoduleExists = e.Effect.fn(function*(repoId: RepoIdentifier) {
    yield* toolState.assertInWorkspace;
    // First verify org as dir
    const orgLocation = yield* orgPath(repoId);
    const orgIsDir = yield* e.pipe(
      orgLocation.absolute,
      isDirectory,
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new modules.BadPreconditionsError({
        cause: `Failed to determine if potential org at ${orgLocation} is a directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    if (!orgIsDir) {
      return false;
    }
    // Next verify repo as dir
    const repoLocation = yield* repoPath(repoId);
    const repoIsDir = yield* e.pipe(
      repoLocation.absolute,
      isDirectory,
      e.Effect.catchTag("BadArgument", "SystemError", ({name, message}) => new modules.BadPreconditionsError({
        cause: `Failed to determine if potential repo at ${repoLocation} is a directory due to unexpected ${name}`,
        fix: `Report bug to ${TOOL_NAME} maintainers; internal error: ${message}`
      }))
    );
    if (!repoIsDir) {
      return false;
    }
    // Finally verify that it is a submodule
    const submodules = yield* getSubmodules();
    return submodules.filter(RepoIdentifier.prototype.equals).length > 0;
  }, e.flow(
    e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
  ));

  const configureGitRepo = e.Effect.fn(function*({org, repo, relative}: {org: string; repo: string; relative: string;}, user: CurrentUser) {
    // TODO: ensure this path is an actual git repo.
    const gitConfig = e.Effect.fn(function*(config: Record<string, string>) {
      for (const [k, v] of Object.entries(config)) {
        yield* hostShell.run("git", `config --local ${k} ${v}`, IN.RelativeDirectory({relative})).inheritIO;
      }
    });
    yield* gitConfig({
      "user.name": user.username,
      "user.email": user.email,
      "credential.helper": credentialHelperExecutablePath(),
      "credential.useHttpPath": "true",
      "gpg.format": "ssh",
      "commit.gpgSign": "true",
      "core.sshCommand": sshCommand(user.sshKey.location),
      "user.signingKey": user.sshKey.location
    });
    yield* hostShell.run("git", `remote set-url origin ${httpsRepoUrl({org, repo})}`, IN.RelativeDirectory({relative})).inheritIO;
    yield* hostShell.run("git", `remote set-url --push origin ${sshRepoUrl({org, repo})}`, IN.RelativeDirectory({relative})).inheritIO;
  });

  const configureSubmodule = e.Effect.fn(function*(repo: RepoIdentifier, user: CurrentUser) {
    const exists = yield* submoduleExists(repo);
    if (!exists) {
      return yield* new modules.BadArgumentError({
        argument: "repo",
        reason: `Repo ${repo.packageName()} is not a submodule`
      });
    }
    const {relative} = yield* repoPath(repo);
    yield* configureGitRepo({relative, org: repo.org, repo: repo.repo}, user);
  });

  return {
    localOrgs: listLocalOrgs,
    localRepos: listLocalRepos,
    submoduleExists,
    cloneAsSubmodule: e.Effect.fn(function*(repo: RepoIdentifier, user: CurrentUser) {
      const { relative } = yield* repoPath(repo);
      yield* hostShell.run("git", [
        `-c credential.helper=${credentialHelperExecutablePath()}`,
        `-c credential.useHttpPath=true`,
        `submodule add ${httpsRepoUrl(repo)} ${relative}`,
      ].join(" "), IN.WorkspaceRoot()).inheritIO;
      yield* configureSubmodule(repo, user);
    }),
    configureWorkspace: e.Effect.fn(function*(user) { 
      const { workspaceRoot } = yield* toolState.assertInWorkspace;
      const args = "config --get remote.origin.url";
      const { stderr, stdout } = yield* hostShell.run("git", args, IN.WorkspaceRoot()).captureOutput;
      const [firstLine] = stdout.split("\n");
      if (!firstLine) {
        return yield* new modules.BadPreconditionsError({
          cause: `Invalid root workspace at ${workspaceRoot}. \`git ${args}\` returned no results`,
          fix: `Configure the "origin" remote in this git repo`
        });
      }
      // It could be either an ssh or http remote.
      const {owner, name} = parseGitRemote(firstLine);
      if (!owner) {
        return yield* new modules.BadPreconditionsError({
          cause: `Invalid org in origin remote for root workspace ${workspaceRoot}. Remote was ${firstLine}`,
          fix: `Reconfigure the "origin" remote in this repo to something valid`
        });
      }
      if (!name) {
        return yield* new modules.BadPreconditionsError({
          cause: `Invalid repo name in origin remote for root workspace ${workspaceRoot}. Remote was ${firstLine}`,
          fix: `Reconfigure the "origin" remote in this repo to something valid`
        });
      }
      yield* configureGitRepo({org: owner, repo: name, relative: ""}, user);
    }, e.flow(
      e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
    )),
    configureSubmodule,
    removeSubmodule: e.Effect.fn(function*(repo: RepoIdentifier) {
      const {absolute, relative} = yield* repoPath(repo);
      yield* hostShell.run("git", `submodule deinit -f ${relative}`, IN.WorkspaceRoot()).inheritIO;
      yield* hostShell.run("git", `rm -f ${relative}`, IN.WorkspaceRoot()).inheritIO;
      yield* hostShell.run("rm", `-rf .git/modules/${relative}`, IN.WorkspaceRoot(), {usingBunShell: true}).inheritIO;
      // TODO: it might be necessary to rm -rf the absolute folder.
      // TODO: I noticed that .git/modules can become out of sync with where the submodules actually are.
      //       There should ideally be a cleanup task run on configure, remove, and clone.
      // TODO: should we be committing the jive repo after the unload is done? Seems like maybe.
    }),
    getSubmodules: e.Effect.gen(function*() {
      return yield* getSubmodules();
    }),
  };
}));
