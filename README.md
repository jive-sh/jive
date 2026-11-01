# Jive

Jive is a developer platform and an agentic workforce platform.

- **Developer platform:** the `jive` CLI in this repository; the CI/CD pipeline every Jive package runs (its
  [reusable workflow](.github/workflows/reusable-pipeline.yml) lives here, its contract in [CICD_API.md](CICD_API.md));
  and resource provisioning, which makes sure each resource a package declares exists in its organization.
- **Agentic workforce platform:** workforces of agents that run an organization's work. A software factory is one
  kind of workforce; binary decompilation is another; a business with its various operations is another.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/jive-platforms-dark.svg">
  <img alt="Agentic workforce, the outer circle, holding three separate circles: software factory, binary decompilation, and a business and its operations" src="docs/jive-platforms-light.svg" width="480">
</picture>

## The `jive` CLI

`@jive-sh/jive` signs you in to Jive, signs your git commits and GitHub pushes with your Jive account's SSH key, which
lives on [`@jive-sh/server`](https://github.com/jive-sh/server) and never on your machine, and loads repos into a
workspace. It replaces `@ozyman42/ozy-cli` ([what changed](docs/ozy-cli-migration.md)). It is built and published by
[`jive-abstract-library`](https://github.com/jive-sh/jive-abstract-library) like any Jive command package.

## Install

```sh
bun add -g @jive-sh/jive
```

Installing registers `jive-signing-agent` to start at login (a LaunchAgent on macOS, a `systemctl --user` unit on
Linux, a scheduled task on Windows).

## Commands

| Command | What it does |
| --- | --- |
| `jive login` | Signs this machine in to Jive: prints a confirmation code and opens `https://jive.sh/login?request=…`, where you check the code and approve with your jive.sh passkey. Then fetches your account's public key, which the server creates on first use. |
| `jive login --cicd` | In a GitHub Actions job with `id-token: write`: exchanges the job's ID token for a session of its pipeline. |
| `jive provision <kind> <name>` | Makes sure a resource instance exists through the server's `provision`, e.g. `jive provision connector-package-registry @scope/name`; the organization's configured implementation (npm for jive-sh) does it. The instance is `./package.json`'s `jive.resources.<kind>.<name>`, or `--instance '<json>'`. Needs a pipeline session (`jive login --cicd`). |
| `jive whoami` | Prints the Jive account (`<handle>@jive.sh`) this machine is signed in as. |
| `jive load <org> <repo>` | Adds a GitHub repo to the workspace as a submodule by its https URL, fetches its own submodules recursively, registers your account key on GitHub as an authentication and signing key, configures the repo and every submodule under it to sign commits and tags and push through the signing agent, then runs `bun install` and `bun link`. |
| `jive unload <org> <repo>` | Removes a loaded repo. |
| `jive on <org> <repo> -- <command…>` | Runs a command in a loaded repo's directory; its exit code is jive's. |
| `jive daemons` | Lists every Jive daemon registered on this machine, with its state, executable and log. |
| `jive upgrade` | Upgrades jive with the package manager that installed it. |

`jive --help`, `--version` and Tab completion (`jive --setup-completion`) work as for every command built with
`jive-abstract-library`'s `Cli`. What changed from ozy-cli, and why: [docs/ozy-cli-migration.md](docs/ozy-cli-migration.md).

## How signing works

1. **Sessions.** A session is obtained only by a person's passkey (`jive login`, or the agent asking when it needs
   one) or, for a pipeline, by exchanging its GitHub OIDC token (`jive login --cicd`, which calls the server's
   `pipelineSessions:signIn` with an ID token minted for `https://api.jive.sh`). There is no other way: no pasted tokens and no local keys. `jive login` opens a sign-in request
   (`signInRequests:open`), shows its code and page, and claims the session (`signInRequests:claim`) every 2 seconds
   until you approve it. The session token goes to `~/.jive/session.json`, readable by you only. A session lasts 12
   hours.
2. **The key.** `ssh:createKey` makes your account's ed25519 key on the server the first time and returns its public
   key, which jive keeps at `~/.jive/ssh/account.pub`. The private key never leaves the server.
3. **The agent.** `jive-signing-agent` serves the SSH agent protocol on `~/.jive/signing-agent.sock` (owner-only). It
   lists the public key and forwards each sign request's bytes to `ssh:sign` with the session token, returning the
   server's signature. With no live session it opens a sign-in request itself: it opens the page and, on macOS,
   shows the code in a notification. A session the server revoked early is dropped and signed in again once. A
   second installed copy of jive finds the first agent's pidfile (`~/.jive/signing-agent.pid`) and stands down.
4. **Git.** `jive load` sets, per repository: `user.signingKey` to the public key file,
   `gpg.format=ssh`, `gpg.ssh.program` to `jive-ssh-keygen` (ssh-keygen pointed at the agent's socket),
   `commit.gpgSign` and `tag.gpgSign`, and `core.sshCommand` to ssh with the agent as `IdentityAgent`. Your
   `~/.ssh/config` is left alone, so github.com connections outside these repositories are unchanged.

Signing needs `ssh-keygen` (OpenSSH) on PATH, as git's own SSH signing does.

## Workspaces

`jive load`, `unload` and `on` work in a workspace: the nearest directory holding a `.jive/` directory. Loaded repos
live at `@<org>/<repo>` under it. The GitHub sign-in a workspace uses for cloning (read through `git-credential-jive`,
which `jive load` sets as each repo's credential helper) is kept in `.jive/users/`. Loaded repos fetch over HTTPS and
push over SSH.

## Developing

```sh
bun install
bun run jive:cicd:audit   # type check and tests
bun run install:local     # build with the jive-abstract-library checkout beside this one, install globally
```

Tests never reach jive.sh, the server or GitHub: the signing agent's tests run the real `ssh-keygen` and `ssh-add`
against the agent with a fake server, and the workspace tests use local bare repos.

## Direction

- Repo creation from an abstract: `jive create <kind>` resolves `jive-abstract-<kind>`.
