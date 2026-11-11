# Jive

Jive is a **developer platform** and an **agentic workforce platform**. It takes the manual steps out of building,
shipping and running software, and the infrastructure behind it. A few ideas run through all of it:

- **Agents in the cloud** (planned). Agentic workflows run on cloud compute with a session Jive gives them, not on a laptop that
  has to stay on.
- **Composable agentic workflows** (planned). A workflow is a package built from steps, and a workforce is built from workflows.
- **Minimal configuration.** A package extends an abstract for its kind and gets its pipeline, its config schema and
  its scaffold from it.
- **Composable software.** Packages declare the resources they need instead of sharing code, so independent
  repositories work together without a monorepo.

- **Developer platform:** the `jive` CLI (this repository), the CI/CD pipeline every Jive package runs (its
  [reusable workflow](.github/workflows/reusable-pipeline.yml), contract in [CICD_API.md](CICD_API.md)), and resource
  provisioning, which makes sure every resource a package needs exists in its organization.
- **Agentic workforce platform:** workforces of agents and code that run an organization's work. A software factory
  is one kind of workforce, binary decompilation another, a business and its operations another.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/jive-platforms-dark.svg">
  <img alt="Agentic workforce, the outer circle, holding three separate circles: software factory, binary decompilation, and a business and its operations" src="docs/jive-platforms-light.svg" width="480">
</picture>

## Agentic workflows, not skills

A **skill** is instructions an agent reads: it may follow them, skip a step, or forget them after a long session, and
nothing records whether it did. An **agentic workflow** is a process defined in code: each step is deterministic code
or a call to an agent for one bounded task; triggers (a schedule, a commit, a message, a threshold) start it; its
state is saved at every step, so a failed or interrupted step is retried rather than the whole run; and every step
records its start, end, outcome and cost. What must happen is enforced by the workflow, not hoped for from the agent.

So a business process in Jive is "a running, inspectable, maintainable workflow instead of a fragile chain of manual
procedures" ([architecture §3.3](docs/jive_architecture_discussion.md#33-arbitrary-durable-workflows)), and agents
are called for bounded tasks rather than kept as long-running conversations
([§2.A](docs/jive_architecture_discussion.md#a-workflows-versus-long-lived-claude-channels)). A workforce is a set of
such workflows, the agents they call, and the connectors they act through
([§3.2](docs/jive_architecture_discussion.md#32-agentic-workforces)). *Planned:* agentic workflows as a package kind
(`jive-abstract-resource-agentic-workflow`) and workforces built from them.

## A marketplace of package kinds

Everything in Jive is an npm package, and **every kind of package is itself a package**: an *abstract*,
`jive-abstract-<kind>`, implements the six CI/CD hooks for that kind, owns its manifest schema, and scaffolds new
packages of the kind. Extending one gives a package a working pipeline with no CI configuration of its own. Kinds
built today: `jive-abstract-library` (npm libraries and CLIs, this one included), `jive-abstract-backend-convex`,
`jive-abstract-app-expo`, `jive-abstract-docker-image`, `jive-abstract-backend-spacetimedb`, and
`jive-abstract-abstraction`, which creates new abstracts. Anyone can publish an abstract, so the set of kinds grows
like a marketplace. *Planned:* `jive create <kind>` finds every `jive-abstract-*` package and offers them as a menu
(`jive create agentic workflow` resolves `jive-abstract-agentic-workflow`).

**Resources** are the same idea for what packages use. A resource kind is an abstract defining a contract
(`jive-abstract-resource-connector-package-registry`), and an implementation is a package on one system
(`jive-resource-connector-package-registry-npm`). An organization configures one implementation per kind, and callers
name only the kind: `jive provision connector-package-registry @scope/name` makes sure that package exists on
whichever registry the organization uses. Public *ecosystem* packages (abstracts, connectors) are shared; a *usage*
package is someone's own use of them.

## No monorepo needed

Jive began as a way to make independent repositories work like a monorepo
([§1](docs/jive_architecture_discussion.md#1-executive-framing)). Each package keeps its own repository, version and
pipeline, and Jive supplies what a monorepo would:

- **One checkout for local work:** `jive init` makes any repository a workspace and `jive load` adds repos to it as
  submodules, all signing and pushing the same way, and the packages in it are linked to each other, so each one runs
  its workspace dependencies from their checkouts while its own lockfile and CI stay as they are ([Workspace
  links](#workspace-links)).
- **One way to ship:** every repository runs the same reusable pipeline through its abstract.
- **Connectors instead of shared code:** a package declares the resources it needs and the organization's connectors
  provide them, so nothing has to live in the same repository to work together. *Planned:* the code-repository
  connector (`jive-abstract-resource-connector-code-repository`, GitHub for jive-sh), so a package's repository and
  its URLs come from the organization rather than from paths or a hard-coded host.

## What Jive borrows from Brazil and Version Sets

Amazon builds its services with an internal system called **Brazil**, organised around many small repositories
rather than one. Public descriptions of it are second-hand: a former Amazon build-team engineer's account
([gist, 2017](https://gist.github.com/terabyte/15a2d3d407285b8b5a0a7964dd6283b0)) and
[ByteByteGo's guide](https://bytebytego.com/guides/how-does-amazon-build-system-work/). In them:

- code is broken into **packages**, each team owning its own repositories;
- a **version set** is "a list of package versions that are known to be consistent together", and every build runs
  "in a version set";
- a default version set, **live**, is where anyone publishes, and each team keeps its own version set, so "no one team
  is blocked on" another's builds;
- minor versions are non-breaking, and major versions are "picked up by request only".

Jive takes the same shape: independent packages in independent repositories and, *planned*, **version sets**: a
pinned set of package versions known to work together, built and tested as a whole before it is promoted, with
dependents updated when a dependency publishes and versions derived from API changes
([§15.2](docs/jive_architecture_discussion.md#152-versioning-and-version-sets)). Today each package pins the exact
versions it builds with.

## Install

```sh
bun add -g @jive-sh/jive
```

Installing registers `jive-signing-agent` and `jive-extension-daemon` to start at login (a LaunchAgent on macOS, a
`systemctl --user` unit on Linux, a scheduled task on Windows).

## Commands

| Command | What it does |
| --- | --- |
| `jive login` | Opens `https://jive.sh/login?request=…`, where you sign in with your jive.sh passkey, and waits; then fetches your account's public key (`ssh:publicKey`) into `~/.jive/ssh/account.pub`. |
| `jive login --cicd` | In a GitHub Actions job with `id-token: write`: exchanges the job's ID token for a session of its pipeline. |
| `jive whoami` | Prints the handle of the Jive account this machine is signed in as. |
| `jive init` | In the git repository you are in, rewrites every .gitmodules at every depth to `https://github.com/<owner>/<repo>`, syncs them, checks out every submodule not yet checked out (one already checked out keeps its HEAD), and configures the root, every submodule and every untracked repository inside it: `gpg.format=ssh`, `user.signingKey` (the account key's public half), `commit.gpgSign=true`, `gpg.ssh.program=jive-ssh-keygen`, `core.sshCommand` through `~/.jive/signing-agent.sock`, and `url."git@github.com:".insteadOf "https://github.com/"` so https URLs fetch and push over SSH. Then links the packages among those repositories with each other (see Workspace links). Nothing else, and no GitHub sign-in. Safe to run again: a submodule already checked out keeps its HEAD, and the links are made again. |
| `jive load <org> <repo>` | Adds a GitHub repo to the workspace as a submodule by its https URL, fetches its submodules, configures it and them as `jive init` does, runs `bun install` in it, then links it with the workspace's packages: its workspace dependencies into it, and it into every workspace package that depends on it. |
| `jive unload <org> <repo>` | Removes every workspace link into the repo, running `bun install` in each package that had one so it gets its registry copy back, then removes the repo. |
| `jive on <org> <repo> -- <command…>` | Runs a command in a loaded repo's directory; its exit code is jive's. |
| `jive ssh connect <ssh arguments…>` | Runs `ssh -o IdentityAgent=~/.jive/signing-agent.sock -o IdentityFile=~/.jive/ssh/account.pub -o IdentitiesOnly=yes <ssh arguments…>` on this terminal, so ssh signs in with your Jive key and offers no other key. Every word after `connect` goes to ssh, flags included (`jive ssh connect user@host -p 2222`); ssh's exit code is jive's. Fetches `account.pub` first when this machine has none, signing in if needed. |
| `jive ssh sign <ssh-keygen -Y sign arguments…>` | Runs `ssh-keygen -Y sign -f ~/.jive/ssh/account.pub <arguments…>` with `SSH_AUTH_SOCK` set to the agent's socket, so the server signs with your Jive key (`jive ssh sign -n file notes.txt` writes `notes.txt.sig`). ssh-keygen's exit code is jive's. |
| `jive provision <kind> <name>` | Makes sure a resource instance exists, e.g. `jive provision connector-package-registry @scope/name`. The instance is `./package.json`'s `jive.resources.<kind>.<name>`, or `--instance '<json>'`. Needs a pipeline session. |
| `jive daemons` | Lists every Jive daemon registered on this machine, with its state, executable and log. |
| `jive upgrade` | Upgrades jive with the package manager that installed it. |

`--help`, `--version` and Tab completion (`jive --setup-completion`) work as for every command built with
`jive-abstract-library`'s `Cli`.

## Workspace links

A workspace's packages are separate repositories, each with its own `package.json`, `bun.lock` and pipeline. Linking
makes them use each other the way a monorepo's members do, without changing what any of them installs in CI.

Every repository in the workspace whose `package.json` names a package is a member. Wherever one member depends on
another, `jive load` and `jive init` replace the dependent's `node_modules/<name>` with a relative
symlink to the dependency's checkout:

```
$ jive init
…
0 submodule URLs moved to https; 12 repositories sign with your Jive account key and fetch and push over SSH through jive's agent
Linked effective-modules into @jive-sh/jive: packages/effective-modules/dist/base (0.3.6)
Left jive-abstract-library into @jive-sh/jive: jive-abstract-library's build is 0.7.0-local and its checkout 0.13.1; run `bun run jive:cicd:build` in it, then `jive init`
1 workspace link in place; 1 left as installed
```

- **What a link points at.** A package whose source `package.json` names an entry point (`exports`, `main` or
  `module`) is linked at its checkout. A package built by a Jive abstract names none, since its build writes
  `exports`, so it is linked at the build in its `dist/base`, which must be of its checkout's version; after editing
  it, rebuild it (`bun run jive:cicd:build`) and the link serves the new build.
- **The checkout wins over the pin.** A link is made whatever version the dependent pins, and the line says when the
  checkout's version is outside the pin, since CI will install the pin.
- **Nothing in any repository changes.** No `package.json` or `bun.lock` is written, so each repository installs alone
  from its own lockfile, locally and in CI, exactly as before.
- **Left as installed:** a dependency the dependent names locally itself (`link:`, `file:`, `workspace:`), one `bun
  install` didn't install there (a peer dependency), one with no build or a build of another version, and a name two
  members share.
- **A `bun install` or `bun add` in a dependent puts the registry copies back.** Run `jive init` again afterwards.
- **Shared peers.** A linked package resolves its own imports from its checkout, so a peer it shares with the
  dependent (`effect`) is a second copy there. TypeScript needs `"preserveSymlinks": true` in the dependent's
  tsconfig to type-check against one copy, as jive's has; at run time Bun has no such option, so two copies load.

Why not bun's own mechanisms: a root `workspaces` list links a member only when its version satisfies the dependent's
range (a pin of `0.3.6` against a checkout at `0.3.7` installs the registry copy), and a `bun install` run inside a
member then writes the root lockfile instead of the member's own. `bun link` registers each package in bun's global
folder, where it replaces any globally installed package of the same name (a checkout of jive would replace the jive
you run), and its links are undone by the same `bun install`.

## How signing works

Your SSH key lives with your Jive account on [`@jive-sh/server`](https://github.com/jive-sh/server); this machine keeps
only its public key (`~/.jive/ssh/account.pub`). A session comes only from your passkey (`jive login`) or, for a
pipeline, its GitHub OIDC token (`jive login --cicd`), and is kept in `~/.jive/session.json` (owner-only). A passkey
session ends a day after its last use: each signature moves its end a day on, on the server, so a machine that signs at
least daily stays signed in, and jive asks you to sign in again only when the server refuses the session. A pipeline's
session lasts an hour.
`jive-signing-agent` serves the SSH agent protocol on `~/.jive/signing-agent.sock`: it lists the public key and sends
each request's bytes to the server's `ssh:sign`, opening the sign-in page itself when no session is live. That covers
git commit signatures and GitHub's SSH authentication alike: each repository `jive init` or `jive load` configures signs
through `jive-ssh-keygen` (ssh-keygen pointed at the agent), and fetches and pushes over SSH with `core.sshCommand`
through the agent. jive holds no GitHub token and never signs in to GitHub; GitHub must know the account key's public
half as an SSH and signing key. Signing needs `ssh-keygen` (OpenSSH) on PATH.

jive never writes to `~/.ssh`: no key file and no `~/.ssh/config` block. Everything it sets up is per repository.

## Using your Jive key for other SSH

Your Jive key works for anything that takes an SSH key, not only git and GitHub. Point the tool at two files jive
keeps: the public key, `~/.jive/ssh/account.pub`, and the agent's socket, `~/.jive/signing-agent.sock`. The agent
signs any request for that key, opening the sign-in page when no session is live, and refuses requests for any other
key. `jive-signing-agent` must be running (`jive daemons`).

**Sign in to an SSH server.** Add the contents of `~/.jive/ssh/account.pub` to `~/.ssh/authorized_keys` on the server,
then:

```sh
jive ssh connect user@host
```

which runs:

```sh
ssh -o IdentityAgent=~/.jive/signing-agent.sock -o IdentityFile=~/.jive/ssh/account.pub -o IdentitiesOnly=yes user@host
```

`jive init` writes the same options into each repository's `core.sshCommand`, from the same code. To use them without
jive, for example from a GUI client, add a block like this to your own `~/.ssh/config`:

```
Host myserver
  HostName host
  User user
  IdentityAgent ~/.jive/signing-agent.sock
  IdentityFile ~/.jive/ssh/account.pub
  IdentitiesOnly yes
```

**Sign a file, or anything else.** Use `ssh-keygen -Y sign` with your own namespace (`-n`), and `ssh-keygen -Y verify`
with an `allowed_signers` file to check it:

```sh
jive ssh sign -n file release.tar
```

which runs `SSH_AUTH_SOCK=~/.jive/signing-agent.sock ssh-keygen -Y sign -f ~/.jive/ssh/account.pub -n file release.tar`
and writes `release.tar.sig`.

What is tested, in [`src/ssh.test.ts`](src/ssh.test.ts) and
[`src/modules/signing-agent/signing-agent.test.ts`](src/modules/signing-agent/signing-agent.test.ts), with a scratch
home and a fake Jive server that signs with a key the test makes:
- `jive ssh connect` with no `account.pub` fetches it, then logs in to the sshd below through the agent and runs a
  command there; with `account.pub` kept it asks the server for no key, passes ssh's exit code on, and gives ssh a real
  terminal (`ssh -t` under `script`).
- `jive ssh sign -n file` writes a signature `ssh-keygen -Y verify` accepts, and passes ssh-keygen's exit code on.
- `jive ssh connect` and `jive init` build ssh's options from the same function, and `core.sshCommand` is unchanged
  from 0.6.0, character for character.
- `ssh` logs in to an sshd on the same machine and runs a command there. The sshd runs as the person running the
  test, and only the account key is in its `authorized_keys`. The test passes the `ssh` options above with absolute
  paths, and with `-F /dev/null`, so no `~/.ssh/config` is read.
- `ssh-keygen -Y sign -n file` signs a file through the agent, and `ssh-keygen -Y verify -n file` accepts the
  signature.

Not tested: a remote server, the `~/.ssh/config` block (it sets the same options as the command), and Linux.

## The Jive browser extension

The Jive browser extension (`@jive-sh/extension`, a proof of concept) signs this machine in to Jive and collects
credentials from the person's own signed-in browser, such as an npm token. It never holds the session: it asks
`jive-extension-daemon`, which uses the same session `jive login` keeps in `~/.jive/session.json`. The session goes
from Jive to the daemon and never passes through the browser or the extension.

- **Native host.** Chrome starts a program when the extension calls `chrome.runtime.connectNative("sh.jive.daemon")`.
  Chrome can only start a host, never attach to a running process, so `jive-native-host` relays each message to the
  daemon's socket, `~/.jive/extension-daemon.sock` (owner-only), without reading it.
- **Registration with Chrome.** At each start the daemon writes the host manifest,
  `~/Library/Application Support/{Google/Chrome,Chromium}/NativeMessagingHosts/sh.jive.daemon.json` on macOS and
  `~/.config/{google-chrome,chromium}/NativeMessagingHosts/` on Linux, only where that browser is installed. It allows
  only the Jive extension's id, which Chrome derives from the extension's public key. Windows (the registry) is not
  done yet.

### The protocol

[`src/modules/extension-daemon/protocol.ts`](src/modules/extension-daemon/protocol.ts) is the one definition, and the
extension imports it from jive's source (jive exports no library yet). Every request carries `protocolVersion`, and a
mismatch is refused with which side to upgrade.

| Request | Response |
| --- | --- |
| `GetSession` | `SignedOut`, `SigningIn { loginUrl, expiresAt }` or `SignedIn { expiresAt }` |
| `StartSignIn` | `SigningIn`, or `SignInFailed { reason }` when Jive can't be reached |
| `SignOut` | `SignedOut`. Forgets this machine's session, so `jive` and `jive-signing-agent` sign in again too. |
| `GetNpmConnectionReadiness` | `Ready` or `NotReady { reason }`. The extension asks this before it changes anything on npm. |
| `PostNpmCredential { credential: { npmUser, token, totpSecret } }` | `Posted` or `Refused { reason }` |

No response carries the session token, the claim secret or a credential.

### How the extension signs in

1. The extension's Sign in button sends `StartSignIn`.
2. The daemon signs in the way `jive login` does: it opens a sign-in request on `@jive-sh/server` and answers with its
   page, `https://jive.sh/login?request=…`.
3. The extension opens the page, and the person signs in there with their jive.sh passkey.
4. The daemon claims the request every 2 seconds. Once the person has approved it, the claim returns a session, which
   the daemon stores in `~/.jive/session.json`. The extension sees `SignedIn` on its next `GetSession`.

A daemon restart drops a sign-in still waiting, because the claim secret is kept in memory only. A stored session
survives restarts until it expires.

**Not decided yet: who accepts the npm credential.** Either jive.sh or `@jive-sh/server`, which holds npm connections,
could. Posting is behind `INpmCredentialPoster` ([`src/modules/npm-credential-poster/interface.ts`](src/modules/npm-credential-poster/interface.ts)).
Until the decision, the daemon ships `NpmCredentialPosterNotDecidedImpl`, which answers `NotReady` with that reason,
so the extension stops before it touches npm.

## Developing

```sh
bun install
bun run jive:cicd:audit   # type check and tests
bun run install:local     # build with the jive-abstract-library checkout beside this one, install globally
```

Tests never reach jive.sh, the server or GitHub. The signing agent's tests run the real `ssh-keygen` and `ssh-add`
against a fake server; `src/workspace-cutover.test.ts` runs `jive init` on a scratch workspace with nested submodules,
signs a commit through the agent and pushes it over SSH to a local sshd. The extension daemon's tests
([`src/modules/extension-daemon/extension-daemon.test.ts`](src/modules/extension-daemon/extension-daemon.test.ts)) run the
daemon against a fake server and speak Chrome's framing to the native host started from the manifest the daemon
wrote: sign-in end to end into `~/.jive/session.json`, a session `jive login` stored, a restart, posting, sign-out,
protocol refusal, a second daemon standing down, and the native host reporting a stopped daemon. Not covered by tests:
registration with the OS service manager, the compiled binary under a real Chrome, Linux, and Windows.
