import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { modules } from "@/modules";
import type { AccountKey } from "@/modules/account-key/interface";
import { type GithubAccessToken, type GithubWriteToken } from "@/modules/github/interface";
import { NotLoggedInError, type CurrentUser, type IAuth } from "./interface";
import { warnOnInaccessibleRepos } from "./warn-on-inaccessible-repos";

export class AuthImpl extends implementing(modules.auth).uses(
  modules.git,
  modules.github,
  modules.toolState,
  modules.accountKey,
) implements IAuth {
  *assertLoggedIn(): EffectGen<CurrentUser, BadArgumentError | BadPreconditionsError> {
    const { toolState, github, accountKey } = this.dependencies;
    yield* this.assertInWorkspace();
    const maybeCurrentUserState = yield* toolState.readCurrentUserState();
    if (e.Option.isNone(maybeCurrentUserState)) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
    }
    const currentUserState = maybeCurrentUserState.value;
    const { accessToken } = yield* github.resolveAccessToken(currentUserState);
    const maybeAccountKey = yield* accountKey.cached();
    if (e.Option.isNone(maybeAccountKey)) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({ reason: "this machine has no Jive account key yet" }));
    }
    const registered = yield* github.sshKeyExists(accessToken, maybeAccountKey.value);
    if (!registered.authn || !registered.signing) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({
        reason: `your Jive account key is missing from GitHub's ${[
          !registered.authn ? "authentication keys" : "",
          !registered.signing ? "signing keys" : "",
        ].filter(Boolean).join(" and ")}`,
      }));
    }
    return {
      username: currentUserState.username,
      email: currentUserState.email,
      githubAccessToken: accessToken,
      accountKey: maybeAccountKey.value,
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
    const accountKey = yield* this.ensureAccountKeyOnGitHub(accessToken, user.username, maybeWriteToken);
    yield* e.pipe(
      e.Effect.gen(() => warnOnInaccessibleRepos(accessToken)),
      e.Effect.provide(this.context),
    );
    return { email: user.email, username: user.username, githubAccessToken: accessToken, accountKey };
  }

  private *ensureAccountKeyOnGitHub(
    accessToken: GithubAccessToken,
    username: string,
    maybeWriteToken: e.Option.Option<GithubWriteToken>,
  ): EffectGen<AccountKey, BadPreconditionsError> {
    const { github, accountKey } = this.dependencies;
    const key = yield* e.pipe(
      e.Effect.gen(() => accountKey.ensure()),
      e.Effect.mapError(({ reason }) => new BadPreconditionsError({ cause: reason, fix: "Sign in to Jive when the page opens, then run the command again" })),
    );
    const registered = yield* github.sshKeyExists(accessToken, key);
    if (!registered.authn || !registered.signing) {
      const writeToken = e.Option.isSome(maybeWriteToken) ? maybeWriteToken.value : (yield* github.oauthLogin(username)).writeToken;
      yield* github.setSshKey(writeToken, key);
    }
    return key;
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
}
