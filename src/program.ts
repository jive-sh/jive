import * as e from "effect";
import { version } from "../package.json";
import { CLI } from "@/temp-libs/cli";
import { TOOL_NAME } from "@/constants";
import * as modules from "@/modules";
import { pluralize, prettyList } from "./logging";

export class BadArgumentError extends e.Data.TaggedError("BadArgumentError")<{
  readonly argument: string;
  readonly reason: string;
}> {}

export class BadPreconditionsError extends e.Data.TaggedError("BadPreconditionsError")<{
  readonly cause: string;
  readonly fix: string;
}> {}

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

export const program = e.Effect.gen(function*() {
  const auth = yield* modules.IAuth;
  const bun = yield* modules.IBun;
  const daemon = yield* modules.IDaemon;
  const git = yield* modules.IGit;
  const github = yield* modules.IGitHub;
  const templates = yield* modules.ITemplates;
  const toolState = yield* modules.IToolState;
  const hostShell = yield* modules.IHostShell;

  const cli = e.pipe(
    CLI.new(TOOL_NAME, CLI.DiscreteOptions({
      load: CLI.AsyncOptions(
        () => git.localOrgs,
        (org) =>
          CLI.AsyncOptions(
            () => github.remoteRepos(org),
            (repo) =>
              CLI.Handle(
                e.Effect.fn(function*() {
                  const chosenRepo = new modules.RepoIdentifier(org, repo);
                  // TODO: warn if user has a permissive token rather than a scoped token
                  const user = yield* auth.ensureLoggedIn({chooseNewUser: false});
                  yield* git.cloneAsSubmodule(chosenRepo, user);
                  yield* git.configureSubmodule(chosenRepo, user);
                  yield* e.Effect.log(`Cloned ${chosenRepo.toString()} to ${toolState.getRepoPath(chosenRepo)}`);
                  yield* bun.install(chosenRepo);
                  yield* bun.link(chosenRepo);
                }),
              ),
          ),
      ),

      unload: CLI.AsyncOptions(
        () => git.localOrgs,
        (org) =>
          CLI.AsyncOptions(
            () => git.localRepos(org),
            (repo) =>
              CLI.Handle(
                e.Effect.fn(function*() {
                  yield* git.removeSubmodule(new modules.RepoIdentifier(org, repo));
                }),
              ),
          ),
      ),

      on: CLI.AsyncOptions(
        () => git.localOrgs,
        (org) =>
          CLI.AsyncOptions(
            () => git.localRepos(org),
            (repo) =>
              CLI.Handle(
                e.Effect.fn(function*(remaining) {
                  const repoId = new modules.RepoIdentifier(org, repo);
                  const command = remaining.shift() ?? "";
                  yield* e.pipe(
                    command,
                    hostShell.getCommand,
                    e.Effect.flatMap(hostShell.runInheritIO({
                      args: remaining,
                      runInDir: toolState.getRepoPath(repoId)
                    })),
                    e.Effect.flatMap(({exitCode}) => 
                      exitCode === 0 ?
                        e.Effect.succeed(undefined) :
                        e.Effect.die(undefined)
                    )
                  );
                }),
              ),
          ),
      ),

      create: CLI.AsyncOptions(
        () => templates.availableTemplates,
        (template) =>
          CLI.Handle(
            e.Effect.fn(function*([repo]) {
              // TODO: scaffold repo from template, create on GitHub, link to workspace
              yield* e.Effect.log(`Creating ${repo} from template ${template}...`);
            }),
          ),
      ),

      templatize: CLI.AsyncOptions(
        () => git.localOrgs,
        (org) =>
          CLI.AsyncOptions(
            () => git.localRepos(org),
            (repo) =>
              CLI.Handle(
                e.Effect.fn(function*([templateName]) {
                  // TODO: extract template definition from existing repo instance
                  yield* e.Effect.log(`Syncing ${org}/${repo} into template ${templateName}...`);
                }),
              ),
          ),
      ),

      login: CLI.Handle(() => e.Effect.gen(function* () {
        yield* auth.ensureLoggedIn({chooseNewUser: true});
      })),

      whoami: CLI.Handle(() => e.Effect.gen(function*() {
        yield* e.pipe(
          auth.assertLoggedIn,
          e.Effect.catchTag("NotLoggedInError", err => e.Effect.fail(new BadPreconditionsError({
            cause: "You are not signed in.",
            fix: `Run \`${TOOL_NAME} login\``
          }))),
          e.Effect.flatMap(user => e.Effect.log(user.userEmail))
        );
      })),

      init: CLI.Handle(
        () => e.Effect.gen(function*() {
          // TODO: initialize TOOL_NAME in current repo (tsconfig, renovate.json, gitignore, GitHub workflow)
          yield* e.Effect.log(`Initializing ${TOOL_NAME}...`);
        }),
      ),

      daemon: CLI.Handle(() => daemon.start),

      update: CLI.DiscreteOptions({
        self: CLI.Handle(
          () => e.Effect.sync(() => {
            // TODO: upgrade self (detect installer and run that installer's update for self. We can support yarn, pnpm, bun, npm to start).
            //       perhaps the postinstall could somehow determine what tool is installing this CLI then record the tool and whether it's
            //       a local or global install
          }),
        ),
        repos: CLI.Handle(
          () => e.Effect.sync(() => {
            // TODO: user should input a glob match using *. Ideally there'd be a way to match all in autocomplete. Perhaps a custom match algorithm
            //       for async options.
          }),
        ),
      }),

      version: CLI.Handle(
        () => e.Effect.log(version),
      ),
    })),
    e.Effect.catchTag("CommandNotFoundError", ({missingCommand}) => e.Effect.fail(new BadPreconditionsError({
      cause: `The command ${prettyList([missingCommand])} is required for this operation but could not be found.`,
      fix: "Install it then retry."
    }))),
    // These shouldn't happen.
    e.Effect.catchTag("BadArgument", err => e.Effect.die(err)),
    e.Effect.catchTag("SystemError", err => e.Effect.die(err)), // TODO: maybe discern bad permissions. That could be transformed into BadPreconditions
  ) satisfies e.Effect.Effect<void, BadArgumentError | BadPreconditionsError, any>;
  yield* cli;
});
