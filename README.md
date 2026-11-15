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

Installing registers `jive-daemon` to start at login (a LaunchAgent on macOS, a
`systemctl --user` unit on Linux, which starts at boot because the installer turns on `loginctl enable-linger` for
you, a scheduled task on Windows).

## Commands

| Command | What it does |
| --- | --- |
| `jive login` | Opens `https://jive.sh/login?request=…`, where you sign in with your jive.sh passkey, and waits; then prints the account you signed in as, saves its handle beside the session, and fetches your account's public key (`ssh:publicKey`) into `~/.jive/ssh/account.pub`. |
| `jive login --cicd` | In a GitHub Actions job with `id-token: write`: exchanges the job's ID token for a session of its pipeline. |
| `jive whoami` | Prints the handle of the Jive account this machine is signed in as, as `jive-daemon` reports it. When the server can't be reached it prints the handle saved at the last check, followed by `(not confirmed: can't reach Jive's server)`. |
| `jive init` | In the git repository you are in, rewrites every .gitmodules at every depth to `https://github.com/<owner>/<repo>`, syncs them, checks out every submodule not yet checked out (one already checked out keeps its HEAD), and configures the root, every submodule and every untracked repository inside it: `gpg.format=ssh`, `user.signingKey` (the account key's public half), `commit.gpgSign=true`, `gpg.ssh.program=jive-ssh-sign`, `core.sshCommand=jive-ssh`, `ssh.variant=ssh`, and `url."git@github.com:".insteadOf "https://github.com/"` so https URLs fetch and push over SSH. Then links the packages among those repositories with each other (see Workspace links). Nothing else, and no GitHub sign-in. Safe to run again: a submodule already checked out keeps its HEAD, and the links are made again. |
| `jive load <org> <repo>` | Adds a GitHub repo to the workspace as a submodule by its https URL, fetches its submodules, configures it and them as `jive init` does, runs `bun install` in it, then links it with the workspace's packages: its workspace dependencies into it, and it into every workspace package that depends on it. |
| `jive unload <org> <repo>` | Removes every workspace link into the repo, running `bun install` in each package that had one so it gets its registry copy back, then removes the repo. |
| `jive on <org> <repo> -- <command…>` | Runs a command in a loaded repo's directory; its exit code is jive's. |
| `jive provision <kind> <name>` | Makes sure a resource instance exists, e.g. `jive provision connector-package-registry @scope/name`. The instance is `./package.json`'s `jive.resources.<kind>.<name>`, or `--instance '<json>'`. Needs a pipeline session. |
| `jive daemons` | Lists every Jive daemon registered on this machine, with its state, executable and log. |
| `jive upgrade` | Upgrades jive with the package manager that installed it. |

`--help`, `--version` and Tab completion (`jive --setup-completion`) work as for every command built with
`jive-abstract-library`'s `Cli`.

Two more commands are installed beside `jive`, for git and for you:

| Command | What it does |
| --- | --- |
| `jive-ssh <ssh arguments…>` | ssh with your Jive key and no other: runs `ssh -o IdentityAgent=~/.jive/signing-agent.sock -o IdentityFile=~/.jive/ssh/account.pub -o IdentitiesOnly=yes <ssh arguments…>`, after asking `jive-daemon` whether the key can sign (see How signing works). git runs it as `core.sshCommand`. ssh's exit code is its own; a refusal exits 255, as ssh does. |
| `jive-ssh-sign <ssh-keygen arguments…>` | git's `gpg.ssh.program`: stock ssh-keygen with every argument unchanged and `SSH_AUTH_SOCK` set to the agent's socket, so `-Y sign -f ~/.jive/ssh/account.pub` signs with your Jive key. Before `-Y sign` it makes the same check; git's other uses (`-Y verify`, `-Y find-principals`, `-Y check-novalidate`) and anything else run as plain ssh-keygen would. ssh-keygen's exit code is its own. |

`jive-ssh-keygen`, the signing program jive 0.7.0 configured, is still installed but only refuses: git shows
`jive-ssh-keygen was replaced by jive-ssh-sign in jive 0.8.0; run jive init in <repository> to update its git config`.
A repository 0.7.0 configured keeps pushing, since its `core.sshCommand` names the same agent socket.

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
pipeline, its GitHub OIDC token (`jive login --cicd`), and is kept in `~/.jive/session.json` (owner-only), with the
handle of its account as the server last confirmed it. A passkey session ends a day after its last use: each signature
moves its end a day on, on the server, so a machine that signs at least daily stays signed in; once the server refuses
the session, signing stops and says to run `jive login`. A pipeline's session lasts an hour.
`jive-daemon` serves the SSH agent protocol on `~/.jive/signing-agent.sock`: it lists the public key and sends
each request's bytes to the server's `ssh:sign`. It never signs you in: with no live session it refuses. That covers
git commit signatures and GitHub's SSH authentication alike: each repository `jive init` or `jive load` configures signs
through `jive-ssh-sign` and fetches and pushes over SSH through `jive-ssh`. jive holds no GitHub token and never signs
in to GitHub; GitHub must know the account key's public half as an SSH and signing key. Signing needs `ssh` and
`ssh-keygen` (OpenSSH) on PATH.

The SSH agent protocol refuses with one byte and no reason, which ssh reports as `agent refused operation` and then
`Permission denied (publickey)`. So before ssh or ssh-keygen runs, `jive-ssh` and `jive-ssh-sign` ask `jive-daemon` on
its own socket, `~/.jive/jive-daemon.sock`, who is signed in (`GetSession`, which checks with the server), and stop
with the reason when the key can't sign:

```text
jive-ssh: not signed in to Jive; run `jive login`
jive-ssh: your computer can't reach Jive's server (https://…) to sign as <you>; reconnect and run the command again
jive-ssh: jive's daemon is not running; run `jive daemons` to see why; `jive upgrade` registers and starts it again, and so does logging in again
```

`jive-ssh-sign` says the same, named `jive-ssh-sign:`. The server check gives up after 5 seconds, so a network that
swallows requests reads as unreachable.

jive never writes to `~/.ssh`: no key file and no `~/.ssh/config` block. Everything it sets up is per repository.

## Using your Jive key for other SSH

Your Jive key works for anything that takes an SSH key, not only git and GitHub. `jive-ssh` stands in for ssh and
`jive-ssh-sign` for ssh-keygen; signing with either needs `jive-daemon` running (`jive daemons`).

**Sign in to an SSH server.** Add the contents of `~/.jive/ssh/account.pub` to `~/.ssh/authorized_keys` on the server,
then:

```sh
jive-ssh user@host
```

Every argument goes to ssh after jive's three options. ssh keeps the first value of an option, so `jive-ssh` names on
stderr each option of yours that changes nothing or more than you may expect:

```text
$ jive-ssh -o IdentitiesOnly=no -o IdentityFile=~/.ssh/other -A user@host
jive-ssh: warning: -o IdentitiesOnly=no has no effect: jive-ssh passes IdentitiesOnly=yes first, and ssh keeps the first value
jive-ssh: warning: -o IdentityFile=~/.ssh/other adds a second key: ssh offers your Jive account key, ~/.jive/ssh/account.pub, first, then ~/.ssh/other
jive-ssh: warning: -A forwards jive's agent: while you are connected, the remote host can sign as <you> with your Jive key
```

`-i` is refused, even naming the Jive key: `jive-ssh` always logs in with your Jive key, so log in with another key
with plain `ssh -i <key>`. `-G`, which only prints ssh's configuration, runs without asking the daemon.

To use the key without jive, for example from a GUI client, add a block like this to your own `~/.ssh/config`. That
client talks to the agent directly, so a refusal there reads only `agent refused operation`; `jive whoami` says why.

```
Host myserver
  HostName host
  User user
  IdentityAgent ~/.jive/signing-agent.sock
  IdentityFile ~/.jive/ssh/account.pub
  IdentitiesOnly yes
```

**Sign a file, or anything else.** Use `jive-ssh-sign -Y sign` with your own namespace (`-n`), and `ssh-keygen -Y
verify` with an `allowed_signers` file to check it:

```sh
jive-ssh-sign -Y sign -f ~/.jive/ssh/account.pub -n file release.tar
```

which runs `SSH_AUTH_SOCK=~/.jive/signing-agent.sock ssh-keygen -Y sign -f ~/.jive/ssh/account.pub -n file
release.tar` and writes `release.tar.sig`.

What is tested, in [`src/ssh.test.ts`](src/ssh.test.ts),
[`src/modules/signing-agent/signing-agent.test.ts`](src/modules/signing-agent/signing-agent.test.ts) and
[`src/workspace-cutover.test.ts`](src/workspace-cutover.test.ts), with a scratch home and a fake Jive server that
signs with a key the test makes and can be made unreachable:
- `jive-ssh` and `jive-ssh-sign` run as processes, as git runs them, against jive-daemon's two sockets. `jive-ssh` logs
  in to an sshd on the same machine that accepts only the account key, passes git's `-o SendEnv=GIT_PROTOCOL` and
  ssh's exit code on, and prints nothing of its own. `jive-ssh-sign -Y sign` signs through the agent, and
  `-Y verify`, `-Y find-principals`, `-Y check-novalidate`, `-l` and key generation pass to ssh-keygen unchanged
  without asking the daemon.
- Not signed in, the server unreachable and the daemon not running: each command prints exactly the line above, exits
  255, and nothing signs or opens a sign-in. `-i` in each spelling is refused with its message; the ignored `-o`
  options and `-A` warn with the lines above; `-G` prints exactly what plain ssh with jive's options prints.
- `jive whoami` prints the confirmed account, the saved one marked unconfirmed while offline, and the fix when signed
  out or when no daemon runs.
- Upgrading from 0.7.0 ([`src/upgrade-from-0.7.0.test.ts`](src/upgrade-from-0.7.0.test.ts)): the built installer removes the
  `jive-signing-agent` and `jive-extension-daemon` registrations and stops them, and `jive-daemon`, registered in their
  place, waits for them to exit and serves both sockets. The service manager is a fake that, like launchd's `bootout`,
  returns before a stopped daemon has exited; the test needs `bun run jive:cicd:build` first, and CI runs it.
- The agent refuses a sign request with no session, and one whose session the server has ended, without opening a
  sign-in; an unreachable server fails a sign request without asking the server a second time.
- After `jive init`, a commit is signed through `jive-ssh-sign`, verifies, and is pushed through `jive-ssh` to the
  sshd.

Not tested: a remote server, the `~/.ssh/config` block (it sets the same options as `jive-ssh`), and Linux.

## The Jive browser extension

The Jive browser extension (`@jive-sh/extension`, a proof of concept) signs this machine in to Jive and collects
credentials from the person's own signed-in browser, such as an npm token. It never holds the session: it asks
`jive-daemon`, which uses the same session `jive login` keeps in `~/.jive/session.json`. The session goes
from Jive to the daemon and never passes through the browser or the extension.

- **Native host.** Chrome starts a program when the extension calls `chrome.runtime.connectNative("sh.jive.daemon")`.
  Chrome can only start a host, never attach to a running process, so `jive-native-host` relays each message to the
  daemon's socket, `~/.jive/jive-daemon.sock` (owner-only), without reading it.
- **Page script.** On `https://www.npmjs.com/*` and `https://npmjs.com/*`, `page.js` runs in the page's own world at
  the start of the document and wraps `navigator.credentials.create` and `get` only when the call carries `publicKey`.
  An isolated script relays that ask to the service worker, which is the only extension page that calls `connectNative`.
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
| `GetSession` | `SignedOut`, `SigningIn { loginUrl, expiresAt }`, `SignedIn { username, expiresAt, confirmedByServer, unreachableServerUrl }`, or `Failed { message }` when the server refused to check the session. `confirmedByServer` is false when the server could not be reached: `username` and `expiresAt` are then the ones saved at the last check, and `unreachableServerUrl` names the server. `jive-ssh`, `jive-ssh-sign` and `jive whoami` send it on the daemon socket directly. |
| `StartSignIn` | `SigningIn`, or `SignInFailed { reason }` when Jive can't be reached |
| `SignOut` | `SignedOut`. Forgets this machine's session, so `jive` signs in again too. |
| `GetNpmConnectionReadiness` | `Ready` or `NotReady { reason }`. The extension asks this before it changes anything on npm. |
| `PostNpmCredential { credential: { npmUser, token } }` | `Posted` or `Refused { reason }` |
| `PrepareSigningPasskey { repositoryOwner, repositoryName }` | `SigningPasskeyPrepared`. Stores that repository in `~/.jive/signing-passkey-repository.json` and uses it after a restart. Sent on the daemon socket by the program that opens npm's page, because the page does not name a repository. |
| `AnswerSecurityKey { kind, challenge, rpId, origin, crossOrigin }` | `SecurityKeyAnswer` or `SecurityKeyRefused { reason }`. `kind` is `create` or `get`. `challenge` is the page's challenge, base64url. The answer's byte strings are standard base64: `credentialId`, `clientDataJSON`, `authenticatorData`, `signature`, and `attestationObject` on `create` only. The daemon sends `authenticatorData` concatenated with the SHA-256 of `clientDataJSON` to `signingPasskey:sign`. The server returns raw ECDSA `r‖s` and does not interpret those bytes. |

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
