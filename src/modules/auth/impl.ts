import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import { type GithubWriteToken } from "@/modules/github/interface";
import { NotLoggedInError, type CurrentUser, type IAuth } from "./interface";
import { selectSshKey } from "./ssh-key-selection";
import { warnOnInaccessibleRepos } from "./warn-on-inaccessible-repos";

export class AuthImpl extends implementing(modules.auth).uses(
  modules.git,
  modules.github,
  modules.toolState,
  modules.ssh,
  modules.yubikey,
  e.Terminal.Terminal,
  e.FileSystem.FileSystem,
  e.Path.Path,
) implements IAuth {
  *assertLoggedIn(): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError> {
    const { toolState, github } = this.dependencies;
    yield* this.assertInWorkspace();
    const maybeCurrentUserState = yield* toolState.readCurrentUserState();
    if (e.Option.isNone(maybeCurrentUserState)) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
    }
    const currentUserState = maybeCurrentUserState.value;
    const { accessToken } = yield* github.resolveAccessToken(currentUserState);
    if (e.Option.isNone(currentUserState.sshKey)) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({ reason: "no ssh key found" }));
    }
    const sshKey = currentUserState.sshKey.value;
    const registeredSshKey = yield* github.sshKeyExists(accessToken, sshKey);
    if (!registeredSshKey.authn || !registeredSshKey.signing) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({
        reason: `ssh key ${sshKey.name} is missing from github ${[
          !registeredSshKey.authn ? "auth keys" : "",
          !registeredSshKey.signing ? "signing keys" : "",
        ].filter(Boolean).join(" and ")}`,
      }));
    }
    // For validating that the yubikey is plugged in which contains the chosen ssh-key, we let this failure
    // happen when user tries to sign something (otherwise, to check the yubikey, it would require user PIN).
    // We don't want that since assertLogin is used in cases where we are doing non-signin behaviors.
    return {
      username: currentUserState.username,
      email: currentUserState.email,
      githubAccessToken: accessToken,
      sshKey
    };
  }

  *ensureLoggedIn({ chooseNewUser }: { chooseNewUser: boolean }): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError> {
    const { toolState, github } = this.dependencies;
    yield* this.assertInWorkspace();
    if (chooseNewUser || (yield* this.tokenUnusable())) {
      yield* e.Effect.log(`Starting fresh session`);
      yield* toolState.clearCurrentUserState();
    }
    const maybeExistingUser = yield* toolState.readCurrentUserState();
    const { user, maybeWriteToken } = e.Option.isSome(maybeExistingUser) ?
      { user: maybeExistingUser.value, maybeWriteToken: e.Option.none<GithubWriteToken>() } :
      yield* e.Effect.gen(function*() {
        const { accessTokenState, writeToken, email, username } = yield* github.oauthLogin();
        const newUserState = yield* toolState.setUser({ email, username, accessToken: accessTokenState });
        return { user: newUserState, maybeWriteToken: e.Option.some(writeToken) };
      });
    const { accessToken } = yield* github.resolveAccessToken(user);
    const { context } = this;
    const sshKey = yield* toolState.usingTempDirectory(e.Effect.fn(function*(tempPath: string) {
      const sshKey = yield* e.pipe(
        e.Effect.gen(() => selectSshKey(user.email, tempPath)),
        e.Effect.catchTag("CreateSshKeyOnYubikeyError", ({ reason }) => e.Effect.andThen(
          e.Effect.logError(`Failed to create ssh key on yubikey (${reason})`),
          e.Effect.die(reason),
        )),
        e.Effect.provide(context),
      );
      // We need to move the ssh key from the temp folder to the current user location before the temp folder is cleared
      const { newUserState } = yield* toolState.setSshKey(sshKey);
      if (e.Option.isNone(newUserState.sshKey)) {
        return yield* e.Effect.die("IMPOSSIBLE TO NOT HAVE SSH KEY SET");
      }
      return newUserState.sshKey.value;
    }));
    const registeredSshKey = yield* github.sshKeyExists(accessToken, sshKey);
    if (!registeredSshKey.authn || !registeredSshKey.signing) {
      yield* github.setSshKey(yield* this.getWriteTokenIfMissing(user.username, maybeWriteToken), sshKey);
    }
    // We want to warn the user of all repos which they don't have access to
    yield* e.pipe(
      e.Effect.gen(() => warnOnInaccessibleRepos(accessToken)),
      e.Effect.provide(context),
    );
    return {
      email: user.email,
      username: user.username,
      githubAccessToken: accessToken,
      sshKey
    };
  }

  private *assertInWorkspace(): EffectGen<void, BadPreconditionsError> {
    yield* e.pipe(
      e.Effect.gen(() => this.dependencies.toolState.assertInWorkspace()),
      e.Effect.mapError(BadPreconditionsError.fromNotInWorkspaceError),
    );
  }

  private *tokenUnusable(): EffectGen<boolean> {
    const maybeUserState = yield* this.dependencies.toolState.readCurrentUserState();
    if (e.Option.isNone(maybeUserState)) {
      return true;
    }
    const resolved = yield* e.pipe(
      e.Effect.gen(() => this.dependencies.github.resolveAccessToken(maybeUserState.value)),
      e.Effect.tapError(({ argument, reason }) => e.Effect.log(`Existing access token is unusable due to invalid ${argument}: ${reason}`)),
      e.Effect.option,
    );
    return e.Option.isNone(resolved);
  }

  private *getWriteTokenIfMissing(username: string, maybeWriteToken: e.Option.Option<GithubWriteToken>): EffectGen<GithubWriteToken> {
    if (e.Option.isSome(maybeWriteToken)) return maybeWriteToken.value;
    const { writeToken } = yield* this.dependencies.github.oauthLogin(username);
    return writeToken;
  }
}
