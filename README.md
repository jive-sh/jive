# Jive

The Jive CLI. Dev tool for creating convex + expo apps across git submodules

Trying to use omelette for autocomplete

# long term goals for services

there should be no dockerfiles per service. Instead all services have same dockerfile (it bun installs then runs the service's published npm mmodule. no other dockerfile needed in this world.) There should also be an option to specify sidecars by name. The name should refer to a blank alpine image with all  necessary software such that a `COPY / /` will bring everything over for that sidecar.

# long term goals for docker

- All services are NPM registry published (on github) CLIs which run on the "service" docker image.
- All docker images are published to a private github image registry
- Only the changed docker images are rebuilt plus the images which transitively depend on them
- All docker images MUST have an Alpine base (because of the size optimized properties)
- A docker image that is meant to be a dependency should copy in only the bare minimum executables and binaries needed for those executables above a `scratch` base such that the consumer can copy in everything from that dependency via a `COPY --from=<dependency> / /` Docker command

# Cloudflare

Secrets cached locally but decryption key is in cloudflare?
Might as well get everything at runtime when needed

# CLI docs

TODO: https://github.com/Effect-TS/effect/issues/5630

TODO: "postinstall": "jive install"

Idea: perhaps have a plugins repo which a jive workspace points to

```
jive
  on <org/repo>
    git <git command(s)>
    run <bun command(s)>
    [PLUGIN] expo
    [PLUGIN] k8s
    [PLUGIN] tunnel
  link
    repo <org/repo>
  unlink
    repo <org/repo>
  load
    repo <org/repo>
    plugin <plugin name>
  unload
    repo <org/repo>
    plugin <plugin>
  [PLUGIN] templatize <org/repo> <template>
  [PLUGIN] create <template name> <org/repo>
  init
  update
    everything
    repo <org/repo>
    plugin <plugin>
  user
    list
    login <email>
    logout <email>
    switch <email>
```

# Package Naming convention

- `jive-templates-<template name>`
- `jive-plugins-<plugin name>`
- `@jive-it/<library name>`

# Template structure

```
<some file>.ejs
package.json
  jive: {
    substitutions: {
      "some-arg": "description"
    }
  },
```
