import * as e from "effect";
import { Cli, OSPlatform } from "jive-abstract-library";
import { TOOL_NAME } from "@/constants";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
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
    description: "sign in to GitHub and choose the SSH key for pushes and commit signing",
    *run() {
      yield* (yield* modules.auth).ensureLoggedIn({ chooseNewUser: true });
    },
  }),

  whoami: Cli.command({
    description: "print the signed-in user's email",
    *run() {
      const user = yield* (yield* modules.auth).assertLoggedIn();
      yield* e.Effect.log(user.email);
    },
  }),

  init: Cli.command({
    *run() {
      // TODO: initialize TOOL_NAME in current repo (tsconfig, renovate.json, gitignore, GitHub workflow)
      yield* e.Effect.log(`Initializing ${TOOL_NAME}...`);
    },
  }),

  daemon: Cli.command({
    *run() {
      yield* (yield* modules.daemon).start();
    },
  }),

  update: {
    self: Cli.command({
      *run() {
        // TODO: upgrade self (detect installer and run that installer's update for self. We can support yarn, pnpm, bun, npm to start).
        //       perhaps the postinstall could somehow determine what tool is installing this CLI then record the tool and whether it's
        //       a local or global install
      },
    }),
    repos: Cli.command({
      *run() {
        // TODO: user should input a glob match using *. Ideally there'd be a way to match all in autocomplete. Perhaps a custom match algorithm
        //       for async options.
      },
    }),
  },
});
