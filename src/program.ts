import * as e from "effect";
import { version } from "../package.json";
import { CLI } from "./cli";
import { TOOL_NAME } from "./constants";
import { IAuth, IBun, IDaemon, IGit, ITemplates } from "./modules";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export const program = e.Effect.gen(function*() {
  const auth = yield* IAuth;
  const bun = yield* IBun;
  const daemon = yield* IDaemon;
  const git = yield* IGit;
  const templates = yield* ITemplates;

  yield* auth.warnOnMissingOpenSshAtStartup;

  yield* CLI.new(TOOL_NAME, CLI.DiscreteOptions({
    load: CLI.AsyncOptions(
      git.localOrgs,
      (org) =>
        CLI.AsyncOptions(
          e.Effect.fn(function*() {
            const readOnlyToken = yield* auth.readOnlyToken;
            return yield* git.remoteRepos(org, readOnlyToken);
          }),
          (repo) =>
            CLI.Handle(
              e.Effect.fn(function*() {
                const readOnlyToken = yield* auth.readOnlyToken;
                const activeIdentity = yield* auth.activeGitIdentity;
                if (!readOnlyToken || e.Option.isNone(activeIdentity)) {
                  yield* e.Effect.logError(`Not logged in. Run \`${TOOL_NAME} login\` first.`);
                  return;
                }

                const exists = yield* git.submoduleExists(org, repo);
                if (!exists) {
                  const added = yield* git.addSubmodule(org, repo);
                  if (!added) {
                    yield* e.Effect.logError(`Failed to add @${org}/${repo} as a submodule.`);
                    return;
                  }
                  yield* e.Effect.log(`Added @${org}/${repo} as a submodule.`);
                } else {
                  const updateResult = yield* git.updateSubmoduleIfAllowed(org, repo, readOnlyToken);
                  switch (updateResult._tag) {
                    case "Updated":
                      yield* e.Effect.log(`Updated @${org}/${repo}; it already existed so it was not re-added.`);
                      break;
                    case "SkippedDirty":
                      yield* e.Effect.logWarning(yellow(`WARNING: skipped update for @${org}/${repo} because the working tree is dirty.`));
                      break;
                    case "SkippedOffDefaultBranch":
                      yield* e.Effect.logWarning(
                        yellow(
                          `WARNING: skipped update for @${org}/${repo} because current branch is ${updateResult.currentBranch}, expected ${updateResult.defaultBranch}.`,
                        ),
                      );
                      break;
                    case "SkippedUnknownDefaultBranch":
                      yield* e.Effect.logWarning(yellow(`WARNING: skipped update for @${org}/${repo} because default branch could not be determined.`));
                      break;
                    case "SkippedPullFailed":
                      yield* e.Effect.logWarning(yellow(`WARNING: skipped update for @${org}/${repo} because git pull failed.`));
                      break;
                    case "Missing":
                      yield* e.Effect.logWarning(yellow(`WARNING: skipped update for @${org}/${repo} because the repo path is missing.`));
                      break;
                  }
                }

                const configured = yield* git.configureRepoRemoteAndUser(org, repo, {
                  userName: activeIdentity.value.userName,
                  userEmail: activeIdentity.value.userEmail,
                  authPrivateKeyPath: activeIdentity.value.readOnlyAuthPrivateKeyPath,
                });
                if (!configured) {
                  yield* e.Effect.logError(`Failed to configure git remote/user for @${org}/${repo}.`);
                  return;
                }

                yield* bun.install(org, repo);
                yield* bun.link(org, repo);
              }),
            ),
        ),
    ),

    unload: CLI.AsyncOptions(
      git.localOrgs,
      (org) =>
        CLI.AsyncOptions(
          git.localRepos(org),
          (repo) =>
            CLI.Handle(
              e.Effect.fn(function*() {
                const removed = yield* git.removeSubmodule(org, repo);
                if (!removed) {
                  yield* e.Effect.logError(`Failed to unload @${org}/${repo}.`);
                }
              }),
            ),
        ),
    ),

    on: CLI.AsyncOptions(
      git.localOrgs,
      (org) =>
        CLI.AsyncOptions(
          git.localRepos(org),
          (repo) =>
            CLI.Handle((remaining) =>
              e.Effect.gen(function*() {
                const ok = yield* git.runInRepo(org, repo, remaining);
                if (!ok) {
                  yield* e.Effect.logError(`Failed to run command in @${org}/${repo}.`);
                }
              }),
            ),
        ),
    ),

    create: CLI.AsyncOptions(
      templates.availableTemplates,
      (template) =>
        CLI.Handle(
          e.Effect.fn(function*([repo]) {
            const writeToken = yield* auth.ensureWriteTokenForActiveUser;
            if (e.Option.isNone(writeToken)) return;

            // TODO: scaffold repo from template, create on GitHub, link to workspace
            yield* e.Effect.log(`Creating ${repo} from template ${template}...`);
          }),
        ),
    ),

    templatize: CLI.AsyncOptions(
      git.localOrgs,
      (org) =>
        CLI.AsyncOptions(
          git.localRepos(org),
          (repo) =>
            CLI.Handle(
              e.Effect.fn(function*([templateName]) {
                const writeToken = yield* auth.ensureWriteTokenForActiveUser;
                if (e.Option.isNone(writeToken)) return;

                // TODO: extract template definition from existing repo instance
                yield* e.Effect.log(`Syncing ${org}/${repo} into template ${templateName}...`);
              }),
            ),
        ),
    ),

    login: CLI.Handle(auth.login),

    whoami: CLI.Handle(auth.whoami),

    init: CLI.Handle(
      e.Effect.gen(function*() {
        // TODO: initialize TOOL_NAME in current repo (tsconfig, renovate.json, gitignore, GitHub workflow)
        yield* e.Effect.log(`Initializing ${TOOL_NAME}...`);
      }),
    ),

    daemon: CLI.Handle(daemon.start),

    update: CLI.DiscreteOptions({
      self: CLI.Handle(
        e.Effect.sync(() => {
          // TODO: upgrade self (detect installer and run that installer's update for self. We can support yarn, pnpm, bun, npm to start).
          //       perhaps the postinstall could somehow determine what tool is installing this CLI then record the tool and whether it's
          //       a local or global install
        }),
      ),
      repos: CLI.Handle(
        e.Effect.sync(() => {
          // TODO: user should input a glob match using *. Ideally there'd be a way to match all in autocomplete. Perhaps a custom match algorithm
          //       for async options.
        }),
      ),
    }),

    version: CLI.Handle(
      e.Effect.log(version),
    ),
  }));
});
