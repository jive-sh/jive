
Imagine you're running a software company. Your app becomes bloated so you start organizing the code. Creating clear isolation boundaries between modules.
Now you have 10 apps and 100 libraries shared between them. You want things to be as seamless as when you had a monolith. When one thing is checked in, everything that
depends on it needs to be rebuilt and deployed. So you go with a monorepo. But your company continues to grow and monorepo pain-points start showing themselves:
- The team that owns library "Brittle" isn't very disciplined with their coding practices; their changes are always breaking the pipelines of other team's apps and libraries, notably the pipeline of the "Mission Critical" app.
- People keep violating the boundaries that the modules are supposed to be setting, they keep writing code which references code outside the immediate module using relative path imports. It's difficult to know how much dependencies are being properly managed by standard package dependency rules and how much is just relative links across the massive codebase.
- It's a pain to view all the unrelated code to your project. All these PRs and Issues and Commits unrelated to your project. You keep reaching for other tools to try to manage the flood of irrelevant information but it always feels like putting band-aids on bullet holes.
So you go poly-repo. Every package and app is its own repo now, no more commit, issue, and PR noise. No more relative path dependencies. Packages are published to a registry now. Services can isolate themselves from packages that keep breaking things.

But now you have a new set of problems
- Your infra team upgrades a crucial auth package, it takes 1 month of dev work to implement, but then to their dismay it takes 2 months to coordinate upgrading the package across all 200 repos which depend on it.
- Libraries change frequently but the code that depends on them isn't being kept up to date. Apps and libraries fall behind. So much underlying drift happens that it feels too daunting for teams to update their dependencies
- Git operations on their own become tedious between all these repos. When dealing with one repo, committing, PRs, pulling was trivial, but trying to do this constantly with 50 repos means the devs are spending just as much time pulling down new code as they are actually doing their job.
- Local development is not well understood. Hacks are created every time someone wants to work on two packages at the same time.

What I've described is the hell I've seen at every large software company I've ever worked at.

My conclusion that both monorepos and poly-repo is unacceptable.

One tool that stands out to me was from my time at Amazon, a tool called Brazil. In Brazil you have a workspace. You pull down other repos using brazil commands; brazil auto links the new repo to the others which depend on it for local dev. That solves the local dev and git workflow pieces but not the dependency upgrade parts. Amazon's VersionSet solution to dependency management is completely broken and time destroying though it does attempt to solve the problem.

# Introducing Jive

Introducing Jive. The aim here is to get all the upsides of poly-repo and monorepo with none of the downsides.

In general a core philosophy is that manual steps take away attention and focus. And that having even a small number of manual steps per repo (like cloning, version bumping) will kill any company since a well organized codebase and a code base which wishes to leverage the open source community in my opinion requires package versioning and separation into repos.

- Jive repos should update when their dependencies update. No manual intervention required for minor changes, only for "consequential" ones. There should be a [sensible default](https://en.wikipedia.org/wiki/Convention_over_configuration) which balances between keeps rebuilds as automated as possible while also requiring human intervention at smart points to prevent broken code blocking everyone else. The way we do this is by building on top of [Renovate](https://github.com/renovatebot/renovate). Renovate will create auto-merging PRs whenever a dependency changes so your polyrepo starts getting updated like a monorepo. You can configure jive to mark certain libraries that should not be auto updated or should require manual review before merging.
- Jive should automate version bumping within a repo, using [api-extractor](https://api-extractor.com/) to deterministically compute a semver bump based on the package's generated typescript types. In the future there can be a configurable way to set the algorithm which determines the semver for cases where there aren't really typescript types (like when we do docker image maintenance via jive)
- Jive should make working with poly-repos feel like a monorepo as much as possible, similar to the cloning and linking automation which Amazon's Brazil provides. To do this, commands such as `jive load` will manage cloning a repo and linking it to all other repos  and installing dependencies (via bun), and `jive login` will authenticate via GitHub in the browser, switch the git user across all loaded repos, enable verified commits via SSH signing, and warn for any repos the account lacks access to, and Jive will also run a daemon which keeps your other loaded repos up-to-date (so long as they're on mainline and not dirty). `jive create` will not only create a new repo locally, but also take care of setting the repo up in github and npm.

# Conventions

- Jive will automate your tsconfig.json and renovate.json. Some overrides are possible but it's limited.
- Jive will to some degree automate your gitignore
- Jive has a simple github workflow action which will
  - Run the package.json build command then test command then the deploy command
  - If all the above are successful, trigger version bump PRs for all packages depending on this one

# Templates

Jive has simple rules, templates allow for standard behaviors from types of packages and clean code (virtually no configuration files).

A template must provide specific functionality
- A standard build command
- A schema for template inputs. For example an expo template would take the domain name as an argument
- A standard deploy command. For example an expo deploy would create a new expo app via the expo cli then copy the package's src folder into that expo app's src folder, then build and deploy that expo app.
- Actual codegen template files. A `jive templatize` exists to take an existing instance of template and upstream its instantiation into a the template definition.

At the end of the day, a template is just another library.

# long term goals for services

Let's imagine the Jive philosophy applied to microservices.

There should be no dockerfiles per service. Instead all services use the same dockerfile defined in some generic service-deploy Jive plugin (it bun installs then runs the service's published npm module). There should maybe be an option to specify sidecars by name.

# long term goals for docker

Let's think about how Jive would manage docker image updates

Let's say you want control over the dockerfile which all services run on. You create a custom Jive deploy plugin which depends on the dockerfile you chose. The dockerfile is modelled as a npm package (Dockerfile emitted to /dist and the deploy step publishes to dockerhub). Dependencies are the npm packages of other docker images. The build step goes through all docker image dependencies then assembles a Dockerfile which looks like this

```
COPY --from=<dependencyA:version> / /
COPY --from=<dependencyB:version> / /
```

where the leaf dependencies are docker images made from `scratch` which just copy in the bare minimum binaries and libraries from an Alpine build of some software. With the existing Jive infra, you get a graph of docker images which update together. Change the "bun" docker image for example and then all services will update.

# CLI docs

TODO: https://github.com/Effect-TS/effect/issues/5630

```
jive
  on <org> <repo> <arbitrary commands>
  load <org> <repo>
  unload <org> <repo>
  templatize <org> <repo> <template name>
  create <template name> <org> <repo>
  init
  login
  daemon
```

# Technical details regarding Jive

- When you sign in to Jive, it needs programmatic access to various tools.

## Configuration

Jive has no config file. Instead, jive walks upward from the current directory until it finds a `.jive` folder. This folder stores workspace state, credentials, and API keys (to be encrypted via yubikey). Place `.jive` at the root of your workspace.

```
.jive/
  state     # loaded repos, workspace topology
  keys/     # github tokens, npm tokens, etc. (yubikey-encrypted)
```

## Autocomplete

Using this for autocomplete https://github.com/f/omelette


## Package Naming convention

- `jive-templates-<template name>`

## Template structure

```
<some file>.ejs
package.json
  jive: {
    substitutions: {
      "some-arg": "description"
    }
  },
```

And then when you run jive create you'll have to pass in required args based on the substitutions
