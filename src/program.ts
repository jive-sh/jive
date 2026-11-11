import * as e from "effect";
import * as path from "node:path";
import { Cli, OSPlatform, daemonStatuses, upgrade } from "jive-abstract-library";
import { PACKAGE_NAME, TOOL_NAME } from "@/constants";
import { BadArgumentError, BadPreconditionsError, NotLoggedInError } from "@/errors";
import { modules } from "@/modules";
import { LinkResult, LinkScope, type WorkspaceLink } from "@/modules/bun/interface";
import { sshArgumentsThroughAgent, sshKeygenEnvironmentThroughAgent } from "@/modules/signing-agent/ssh-clients";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/** Tab after an org lists the repos already loaded under it in this workspace. */
const loadedRepoChoice = (description: string, next: (repo: RepoIdentifier) => Cli.Node) => (org: string) =>
  Cli.choose({
    description,
    *choices() {
      const repos = yield* (yield* modules.git).localRepos(org);
      return repos.map(repo => repo.repo);
    },
    next: (repo) => next(new RepoIdentifier(org, repo)),
  });

const workspaceOrgChoice = (description: string, next: (org: string) => Cli.Node) =>
  Cli.choose({
    description,
    *choices() { return yield* (yield* modules.git).localOrgs(); },
    next,
  });

export const jive = Cli.make(TOOL_NAME, {
  load: Cli.choose({
    description: "clone a GitHub repo into this workspace as a submodule, install it, and link it with the workspace's packages",
    *choices() { return yield* (yield* modules.git).localOrgs(); },
    next: (org) => Cli.choose({
      description: "a repo of the org on GitHub",
      // Listing an org's repos needs a GitHub sign-in, which jive no longer has; the name is typed.
      *choices() { return []; },
      next: (repo) => Cli.command({
        description: `clone ${org}/${repo} to @${org}/${repo}`,
        *run() {
          const chosenRepo = new RepoIdentifier(org, repo);
          const git = yield* modules.git;
          const bun = yield* modules.bun;
          yield* git.cloneAsSubmodule(chosenRepo, yield* accountKey());
          const { relativePath, absolutePath } = yield* (yield* modules.toolState).repoPath(chosenRepo);
          yield* e.Effect.log(`Cloned ${chosenRepo.toString()} to ${relativePath}`);
          yield* bun.install(chosenRepo);
          const { workspaceRoot, repositories } = yield* workspaceRepositories();
          yield* logLinks({ workspaceRoot, links: yield* bun.linkWorkspace({ repositories, scope: LinkScope.Touching({ directory: absolutePath }) }) });
        },
      }),
    }),
  }),

  unload: workspaceOrgChoice("remove a loaded repo from this workspace", loadedRepoChoice("a repo loaded in this workspace", (repo) => Cli.command({
    description: `remove ${repo.packageName()} from this workspace`,
    *run() {
      const { absolutePath } = yield* (yield* modules.toolState).repoPath(repo);
      const { repositories } = yield* workspaceRepositories();
      const reinstalled = yield* (yield* modules.bun).unlinkPackage({ repositories, packageDirectory: absolutePath });
      if (reinstalled.length > 0) yield* e.Effect.log(`${repo.packageName()} unlinked from ${reinstalled.join(", ")}, which have their registry copy back`);
      yield* (yield* modules.git).removeSubmodule(repo);
    },
  }))),

  on: workspaceOrgChoice("run a command in a loaded repo's directory", loadedRepoChoice("a repo loaded in this workspace", (repo) => Cli.command({
    description: `run a command in ${repo.packageName()}'s directory; put -- before the command's own flags`,
    *run({ args }) {
      const [command, ...commandArgs] = args;
      if (command === undefined) {
        return yield* new BadArgumentError({ argument: "command", reason: `give the command to run after ${repo.org} ${repo.repo}` });
      }
      const { absolutePath } = yield* (yield* modules.toolState).verifyRepoIntegrity(repo);
      yield* runInThisTerminal({ command, args: commandArgs, cwd: absolutePath });
    },
  }))),

  ssh: {
    connect: Cli.passThroughCommand({
      description: "run ssh with your Jive account key, through jive's agent, and no other key; every word after connect goes to ssh, e.g. `connect git@github.com` or `connect user@host -p 2222`",
      *run({ args }) {
        const { publicKeyFile } = yield* accountKeyOnThisMachine();
        const homeDirectory = yield* (yield* OSPlatform).getHomeDirectory();
        yield* runInThisTerminal({ command: "ssh", args: [...sshArgumentsThroughAgent({ homeDirectory, publicKeyFile }), ...args] });
      },
    }),
    sign: Cli.passThroughCommand({
      description: "sign with your Jive account key, through jive's agent: runs `ssh-keygen -Y sign -f <your account.pub>` with the words after sign, e.g. `sign -n file notes.txt` writes notes.txt.sig",
      *run({ args }) {
        const { publicKeyFile } = yield* accountKeyOnThisMachine();
        const homeDirectory = yield* (yield* OSPlatform).getHomeDirectory();
        const inherited = yield* e.Effect.sync(() => process.env);
        yield* runInThisTerminal({
          command: "ssh-keygen",
          args: ["-Y", "sign", "-f", publicKeyFile, ...args],
          env: sshKeygenEnvironmentThroughAgent({ inherited, homeDirectory }),
        });
      },
    }),
  },

  login: Cli.command({
    description: "sign in to Jive with your jive.sh passkey and fetch your account's public key, which git signing and pushes use",
    flags: {
      cicd: Cli.flag.boolean({ description: "in a CI/CD job: exchange the job's GitHub OIDC token for a session of its pipeline" }),
    },
    *run({ flags }) {
      const sessions = yield* modules.session;
      const session = yield* e.pipe(
        e.Effect.gen(() => flags.cicd ? sessions.signInAsPipeline() : sessions.signIn()),
        e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: `Sign-in did not finish: ${reason}`, fix: flags.cicd ? "Fix what the reason names, then run the job again" : `Run \`${TOOL_NAME} login\` again` })),
      );
      const ends = new Date(session.expiresAt).toLocaleString();
      if (flags.cicd) return yield* e.Effect.log(`Signed in to Jive until ${ends}`);
      // A person's session moves its end a day on with each use, on the server.
      yield* e.Effect.log(`Signed in to Jive; the session ends ${ends} unless this machine uses it before then`);
      // A person's machine signs with the account key, which lives on the server; this keeps its public half.
      const accountKeys = yield* modules.accountKey;
      const { publicKeyFile } = yield* e.pipe(
        e.Effect.gen(() => accountKeys.ensure()),
        e.Effect.mapError(({ reason }) => BadPreconditionsError.withoutFix("Could not fetch your account's SSH key", reason)),
      );
      yield* e.Effect.log(`Your account's public key is at ${publicKeyFile}`);
    },
  }),

  whoami: Cli.command({
    description: "print the handle of the Jive account this machine is signed in as",
    *run() {
      const sessions = yield* modules.session;
      const maybeSession = yield* sessions.current();
      if (e.Option.isNone(maybeSession)) {
        return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
      }
      const maybeAccount = yield* e.pipe(
        e.Effect.gen(() => sessions.checkWithServer(maybeSession.value)),
        e.Effect.mapError(({ reason }) => BadPreconditionsError.withoutFix("Could not reach the Jive server", reason)),
      );
      if (e.Option.isNone(maybeAccount)) {
        return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({ reason: "Jive ended this machine's session" }));
      }
      yield* e.Effect.log(maybeAccount.value.username);
    },
  }),

  init: Cli.command({
    description: "make every repository here sign with your Jive account key and fetch and push over SSH through jive's agent; .gitmodules on https, every submodule checked out, and the packages among them linked with each other",
    *run() {
      const git = yield* modules.git;
      const root = yield* git.repositoryRoot(yield* (yield* OSPlatform).getCurrentDirectory());
      const key = yield* accountKey();
      const rewritten = yield* git.checkOutSubmodulesOverHttps(root, key);
      const repositories = yield* git.repositoriesUnder(root);
      for (const repository of repositories) {
        yield* git.configureRepository(repository, key);
      }
      yield* e.Effect.log(`${rewritten} submodule URL${rewritten === 1 ? "" : "s"} moved to https; ${repositories.length} repositor${repositories.length === 1 ? "y signs" : "ies sign"} with your Jive account key and fetch and push over SSH through jive's agent`);
      yield* logLinks({ workspaceRoot: root, links: yield* (yield* modules.bun).linkWorkspace({ repositories, scope: LinkScope.Workspace() }) });
    },
  }),

  provision: Cli.command({
    description: "make sure a resource instance exists, e.g. `provision connector-package-registry @scope/name`; the organization's configured implementation does it",
    flags: {
      instance: Cli.flag.string({ description: "the instance as JSON, in place of the one ./package.json declares under jive.resources.<kind>.<name>" }),
    },
    *run({ args: [kind, name], flags }) {
      if (kind === undefined || name === undefined) {
        return yield* new BadArgumentError({ argument: "kind and instance", reason: `give both, e.g. \`${TOOL_NAME} provision connector-package-registry @scope/name\`` });
      }
      const instance = yield* e.Option.match(flags.instance, {
        onSome: (json) => parseInstance(json),
        onNone: () => declaredInstance(kind, name),
      });
      const { instanceId } = yield* e.pipe(
        e.Effect.gen(function* () { return yield* (yield* modules.provisioning).ensure({ kind, instance }); }),
        e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: reason, fix: "" })),
      );
      yield* e.Effect.log(`${kind} ${name} is ready (${instanceId})`);
    },
  }),

  daemons: Cli.command({
    description: "list every Jive daemon registered on this machine, with where its executable lives",
    *run() {
      const statuses = yield* daemonStatuses;
      if (statuses.length === 0) {
        yield* e.Effect.log("No Jive daemons are registered.");
        return;
      }
      for (const { registration, state, pid, executableExists } of statuses) {
        const pidText = e.Option.match(pid, { onNone: () => "", onSome: (value) => ` (pid ${value})` });
        yield* e.Effect.log([
          `${registration.name} — ${registration.packageName}: ${state}${pidText}`,
          `  executable ${registration.executable}${executableExists ? "" : " (missing: this registration is stale)"}`,
          `  log        ${registration.logPath}`,
        ].join("\n"));
      }
    },
  }),

  upgrade: Cli.command({
    description: `upgrade ${TOOL_NAME} to its latest version with the package manager that installed it`,
    *run() {
      yield* e.pipe(
        upgrade({ packageName: PACKAGE_NAME }),
        e.Effect.mapError((reason) => BadPreconditionsError.withoutFix(`Could not upgrade ${PACKAGE_NAME}`, reason)),
      );
    },
  }),
});

const parseInstance = (json: string): e.Effect.Effect<unknown, BadArgumentError> =>
  e.Effect.try({
    try: () => JSON.parse(json) as unknown,
    catch: () => new BadArgumentError({ argument: "--instance", reason: "is not JSON" }),
  });

/** The instance `./package.json` declares as `jive.resources.<kind>.<name>`. */
const DeclaredResources = e.Schema.fromJsonString(e.Schema.Struct({
  jive: e.Schema.Struct({
    resources: e.Schema.Record(e.Schema.String, e.Schema.Record(e.Schema.String, e.Schema.Unknown)),
  }),
}));

const declaredInstance = (kind: string, name: string): e.Effect.Effect<unknown, BadArgumentError, e.FileSystem.FileSystem> =>
  e.Effect.gen(function* () {
    const notDeclared = new BadArgumentError({
      argument: "instance",
      reason: `./package.json declares no jive.resources["${kind}"]["${name}"]; declare it there, or pass --instance '<json>'`,
    });
    const contents = yield* e.pipe((yield* e.FileSystem.FileSystem).readFileString("package.json"), e.Effect.mapError(() => notDeclared));
    const declared = yield* e.pipe(e.Schema.decodeUnknownEffect(DeclaredResources)(contents), e.Effect.mapError(() => notDeclared));
    const instance = declared.jive.resources[kind]?.[name];
    return instance === undefined ? yield* notDeclared : instance;
  });

/** The account's key, signing in to Jive first when there is no session (`jive login`'s passkey sign-in). */
function accountKey() {
  return e.Effect.gen(function* () {
    const accountKeys = yield* modules.accountKey;
    return yield* e.pipe(
      e.Effect.gen(() => accountKeys.ensure()),
      e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: reason, fix: `Run \`${TOOL_NAME} login\`, then this again` })),
    );
  });
}

/** The account key this machine keeps, fetched first as `accountKey()` does when it keeps none. */
function accountKeyOnThisMachine() {
  return e.Effect.gen(function* () {
    const maybeKept = yield* (yield* modules.accountKey).cached();
    return e.Option.isSome(maybeKept) ? maybeKept.value : yield* accountKey();
  });
}

/**
 * Runs a command on this terminal, its input and output being the person's own, and passes its exit code on as
 * jive's. The command shows its own errors, so a nonzero exit adds nothing to them.
 */
function runInThisTerminal({ command, args, cwd, env }: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}) {
  return e.Effect.gen(function* () {
    const osPlatform = yield* OSPlatform;
    if (e.Option.isNone(yield* osPlatform.findExecutable(command))) {
      return yield* BadPreconditionsError.commandNotFound(command);
    }
    const { exitCode } = yield* e.pipe(
      e.Effect.gen(() => osPlatform.spawnProcess({ command, args, cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })),
      e.Effect.mapError(message => BadPreconditionsError.withoutFix(`Failed to run ${command}`, message)),
    );
    if (exitCode !== 0) {
      return yield* new Cli.CliError({ message: `${command} exited with code ${exitCode}`, exitCode });
    }
  });
}

/** The workspace's root and every repository in it: its submodules at any depth and the clones git doesn't track. */
function workspaceRepositories() {
  return e.Effect.gen(function* () {
    const { workspaceRoot } = yield* e.pipe(
      e.Effect.gen(function* () { return yield* (yield* modules.toolState).assertInWorkspace(); }),
      e.Effect.mapError(BadPreconditionsError.fromNotInWorkspaceError),
    );
    return { workspaceRoot, repositories: yield* (yield* modules.git).repositoriesUnder(workspaceRoot) };
  });
}

/** One line per link made or not made, then a count, so a person sees which packages run their checkout. */
function logLinks({ workspaceRoot, links }: { readonly workspaceRoot: string; readonly links: ReadonlyArray<WorkspaceLink> }) {
  return e.Effect.gen(function* () {
    const rebuild = `run \`bun run jive:cicd:build\` in it, then \`${TOOL_NAME} init\``;
    for (const link of links) {
      const into = `${link.dependency} into ${link.dependent}`;
      yield* e.Effect.log(e.pipe(link.result, LinkResult.$match({
        Linked: ({ target }) => `Linked ${into}: ${path.relative(workspaceRoot, target)} (${link.checkoutVersion}${link.specifierSatisfied ? "" : `, which ${link.dependent}'s pin ${link.specifier} doesn't allow; its CI installs the pin`})`,
        LocalSpecifier: () => `Left ${into}: it asks for ${link.specifier} itself`,
        NotInstalled: () => `Left ${into}: bun install hasn't installed it there`,
        NotBuilt: () => `Left ${into}: ${link.dependency} has no build; ${rebuild}`,
        StaleBuild: ({ builtVersion }) => `Left ${into}: ${link.dependency}'s build is ${builtVersion} and its checkout ${link.checkoutVersion}; ${rebuild}`,
        SameName: ({ directories }) => `Left ${into}: ${directories.map(directory => path.relative(workspaceRoot, directory)).join(" and ")} are both ${link.dependency}`,
      })));
    }
    const linked = links.filter(link => link.result._tag === "Linked").length;
    yield* e.Effect.log(`${linked} workspace link${linked === 1 ? "" : "s"} in place; ${links.length - linked} left as installed`);
  });
}
