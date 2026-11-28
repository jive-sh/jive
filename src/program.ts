import * as e from "effect";
import * as path from "node:path";
import { Cli, OSPlatform, daemonStatuses, repairDaemonRecords, upgrade } from "jive-abstract-library";
import { renderTemplate, templateInputNames } from "jive-abstract-abstraction";
import { PACKAGE_NAME, TOOL_NAME } from "@/constants";
import { BadArgumentError, BadPreconditionsError, NotLoggedInError, UsageError } from "@/errors";
import { modules } from "@/modules";
import { AbstractSource } from "@/modules/abstracts/interface";
import { abstractNameForKind, newPackageName, parseCreateArguments, pinAbstractDependency } from "@/modules/abstracts/new-package";
import { LinkResult, LinkScope, type WorkspaceLink } from "@/modules/bun/interface";
import { parseGitIdentity, type GitIdentity } from "@/modules/git/identity";
import { LoadOutcome } from "@/modules/git/interface";
import { accountKeyFailure } from "@/modules/account-key/interface";
import { jiveServerFailure } from "@/modules/jive-server/interface";
import { daemonProblem } from "@/modules/ssh-wrappers/signing-session";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";
import { packageRelativePath } from "@/modules/tool-state/workspace-layout";

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
    description: `\`${TOOL_NAME} load <org> <repo>\`: in a git repository, add the GitHub repo <org>/<repo> to the workspace, the nearest git repository from here up, as a submodule at packages/<its package name>, install it and link it with the workspace's packages; in no repository, clone it into ./<repo>. Either way it ends by running \`${TOOL_NAME} init\` in the repo it loaded`,
    *choices() { return yield* (yield* modules.git).localOrgs(); },
    // The repo is a word of the command, not a choice: listing an org's repos needs a GitHub sign-in, which jive doesn't have.
    next: (org) => Cli.command({
      description: `add the GitHub repo <repo> of ${org}: \`${TOOL_NAME} load ${org} <repo>\``,
      *run({ args }) {
        const [repo, ...extra] = args;
        if (repo === undefined || extra.length > 0) {
          const github = yield* modules.github;
          const orgAnswer = yield* e.Effect.result(e.Effect.gen(() => github.accountExists(org)));
          // GitHub not answering leaves it unknown, so only its definite "no such account" is said.
          const githubHasNoSuchOrg = e.Result.isSuccess(orgAnswer) && !orgAnswer.success;
          return yield* new UsageError({ command: ["load"], problems: githubHasNoSuchOrg ? [`No access to an org named ${org}`] : [] });
        }
        const chosenRepo = new RepoIdentifier(org, repo);
        const currentDirectory = yield* (yield* OSPlatform).getCurrentDirectory();
        if (e.Option.isNone(yield* (yield* modules.toolState).findWorkspaceRoot(currentDirectory))) {
          const destination = path.join(currentDirectory, repo);
          // The echoed `git clone` shows where it goes.
          yield* (yield* modules.git).clone({ repo: chosenRepo, directory: destination });
          return yield* initialize({ directory: destination, maybeGitIdentity: e.Option.none() });
        }
        // The identity and the sign-in come before anything is written, so either failing leaves the workspace as it was.
        const gitIdentity = yield* workspaceGitIdentity();
        yield* accountKey();
        const git = yield* modules.git;
        const { packageName, location, outcome } = yield* git.loadAsSubmodule(chosenRepo);
        yield* e.Effect.log(e.pipe(outcome, LoadOutcome.$match({
          Cloned: () => `Cloned ${org}/${repo} and staged it as a submodule`,
          Adopted: () => `Added the checkout of ${org}/${repo} already there as a submodule and staged it`,
          AlreadyLoaded: () => `${org}/${repo} is already the submodule there`,
        })));
        const { workspaceRoot, repositories } = yield* workspaceRepositories();
        // The workspace's .gitmodules, which the new entry joined: its other GitHub URLs move to https too, unstaged.
        const rewritten = yield* git.useHttpsSubmoduleUrls(workspaceRoot);
        if (rewritten > 0) yield* e.Effect.log(`Moved ${rewritten} other submodule URL${rewritten === 1 ? "" : "s"} in ${path.join(workspaceRoot, ".gitmodules")} to https`);
        const bun = yield* modules.bun;
        yield* bun.install({ directory: location.absolutePath, packageName });
        yield* logLinks({ workspaceRoot, links: yield* bun.linkWorkspace({ repositories, scope: LinkScope.Touching({ directory: location.absolutePath }) }) });
        yield* initialize({ directory: location.absolutePath, maybeGitIdentity: e.Option.some(gitIdentity) });
      },
    }),
  }),

  create: Cli.passThroughCommand({
    description: "make a new package at packages/<its package name> from the template of the abstract a kind names: `create library` uses jive-abstract-library's, `create agentic workflow` jive-abstract-agentic-workflow's; give each input the template asks for as --<input> <value>, or answer when asked",
    *run({ args }) {
      const { kindWords, flags } = yield* fromResult(parseCreateArguments(args), "arguments");
      const abstractName = yield* fromResult(abstractNameForKind(kindWords), "kind");
      const { workspaceRoot } = yield* e.pipe(
        e.Effect.gen(function* () { return yield* (yield* modules.toolState).assertInWorkspace(); }),
        e.Effect.mapError(BadPreconditionsError.fromNotInWorkspaceError),
      );
      const abstract = yield* e.pipe(
        e.Effect.gen(function* () { return yield* (yield* modules.abstracts).get({ name: abstractName, workspaceRoot }); }),
        e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: `Cannot create a package from ${abstractName}: ${reason}`, fix: "" })),
      );
      const inputNames = templateInputNames(abstract.replacements);
      yield* e.Effect.log(`Creating from ${abstract.name} ${abstract.version}, ${e.pipe(abstract.source, AbstractSource.$match({
        Workspace: ({ directory }) => `the workspace's build at ${path.relative(workspaceRoot, directory)}`,
        Registry: ({ tarballUrl }) => `downloaded from ${tarballUrl}`,
      }))}; its template asks for ${inputNames.join(", ")}`);

      const unknownFlags = Object.keys(flags).filter((name) => !inputNames.includes(name));
      if (unknownFlags.length > 0) {
        return yield* new BadArgumentError({ argument: unknownFlags.map((name) => `--${name}`).join(", "), reason: `${abstract.name}'s template asks for ${inputNames.map((name) => `--${name}`).join(", ")}` });
      }
      const inputs: Record<string, string> = {};
      for (const inputName of inputNames) {
        inputs[inputName] = Object.hasOwn(flags, inputName) ? flags[inputName]! : yield* askFor(inputName);
      }

      const rendered = yield* e.pipe(
        renderTemplate({ files: abstract.templateFiles, inputs }),
        e.Effect.mapError((reason) => BadPreconditionsError.withoutFix(`Cannot render ${abstract.name}'s template`, reason)),
      );
      const files = pinAbstractDependency({ files: rendered, abstractName: abstract.name, version: abstract.version });
      const packageName = yield* fromResult(newPackageName(files), "inputs");
      const relativeDestination = packageRelativePath(packageName);
      const destination = path.join(workspaceRoot, relativeDestination);
      const fs = yield* e.FileSystem.FileSystem;
      const fsFailure = ({ message }: { readonly message: string }) => BadPreconditionsError.withoutFix(`Cannot write ${relativeDestination}`, message);
      if (yield* e.pipe(fs.exists(destination), e.Effect.mapError(fsFailure))) {
        return yield* new BadPreconditionsError({ cause: `${relativeDestination} already exists`, fix: `Remove it, or create the package under another name` });
      }
      for (const file of files) {
        const target = path.join(destination, ...file.path.split("/"));
        yield* e.pipe(fs.makeDirectory(path.dirname(target), { recursive: true }), e.Effect.mapError(fsFailure));
        yield* e.pipe(fs.writeFileString(target, file.contents), e.Effect.mapError(fsFailure));
      }
      yield* e.Effect.log(`Created ${packageName} at ${relativeDestination} (${files.length} files). It is not a repository yet: create its GitHub repo, then \`${TOOL_NAME} load <org> <repo>\` adds it to this workspace`);
    },
  }),

  unload: workspaceOrgChoice("remove a loaded repo from this workspace", loadedRepoChoice("a repo loaded in this workspace", (repo) => Cli.command({
    description: `remove ${repo.packageName()} from this workspace`,
    *run() {
      const { location: { absolutePath } } = yield* (yield* modules.git).loadedRepository(repo);
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
      const { location: { absolutePath } } = yield* (yield* modules.git).loadedRepository(repo);
      yield* runInThisTerminal({ command, args: commandArgs, cwd: absolutePath });
    },
  }))),

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
      // Asking whose session it is also saves the username, so jive-daemon can say who is signed in while offline.
      const maybeAccount = yield* e.pipe(
        e.Effect.gen(() => sessions.checkWithServer(session)),
        e.Effect.mapError((error) => BadPreconditionsError.withoutFix("Signed in, but could not ask Jive whose session it is", jiveServerFailure(error))),
      );
      if (e.Option.isNone(maybeAccount)) {
        return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({ reason: "Jive ended the new session at once" }));
      }
      // A person's session moves its end a day on with each use, on the server.
      yield* e.Effect.log(`Signed in to Jive as ${maybeAccount.value.username}; the session ends ${ends} unless this machine uses it before then`);
      // A person's machine signs with the account key, which lives on the server; this keeps its public half.
      const accountKeys = yield* modules.accountKey;
      const { publicKeyFile } = yield* e.pipe(
        e.Effect.gen(() => accountKeys.ensure()),
        e.Effect.mapError((error) => BadPreconditionsError.withoutFix("Could not fetch your account's SSH key", accountKeyFailure(error))),
      );
      yield* e.Effect.log(`Your account's public key is at ${publicKeyFile}`);
    },
  }),

  whoami: Cli.command({
    description: "print the handle of the Jive account this machine is signed in as, as jive-daemon reports it",
    *run() {
      const daemonClient = yield* modules.daemonClient;
      const answer = yield* e.Effect.result(e.Effect.gen(() => daemonClient.getSession()));
      if (e.Result.isFailure(answer)) return yield* new BadPreconditionsError(daemonProblem(answer.failure));
      const status = answer.success;
      if (status._tag !== "SignedIn") return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
      const account = status.username !== undefined ? status.username : "an account whose name this machine has not saved yet";
      yield* e.Effect.log(status.confirmedByServer ? account : `${account} (not confirmed: can't reach Jive's server)`);
    },
  }),

  init: Cli.command({
    description: "set up the git repository you are in, the nearest one from here up, as a jive workspace, changing none of its files but .gitmodules: every .gitmodules already there moved to https, every submodule checked out, and it, every submodule and every repository inside it that git doesn't track commit as the workspace's git identity (the root's user.name and user.email, asked for the first time), sign with your Jive account key and fetch and push over SSH through jive's agent; the packages among them are linked with each other. A folder in no repository becomes a new one, on main",
    *run() {
      yield* initialize({ directory: yield* (yield* OSPlatform).getCurrentDirectory(), maybeGitIdentity: e.Option.none() });
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
    description: "list every Jive daemon registered on this machine, with where its executable lives, after repairing any broken registration record",
    *run() {
      yield* repairDaemonRecords;
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

/** A step's result, its failure being the person's argument `argument` that it names. */
const fromResult = <A>(result: e.Result.Result<A, string>, argument: string): e.Effect.Effect<A, BadArgumentError> =>
  e.Result.isSuccess(result) ? e.Effect.succeed(result.success) : e.Effect.fail(new BadArgumentError({ argument, reason: result.failure }));

/** Asks on the terminal for an input the person did not give as a flag. */
const askFor = (inputName: string): e.Effect.Effect<string, BadArgumentError | BadPreconditionsError, e.Terminal.Terminal> =>
  e.Effect.gen(function* () {
    const terminal = yield* e.Terminal.Terminal;
    yield* e.pipe(terminal.display(`${inputName}: `), e.Effect.mapError(({ message }) => BadPreconditionsError.withoutFix("Cannot write to the terminal", message)));
    const answer = (yield* e.pipe(terminal.readLine, e.Effect.mapError(() => new BadArgumentError({ argument: `--${inputName}`, reason: "not given, and the terminal gave no answer" })))).trim();
    if (answer === "") return yield* new BadArgumentError({ argument: `--${inputName}`, reason: "is empty" });
    return answer;
  });

/** A workspace root whose own git config sets no `user.name` and `user.email`: `jive init` in a terminal asks for them. */
const noWorkspaceGitIdentity = ({ root, reason }: { readonly root: string; readonly reason: string }) => new BadPreconditionsError({
  cause: `${root} has no git identity: its own git config sets no user.name and user.email${reason}`,
  fix: `Run \`${TOOL_NAME} init\` in ${root} in a terminal: it asks for the name and email this workspace's commits carry`,
});

/**
 * The workspace's git identity, from its root repository's own git config (`jive load` copies it into each repo it
 * adds). A workspace has one; a second persona is a second workspace.
 */
function workspaceGitIdentity() {
  return e.Effect.gen(function* () {
    const { workspaceRoot } = yield* e.pipe(
      e.Effect.gen(function* () { return yield* (yield* modules.toolState).assertInWorkspace(); }),
      e.Effect.mapError(BadPreconditionsError.fromNotInWorkspaceError),
    );
    const maybeIdentity = yield* (yield* modules.git).localIdentity(workspaceRoot);
    if (e.Option.isNone(maybeIdentity)) return yield* noWorkspaceGitIdentity({ root: workspaceRoot, reason: "" });
    return maybeIdentity.value;
  });
}

/**
 * `root`'s git identity for `jive init`: the one its own git config sets, or else a name and email asked for on the
 * terminal, which init then writes into every repository it configures, the root first.
 */
function workspaceGitIdentityOrAsk(root: string) {
  return e.Effect.gen(function* () {
    const maybeIdentity = yield* (yield* modules.git).localIdentity(root);
    if (e.Option.isSome(maybeIdentity)) {
      yield* e.Effect.log(`Using the workspace's git identity, ${maybeIdentity.value.name} <${maybeIdentity.value.email}>, from ${root}'s git config`);
      return maybeIdentity.value;
    }
    const prompt = yield* modules.prompt;
    const noTerminal = () => noWorkspaceGitIdentity({ root, reason: ", and there is no terminal to ask for one" });
    yield* e.Effect.log(`${root} has no git identity yet; the name and email you give are what this workspace's commits carry`);
    const name = yield* e.pipe(e.Effect.gen(() => prompt.ask("Name:")), e.Effect.mapError(noTerminal));
    const email = yield* e.pipe(e.Effect.gen(() => prompt.ask("Email:")), e.Effect.mapError(noTerminal));
    return yield* fromResult(parseGitIdentity({ name, email }), "git identity");
  });
}

/**
 * `jive init` in `directory`: sets up the nearest git repository from there up, or makes `directory` a new one on
 * main when it is in none. The identity is `maybeGitIdentity` when `jive load` passes the workspace's, or else the
 * root's own, asked for when it has none. It writes git config and checks out submodules; the only files it changes
 * are the .gitmodules already there, whose GitHub URLs it moves to https (Alex, 2026-11-25: "init only if .gitmodules
 * already exists").
 */
function initialize({ directory, maybeGitIdentity }: { readonly directory: string; readonly maybeGitIdentity: e.Option.Option<GitIdentity> }) {
  return e.Effect.gen(function* () {
    const git = yield* modules.git;
    const maybeRoot = yield* (yield* modules.toolState).findWorkspaceRoot(directory);
    const root = e.Option.isSome(maybeRoot) ? maybeRoot.value : directory;
    // The identity and the sign-in come before anything is written, so either failing leaves the folder as it was.
    const gitIdentity = e.Option.isSome(maybeGitIdentity) ? maybeGitIdentity.value : yield* workspaceGitIdentityOrAsk(root);
    const key = yield* accountKey();
    if (e.Option.isNone(maybeRoot)) {
      yield* git.createRepository(directory);
      yield* e.Effect.log(`Made ${directory} a git repository on branch main`);
    }
    yield* e.Effect.log(`Setting up the workspace at ${root}`);
    const { rewritten, checkedOut } = yield* git.checkOutSubmodulesOverHttps(root);
    const repositories = yield* git.repositoriesUnder(root);
    for (const repository of repositories) {
      yield* git.configureRepository({ repository, settings: { accountKey: key, gitIdentity } });
    }
    yield* e.Effect.log(`${rewritten} submodule URL${rewritten === 1 ? "" : "s"} moved to https; ${checkedOut} submodule${checkedOut === 1 ? "" : "s"} checked out; ${repositories.length} repositor${repositories.length === 1 ? "y commits" : "ies commit"} as ${gitIdentity.name} <${gitIdentity.email}>, sign${repositories.length === 1 ? "s" : ""} with your Jive account key and fetch and push over SSH through jive's agent`);
    yield* logLinks({ workspaceRoot: root, links: yield* (yield* modules.bun).linkWorkspace({ repositories, scope: LinkScope.Workspace() }) });
  });
}

/** The account's key, signing in to Jive first when there is no session (`jive login`'s passkey sign-in). */
function accountKey() {
  return e.Effect.gen(function* () {
    const accountKeys = yield* modules.accountKey;
    return yield* e.pipe(
      e.Effect.gen(() => accountKeys.ensure()),
      e.Effect.mapError((error) => new BadPreconditionsError({ cause: accountKeyFailure(error), fix: `Run \`${TOOL_NAME} login\`, then this again` })),
    );
  });
}

/**
 * Runs a command on this terminal, its input and output being the person's own, and passes its exit code on as
 * jive's. The command shows its own errors, so a nonzero exit adds nothing to them.
 */
function runInThisTerminal({ command, args, cwd }: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}) {
  return e.Effect.gen(function* () {
    const osPlatform = yield* OSPlatform;
    if (e.Option.isNone(yield* osPlatform.findExecutable(command))) {
      return yield* BadPreconditionsError.commandNotFound(command);
    }
    const { exitCode } = yield* e.pipe(
      e.Effect.gen(() => osPlatform.spawnProcess({ command, args, ...(cwd === undefined ? {} : { cwd }), stdin: "inherit", stdout: "inherit", stderr: "inherit" })),
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
