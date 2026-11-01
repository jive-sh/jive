# From `@ozyman42/ozy-cli` to `@jive-sh/jive`

**Status (2026-11-01):** `@jive-sh/jive` 0.2.0 is on npm; this document describes the tree after the change that
removes `jive git setup` (released as 0.3.0). `@ozyman42/ozy-cli` 0.5.4 is still installed and running on Alex's
machine (its `ozy-signing-agent` signs his commits); its npm deprecation waits on an npm sign-in as `ozyman42`, the
package's only owner.

Statuses: **ported** (jive does it), **replaced** (something else does it, named), **dropped** (nothing does it, on
purpose), **still to port** (wanted, not built yet).

## ozy-cli commands and modules

| ozy-cli | What it does | Status | Reason |
| --- | --- | --- | --- |
| `ozy git setup [owner/repo]` | GitHub OAuth; registers one key on GitHub as auth and signing key; points `~/.ssh/config`'s `github.com` at the agent; sets signing config in the repo and its submodules; can clone | replaced | Alex: "git setup probably goes away". `jive login` gets the account key; `jive load` registers it on GitHub and configures the repo and its submodules |
| submodule repair inside `ozy git setup` (`git/submodule/*`) | Repairs `.git/modules`, gitlinks and submodule config left inconsistent | dropped | Not signing setup; `jive load` and `jive unload` add and remove submodules through git itself |
| `ozy git hosts` | Lists `github.com` hosts in `~/.ssh/config` | dropped | jive leaves `~/.ssh/config` alone and points each repo at the agent through `core.sshCommand` |
| `ozy pkg publish` / `package` module | Creates the GitHub repo, first npm publish, trusted publisher | replaced | The pipeline's deploy: `jive login --cicd`, then `jive provision connector-package-registry …` (still to port, below) |
| `ozy ssh sk-credential` | Reads a credential id from an `sk-` key file | dropped | No key on the machine any more |
| `ozy cloudflare token` / `cloudflare` module | Drives a browser to create a Cloudflare API token | dropped | jive.sh moved to EAS; DNS will be the proposed `jive-resource-connector-dns-cloudflare`. Its Playwright dependency doesn't bundle into a compiled binary |
| `ozy daemons` | Lists every registered Jive daemon | ported | `jive daemons` |
| `ozy upgrade` | Reinstalls the latest version with the installing package manager | ported | `jive upgrade` (jive-abstract-library's `upgrade`) |
| `ssh-agent` module, `ozy-signing-agent` daemon | SSH agent; key derived from a passkey PRF on a `localhost` page and cached | replaced | `jive-signing-agent` holds no key: it forwards each sign request to `@jive-sh/server`'s `ssh:sign` with the session (Alex: "the ssh key is no longer stored client side") |
| `ozy-ssh-keygen` | `gpg.ssh.program`: ssh-keygen pointed at the agent's socket | ported | `jive-ssh-keygen` |
| `agent-client` module | RPC from the CLI to the agent (`Setup`, `StartSession`) | dropped | The CLI and the agent share `~/.jive/session.json` and `~/.jive/ssh/account.pub`; nothing to call |
| `ozy-virtual-security-key` | Virtual HID experiment that only logs bytes | dropped | Experiment; no local key |
| `npm` module | npm login, publish, trusted publishers, placeholders, deprecations | replaced | `@jive-sh/server` with `jive-resource-connector-package-registry-npm`, reached through `jive provision` |
| `npm-web-auth`, `npm-website` modules (uncommitted in ozy-cli's checkout) | Completing npm's web sign-in and registering a security key on npmjs.com | replaced | npm is the server's connector's job; these files belong to another thread and were left untouched |
| `templates` module (ejs package template) | Scaffolds a package | dropped | Packages are created from abstracts (26e7176) |
| `crypto`, `kep-map-store` modules | PRF-derived key handling and its cache | dropped | No local key |
| `ssh-config` module | Edits `~/.ssh/config` | dropped | jive configures `core.sshCommand` per repo instead |
| `os-platform` module (incl. `virtual-hid`) | Host processes, paths, virtual HID | replaced | jive-abstract-library's `OSPlatform`; virtual HID dropped with the experiment |

## jive modules and commands

| jive | What it does | Status | Reason |
| --- | --- | --- | --- |
| `jive login` | Passkey sign-in request (`signInRequests:open`/`claim`), then the account key (`ssh:createKey`), kept at `~/.jive/ssh/account.pub` | ported | One of the two ways to a session (Alex: "only 2 of them are available via cli") |
| `jive login --cicd` | Exchanges the job's GitHub ID token (audience `https://api.jive.sh`) for a pipeline session (`pipelineSessions:signIn`) | ported | The other way to a session; the deploy hook's first step |
| `jive whoami` | Prints the session's account (`accounts:me`) | ported | |
| `jive load <org> <repo>` | Adds the repo as a submodule by its https URL, runs `git submodule update --init --recursive` for it, registers the account key on GitHub, and configures the repo and every submodule under it to sign with the account key and push through the agent | ported | Takes over `git setup`'s registration and signing config. Pushes go over SSH by config (`remote.origin.pushurl`, `core.sshCommand`); `.gitmodules` holds only https URLs |
| `jive unload`, `jive on` | Remove a loaded repo; run a command in one | ported | |
| `jive daemons`, `jive upgrade` | As in ozy-cli | ported | |
| `jive provision <kind> <name>` | Makes sure a resource instance exists, e.g. `jive provision connector-package-registry @jive-sh/server-client`; the organization's configured implementation (npm for jive-sh) does it | ported (0.4.0) | Calls `provision` (docs/jive_server_provision_api.md section 2); the instance is `jive.resources.<kind>.<name>` in `./package.json` or `--instance`. The server's `provision` isn't deployed yet, so it answers an error until then |
| deploy hook on `jive login --cicd` + `jive provision` | jive-abstract-library's deploy runs `bun x @jive-sh/jive@0.4.1 login --cicd`, then `provision connector-package-registry <name> --instance {"packageName":…}` | ported (jive-abstract-library 0.11.0) | The only provisioning path. The direct `packages:provision` call, the library's ID-token fetch and the switch were deleted after a real deploy signed in and reached `provision` |
| package git URLs through `connector-code-repository` | `jive load` asks the server for the repo's URLs; the organization's configured code-repository implementation (GitHub for jive-sh) answers | still to port | Needs a server call (proposed below). Until then `github.remoteUrls` builds `https://github.com/<org>/<repo>.git` and `git@github.com:…` itself |
| `jive-signing-agent` (daemon), `jive-ssh-keygen`, `git-credential-jive` | The agent, git's signing program, the workspace's https credential helper | ported | |
| `session`, `account-key`, `jive-server`, `pipeline-identity`, `signing-agent` modules | Session file and sign-in; the account key; calls to `@jive-sh/server`; the job's ID token; the agent protocol | ported | New with this migration |
| `browser` module | Opens a URL with the platform's opener (`open`, `xdg-open`, `start`) | ported | The sign-in page; tests never use the real one |
| `auth`, `github` modules | The workspace's GitHub sign-in (two OAuth passes, kept in `.jive/users`) and key registration | ported | `jive load` needs a GitHub token to clone and to register the key |
| `tool-state` module | The workspace: its root, loaded repos, the GitHub user's tokens | ported | Lost its local SSH key handling |
| `bun` module | `bun install` and `bun link` in a loaded repo | ported | |
| `oauth2` module | An interface for refresh-token storage nothing implemented | dropped (deleted) | Dead; GitHub OAuth lives in `github/oauth` |
| `templates` module and `jive create` | Listed no templates; `create` only printed a line | dropped (deleted) | Templates were removed for abstracts (26e7176); `jive create <kind>` will resolve `jive-abstract-<kind>` when built |
| `npm` module | Four methods that each died "not implemented" | dropped (deleted) | npm is the server's connector's job |
| `jive init` | Makes the current repository a workspace: .gitmodules to https at every depth, missing submodules checked out (checked-out ones keep their HEAD), and the root and every submodule configured to sign with the account key and push through the agent | ported (0.5.0) | Brought back as the workspace command for the cutover; the 0.3.0 stub only printed a line. URLs come from `github.remoteUrls` until the server has a code-repository call |
| `jive git setup` | Signed in, registered the key, configured the current repo or cloned one | dropped (deleted) | Alex: "git setup probably goes away honestly" |
| `jive update self` / `update repos`, `jive daemon`, `daemon` module | Empty stubs; an in-process daemon | dropped (deleted) | `jive upgrade`; daemons are `src/daemons/` entries |
| `ssh`, `yubikey` modules, local key selection | Local or YubiKey SSH keys under `.jive/ssh` | dropped (deleted) | The key is on the server |

## Deleted in this pass

- `src/modules/templates/` and the `create` command
- `src/modules/npm/`
- `src/modules/oauth2/`
- the `init` command and the YubiKey/local-key TODO block in `src/program.ts`
- `jive git setup`, with `git.currentRepositoryRoot`, `git.cloneWithAccountKey`, `git.configureSigning` (folded
  into `jive load`'s configuration), `git.configureWorkspace` (never called) and `github.authorizeKeyRegistration`
- `github.getVerifiedEmails`, `github.setupOrgs`, `github.setupRemoteRepo` (unused or "not implemented")
- the `git-url-parse` dependency (only `configureWorkspace` used it)

Earlier in the migration (0.1.0): `src/modules/ssh/`, `src/modules/yubikey/`, `src/modules/daemon/`,
`auth/ssh-key-selection.ts`, `src/scripts/get-cicd-config.ts`, `src/temp-libs/`, `.github/json-schema.json`, and
the `daemon` and `update` commands.

## Proposed server call: a code repository's URLs

**Default in effect, for the server thread to confirm or change:** `codeRepositories:remote` (a Convex query).

```ts
args:   { sessionToken: string; owner: string; name: string }
value:  { status: "found", fetchUrl: string, pushUrl: string }   // e.g. https://github.com/jive-sh/jive.git, git@github.com:jive-sh/jive.git
      | { status: "refused", reason: string }                    // no live session, no implementation configured, unknown repo
```

The server answers through the organization's configured `connector-code-repository` implementation (GitHub for
jive-sh), the same one-implementation-per-kind lookup as `resources:provision`. A person's session may call it.
`jive load` writes `fetchUrl` into `.gitmodules` and `remote.origin.url`, and `pushUrl` into
`remote.origin.pushurl`; `github.remoteUrls` is then deleted.

## The jive block shape `jive provision` reads

The provision contract's open question 2 leaves this to jive. **Built in 0.4.0, a default Alex can change:** a package declares its instances
by kind, each instance by name, holding the shape that kind's contract defines:

```json
"jive": {
  "resources": {
    "connector-package-registry": { "@jive-sh/server-client": { "packageName": "@jive-sh/server-client" } }
  }
}
```

`jive provision <kind> <name>` sends `{ kind, instance: <that object> }`; `--instance '<json>'` gives the object
instead, which is how jive-abstract-library's deploy hook names the package it publishes. The library's manifest
schema doesn't validate `jive.resources` yet.

## Switching Alex's machine from ozy to jive

ozy-cli is deprecated only once every check in step 4 passes on his workspace. ozy's agent keeps running throughout;
nothing here stops or edits it, so rolling back is only git config (step 5).

**State on 2026-11-01 (read-only check):** `@jive-sh/jive` 0.4.1 is installed globally (`~/.bun/bin/jive`) and its
`jive-signing-agent` runs (launchd, `~/.jive/signing-agent.sock`), with no session and no account key. The chaine root
and its 11 submodules sign through `ozy-ssh-keygen`; 10 more repositories under `packages/` are git repositories the
root doesn't track (`@jive-sh/server`, `@jive-sh/daemon`, `@jive-sh/extension`, `jive-abstract-app-expo`,
`jive-abstract-backend-convex`, `jive-abstract-resource`, `jive-abstract-resource-connector`,
`jive-abstract-resource-connector-package-registry`, `jive-resource-connector-package-registry-npm`,
`@chaine-dance/jive-test-package`). The root `.gitmodules` names 12 `git@github.com:` URLs and has a staged change
from another thread.

### 1. Upgrade jive (no prompt)

```sh
jive upgrade && jive --version && jive daemons
```

Expect the new version, then `jive-signing-agent — @jive-sh/jive: running`.

### 2. Sign in to Jive (one passkey approval)

```sh
jive login
```

The jive.sh sign-in page opens; approve with the jive.sh passkey. It prints `Signed in to Jive until …` and where the
account's public key went (`~/.jive/ssh/account.pub`); the server creates the key on this first call.

### 3. Make the chaine checkout a jive workspace (one GitHub approval)

```sh
cd /Users/alex/github.com/chaine-dance/chaine && jive init
```

GitHub's authorization page opens once; approve it. `jive init` then:
- creates `.jive/` (the workspace's GitHub token) and adds `/.jive/` to `.gitignore`;
- registers the account key on GitHub as an authentication key and a signing key;
- rewrites the 12 `git@` URLs in `.gitmodules` to https, in the working tree only (the other thread's staged change
  is kept), and runs `git submodule sync`; no submodule is missing, so none is checked out and none moves;
- configures the root, the 11 submodules and the 10 untracked repositories: `user.signingKey ~/.jive/ssh/account.pub`,
  `gpg.ssh.program …/@jive-sh/jive/bin/jive-ssh-keygen`, commit and tag signing on, `core.sshCommand` through
  `~/.jive/signing-agent.sock`, `credential.helper git-credential-jive`, origin fetching over https and pushing to
  `git@github.com:…`.

It ends with `12 submodule URLs moved to https; 22 repositories sign as ozyman42 <…> and push through jive's agent`.

### 4. Check Alex's bar (every line must hold)

```sh
cd /Users/alex/github.com/chaine-dance/chaine
jive daemons | grep jive-signing-agent
jive whoami
SSH_AUTH_SOCK=$HOME/.jive/signing-agent.sock ssh-add -L | diff - $HOME/.jive/ssh/account.pub && echo "agent holds the account key"
ssh -o IdentityAgent=$HOME/.jive/signing-agent.sock -o IdentityFile=$HOME/.jive/ssh/account.pub -o IdentitiesOnly=yes -T git@github.com
for d in . $(git submodule foreach --quiet --recursive pwd) $(git ls-files --others --exclude-standard --directory | sed -n 's#/$##p'); do [ -e "$d/.git" ] || continue; p=$(git -C "$d" config gpg.ssh.program); s=$(git -C "$d" config core.sshCommand); u=$(git -C "$d" config remote.origin.pushurl); case "$p$s$u" in *jive-ssh-keygen*signing-agent.sock*git@github.com:*) ;; *) echo "NOT ON JIVE: $d";; esac; done; echo "repo check done"
for f in .gitmodules $(git submodule foreach --quiet --recursive 'test -f .gitmodules && echo "$toplevel/$sm_path/.gitmodules"'); do grep -H "url = git@" "$f"; done; echo ".gitmodules check done"
cd packages/@chaine-dance/jive-test-package && git commit --allow-empty -m "jive signing check" && git push && gh api repos/chaine-dance/jive-test-package/commits/HEAD --jq .commit.verification.verified
```

Expect: the agent `running`; `<handle>@jive.sh`; `agent holds the account key`; `Hi ozyman42! You've successfully
authenticated`; no `NOT ON JIVE` line before `repo check done`; no `url = git@` line before `.gitmodules check done`;
and `true` (GitHub shows the signed commit, pushed over jive's SSH connection, as Verified). The last line uses the
throwaway test package, whose deploy skips a push that doesn't change its version.

### 5. Roll back to ozy (if any check fails)

```sh
cd /Users/alex/github.com/chaine-dance/chaine
for d in . $(git submodule foreach --quiet --recursive pwd) $(git ls-files --others --exclude-standard --directory | sed -n 's#/$##p'); do [ -e "$d/.git" ] || continue; [ -f "$d/.gitmodules" ] && git -C "$d" restore --worktree .gitmodules; done
git restore --worktree .gitignore && git submodule sync --recursive
for d in . $(git submodule foreach --quiet --recursive pwd) $(git ls-files --others --exclude-standard --directory | sed -n 's#/$##p'); do [ -e "$d/.git" ] || continue
  git -C "$d" config gpg.ssh.program /Users/alex/.bun/install/global/node_modules/@ozyman42/ozy-cli/bin/ozy-ssh-keygen
  git -C "$d" config user.signingkey /Users/alex/.ssh/jive-immense-shadowed-camp.pub
  git -C "$d" config --unset core.sshCommand; git -C "$d" config --unset remote.origin.pushurl
  git -C "$d" config --unset credential.helper; git -C "$d" config --unset credential.useHttpPath
  url=$(git -C "$d" config remote.origin.url) && git -C "$d" remote set-url origin "$(echo "$url" | sed 's#^https://github.com/#git@github.com:#')"
done
```

This puts back ozy's `gpg.ssh.program`, signing key and SSH origins, and removes jive's push and credential config.
`git restore --worktree` returns each `.gitmodules` to its staged version (the other thread's change stays staged)
and `.gitignore` to its committed one, before `submodule sync` and before the origins are set back. ozy's agent never stopped, so signing works again at once. `jive` stays installed
and idle; `bun remove -g @jive-sh/jive` removes it and its daemon.
