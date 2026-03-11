import * as e from "effect";
import { version } from "../package.json";
import { CLI } from "@/temp-libs/cli";
import { TOOL_NAME } from "@/constants";
import * as modules from "@/modules";

export class MissingDependenciesError extends e.Data.TaggedError("MissingDependenciesError")<{missingDependencies: string[]}> {}

/* TODO:
 * 1. On-device renaming should be supported if the yubikey appears to have default name on load. If ykman is needed as a dependency for this so be-it.
 *    Ideally we could use an sdk like the c sdk which supports gpg key creation on device
 * 2. Commit signing shall be done via gpg. The pubkey should be uploaded for signing and then the derived ssh pubkey from gpg agent should be 
 *    uploaded as the ssh authn key. We do not store the ssh key locally, it's a reference to the gpg key. Key names should take on the
 *    format of jive:<email>:<name>:<id> where "name" is the name of the gpg key and id is some uniquely identifying pubkey chars of the gpg key
 *    This way there can be local gpg keys (for use by agents), and yubikey gpg keys (for use by humans), and multiple keys for each as this information
 *    is embedded in the name of the key. At the start of the login process, we can show a list of gpg keys to choose from and we can have an option
 *    to create a new key. If creating a new key it's either locally or on a yubikey. If we get to that part (either selecting a pre-existing key on a yubikey or creating on a yubikey),
 *    then we can go through the possible yubikey renaming flow and gpg key creation flow.
 * 3. Repo reading: Repo reading will always be done through the oauth app token. You can see how I've created a git-credential-helper and it compiles to
 *    git-credential-live. That is how we will do the reading. When creating a submodule (via jive load or jive create), jive will pass a
 *    -c credential.helper="/path/to-credential-helper" flag where it's to obtained via process.execPath then pointing to the neighboring credential
 *    executable. There are two possible token obtaining routes. Ideally it's done via the Jive Github App which is installed on the repo we're trying
 *    to clone/load. The github app can issue a read-only token which will go by the format of readonly-org-scoped-<@orgname>-repo-token
 *    whereas if the github app does not exist on that repo, we go through a few prompt phases. First we offer to install the app on that repo if the
 *    user owns it, a "(more safe)" can be in parens next to the github app option. If not possible or if user chose not to install, 
 *    we print a warning that using the oauth app is less safe than installing the github app then urge user to urge repo owner to enable to app. Warning should explain that
 *    Github Apps can generate read-only repo tokens whereas oauth apps cannot. Then have a prompt for proceed anyways? (y/n). Then we move on to
 *    warning if a specific repo being cloned accepts non-verified commits (that should be turned off especially if a write-capable token is being persisted). Finally
 *    login with Jive Oauth app and then the token format can be readwrite-dangerous-all-repos-token. You'll notice that the given token is being read by the
 *    the git-credential-helper executable. For now you can leave a TODO for how the credential helper will use an org-scoped read-only token as that'll be complex
 *    and I don't even have a Github App created yet. But the placeholders for when we get there will be good. The Github App will also assume rennovate type responsibilities in the future.    
 * 6. Use Effect's match APIs rather than switch statements when discerning between different _tag values. That should be in the effectful guide.
 * 7. After a repo is cloned, its credential helper should be configured to the executable we talked about. Its remote for pulling should remain https as it was cloned that way
 *    whereas its push remote should be ssh git@github.com (need to figure out how to use the specific user's gpg, perhaps there's a placeholder ssh file at .jive/users/current_ssh_to_gpg or something like that),
 *    and then signing key should be configured to the gpg key selected for the logged in user.
 */

export const program = e.Effect.gen(function*() {
  const auth = yield* modules.IAuth;
  const bun = yield* modules.IBun;
  const daemon = yield* modules.IDaemon;
  const git = yield* modules.IGit;
  const github = yield* modules.IGitHub;
  const hostShell = yield* modules.IHostShell;
  const templates = yield* modules.ITemplates;
  const toolState = yield* modules.IToolState;
  const yubiKey = yield* modules.IYubiKey;

  const missingCLICommands = yield* hostShell.missingCommands([
    ...auth.requiredCLICommands,
    ...bun.requiredCLICommands,
    ...daemon.requiredCLICommands,
    ...git.requiredCLICommands,
    ...github.requiredCLICommands,
    ...hostShell.requiredCLICommands,
    ...templates.requiredCLICommands,
    ...toolState.requiredCLICommands,
    ...yubiKey.requiredCLICommands,
  ]);
  if (missingCLICommands.length > 0) {
    return yield* new MissingDependenciesError({missingDependencies: missingCLICommands});
  }

  yield* CLI.new(TOOL_NAME, CLI.DiscreteOptions({
    load: CLI.AsyncOptions(
      git.localOrgs,
      (org) =>
        CLI.AsyncOptions(
          e.Effect.fn(function*() {
            const readOnlyToken = yield* auth.readOnlyToken;
            return yield* github.remoteRepos(org, readOnlyToken);
          }),
          (repo) =>
            CLI.Handle(
              e.Effect.fn(function*() {
                const activeIdentity = yield* auth.activeGitIdentity;
                const readOnlyToken = yield* auth.readOnlyToken;
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
                  const defaultBranch = yield* github.repoDefaultBranch(org, repo, readOnlyToken);
                  const updateResult = yield* git.updateSubmoduleIfAllowed(org, repo, defaultBranch);
                  switch (updateResult._tag) {
                    case "Updated":
                      yield* e.Effect.log(`Updated @${org}/${repo}; it already existed so it was not re-added.`);
                      break;
                    case "SkippedDirty":
                      yield* e.Effect.logWarning(`Skipped update for @${org}/${repo} because the working tree is dirty.`);
                      break;
                    case "SkippedOffDefaultBranch":
                      yield* e.Effect.logWarning(
                        `Skipped update for @${org}/${repo} because current branch is ${updateResult.currentBranch}, expected ${updateResult.defaultBranch}.`,
                      );
                      break;
                    case "SkippedUnknownDefaultBranch":
                      yield* e.Effect.logWarning(`Skipped update for @${org}/${repo} because the default branch could not be determined.`);
                      break;
                    case "SkippedPullFailed":
                      yield* e.Effect.logWarning(`Skipped update for @${org}/${repo} because git pull failed.`);
                      break;
                    case "Missing":
                      yield* e.Effect.logWarning(`Skipped update for @${org}/${repo} because the repo path is missing.`);
                      break;
                  }
                }

                const configured = yield* git.configureRepoRemoteAndUser(org, repo, {
                  userName: activeIdentity.value.userName,
                  userEmail: activeIdentity.value.userEmail,
                  authPrivateKeyPath: activeIdentity.value.readOnlyAuthPrivateKeyPath,
                  signingPublicKey: activeIdentity.value.signingPublicKey,
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
            yield* auth.ensureLoggedIn;

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
                yield* auth.ensureLoggedIn;

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
