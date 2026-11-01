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
| deploy hook on `jive login --cicd` + `jive provision` | jive-abstract-library's deploy stops calling `packages:provision` itself | still to port | Waits on `jive provision`; it then also drops the library's own ID-token fetch, which jive now owns |
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
| `jive init` | Printed "Initializing jive..." | dropped (deleted) | A stub with no design behind it |
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

Not done. ozy's agent keeps running and nothing here touches it. **Open, for the command thread:** with `git setup`
gone, only `jive load` registers the account key on GitHub and configures a repo, and it works inside a jive workspace
(a `.jive/` directory with repos at `@<org>/<repo>`). The chaine monorepo is not one (its packages are at
`packages/@<org>/<repo>`), so no jive command can switch it today. Options:

- **a.** Let a workspace say where its repos live (`packages/` here), and have `jive load` configure a repo that is
  already a submodule instead of refusing it. The monorepo becomes a jive workspace; nothing else changes.
  Recommended: it is the workspace model Alex already uses.
- **b.** Keep a `jive git configure` that does `load`'s registration and configuration for the current repo only.
  Brings back the command Alex said goes away.

The steps that work today, on any machine:

```sh
bun add -g @jive-sh/jive
jive login        # approve on jive.sh with your passkey; the first run also registers jive-signing-agent at login
jive whoami
```
