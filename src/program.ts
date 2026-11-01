import * as e from "effect";
import { Cli, OSPlatform, daemonStatuses, upgrade } from "jive-abstract-library";
import { PACKAGE_NAME, TOOL_NAME } from "@/constants";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import { NotLoggedInError } from "@/modules/auth/interface";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/* TODO:
 * 1. On-device renaming should be supported if the YubiKey appears to have a default name on load.
 * 2. (Partially addressed) Commit signing and SSH auth now share one selected SSH key. Jive stores workspace-managed
 *    local keys under `.jive/ssh/local`, recovers resident keys from a selected YubiKey into a temp directory, persists
 *    only the chosen YubiKey handle under `.jive/users/`, uploads the same SSH public key to both GitHub auth-key and
 *    SSH-signing-key registries, and wires the private key into local git config.
 * 3. (Partially addressed) Repo reading now goes through `git-credential-jive`, submodule adds pass a credential-helper path
 *    derived from `process.execPath`, and the helper prefers stored repo-owner-scoped clone tokens when present before falling back to the broader OAuth token.
 *    New loads now warn and require confirmation before that broader fallback. Still TODO: mint/store GitHub App tokens and prompt about installing the app when possible.
 * 4. (Partially addressed) Loaded repos now keep HTTPS for pull/fetch, SSH for push, configure the credential helper locally, and wire
 *    the selected workspace-managed SSH key into local git signing and push-auth config.
 */

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
    description: "clone a GitHub repo into this workspace as a submodule, then install and link it",
    *choices() { return yield* (yield* modules.git).localOrgs(); },
    next: (org) => Cli.choose({
      description: "a repo of the org on GitHub",
      *choices() { return yield* (yield* modules.github).remoteRepos(org, e.Option.none()); },
      next: (repo) => Cli.command({
        description: `clone ${org}/${repo} to @${org}/${repo}`,
        *run() {
          const chosenRepo = new RepoIdentifier(org, repo);
          const git = yield* modules.git;
          const bun = yield* modules.bun;
          // TODO: warn if user has a permissive token rather than a scoped token
          const user = yield* (yield* modules.auth).ensureLoggedIn({ chooseNewUser: false });
          yield* git.cloneAsSubmodule(chosenRepo, user);
          const { relativePath } = yield* (yield* modules.toolState).repoPath(chosenRepo);
          yield* e.Effect.log(`Cloned ${chosenRepo.toString()} to ${relativePath}`);
          yield* bun.install(chosenRepo);
          yield* bun.link(chosenRepo);
        },
      }),
    }),
  }),

  unload: workspaceOrgChoice("remove a loaded repo from this workspace", loadedRepoChoice("a repo loaded in this workspace", (repo) => Cli.command({
    description: `remove ${repo.packageName()} from this workspace`,
    *run() {
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
      const osPlatform = yield* OSPlatform;
      if (e.Option.isNone(yield* osPlatform.findExecutable(command))) {
        return yield* BadPreconditionsError.commandNotFound(command);
      }
      const { exitCode } = yield* e.pipe(
        e.Effect.gen(() => osPlatform.spawnProcess({
          command, args: commandArgs, cwd: absolutePath, stdin: "inherit", stdout: "inherit", stderr: "inherit",
        })),
        e.Effect.mapError(message => BadPreconditionsError.withoutFix(`Failed to run ${command}`, message)),
      );
      if (exitCode !== 0) {
        // The command has shown its own output; jive only passes its exit code on.
        return yield* new Cli.CliError({ message: `${command} exited with code ${exitCode}`, exitCode });
      }
    },
  }))),

  create: Cli.choose({
    description: "create a repo from a template",
    *choices() { return yield* (yield* modules.templates).availableTemplates(); },
    next: (template) => Cli.command({
      *run({ args: [repo] }) {
        // TODO: scaffold repo from template, create on GitHub, link to workspace
        yield* e.Effect.log(`Creating ${repo} from template ${template}...`);
      },
    }),
  }),

  login: Cli.command({
    description: "sign in to Jive with your jive.sh passkey; git signing and pushes use this session",
    flags: {
      cicd: Cli.flag.boolean({ description: "in a CI/CD job: exchange the job's GitHub OIDC token for a session of its pipeline" }),
    },
    *run({ flags }) {
      const sessions = yield* modules.session;
      const session = yield* e.pipe(
        e.Effect.gen(() => flags.cicd ? sessions.signInAsPipeline() : sessions.signIn()),
        e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: `Sign-in did not finish: ${reason}`, fix: `Run \`${TOOL_NAME} login\` again` })),
      );
      yield* e.Effect.log(`Signed in to Jive until ${new Date(session.expiresAt).toLocaleString()}`);
    },
  }),

  whoami: Cli.command({
    description: "print the Jive account this machine is signed in as",
    *run() {
      const maybeSession = yield* (yield* modules.session).current();
      if (e.Option.isNone(maybeSession)) {
        return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
      }
      const jiveServer = yield* modules.jiveServer;
      const maybeAccount = yield* e.pipe(
        e.Effect.gen(() => jiveServer.accountOf(maybeSession.value)),
        e.Effect.mapError(({ reason }) => BadPreconditionsError.withoutFix("Could not reach the Jive server", reason)),
      );
      if (e.Option.isNone(maybeAccount)) {
        return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({ reason: "the session was revoked" }));
      }
      yield* e.Effect.log(`${maybeAccount.value.username}@jive.sh`);
    },
  }),

  git: {
    setup: Cli.command({
      description: "sign and push with your Jive account's key in this repo and its submodules; give owner/repo to clone it first",
      *run({ args: [ownerAndRepo] }) {
        const git = yield* modules.git;
        // Before anything opens a page: a bad argument, or no repository to set up, fails without a sign-in.
        const target = ownerAndRepo === undefined
          ? { _tag: "CurrentRepository" as const, directory: yield* git.currentRepositoryRoot() }
          : { _tag: "Clone" as const, repo: yield* parseOwnerAndRepo(ownerAndRepo) };
        const accountKeys = yield* modules.accountKey;
        const accountKey = yield* e.pipe(
          e.Effect.gen(() => accountKeys.ensure()),
          e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: reason, fix: `Run \`${TOOL_NAME} git setup\` again and approve the sign-in on jive.sh` })),
        );
        const github = yield* modules.github;
        const { writeToken, username, email } = yield* github.authorizeKeyRegistration();
        yield* github.setSshKey(writeToken, accountKey);
        yield* e.Effect.log(`Your Jive account key is an authentication and signing key of GitHub user ${username}`);
        const directory = target._tag === "CurrentRepository"
          ? target.directory
          : yield* git.cloneWithAccountKey({
            repo: target.repo,
            accountKey,
            intoDirectory: yield* (yield* OSPlatform).getCurrentDirectory(),
          });
        const repositories = yield* git.configureSigning({ directory, identity: { name: username, email }, accountKey });
        yield* e.Effect.log(`${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"} under ${directory} now sign commits and tags as ${username} <${email}>`);
      },
    }),
  },

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

  init: Cli.command({
    *run() {
      // TODO: initialize TOOL_NAME in current repo (tsconfig, renovate.json, gitignore, GitHub workflow)
      yield* e.Effect.log(`Initializing ${TOOL_NAME}...`);
    },
  }),
});

/** `owner/repo`, as `jive git setup` takes it. */
function parseOwnerAndRepo(ownerAndRepo: string): e.Effect.Effect<RepoIdentifier, BadArgumentError> {
  const [owner, repo, ...rest] = ownerAndRepo.split("/");
  return owner && repo && rest.length === 0
    ? e.Effect.succeed(new RepoIdentifier(owner, repo.replace(/\.git$/, "")))
    : e.Effect.fail(new BadArgumentError({ argument: "owner/repo", reason: `"${ownerAndRepo}" is not owner/repo` }));
}
