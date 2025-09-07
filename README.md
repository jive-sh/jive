# Jive

The Jive CLI. Dev tool for creating convex + expo apps across git submodules

# long term goals for services

there should be no dockerfiles per service. Instead all services have same dockerfile (it bun installs then runs the service's published npm mmodule. no other dockerfile needed in this world.) There should also be an option to specify sidecars by name. The name should refer to a blank alpine image with all  necessary software such that a `COPY / /` will bring everything over for that sidecar.

# long term goals for docker

- All services are NPM registry published (on github) CLIs which run on the "service" docker image.
- All docker images are published to a private github image registry
- Only the changed docker images are rebuilt plus the images which transitively depend on them
- All docker images MUST have an Alpine base (because of the size optimized properties)
- A docker image that is meant to be a dependency should copy in only the bare minimum executables and binaries needed for those executables above a `scratch` base such that the consumer can copy in everything from that dependency via a `COPY --from=<dependency> / /` Docker command

# CLI docs

```
jive
  clone <org name> <repo name>
  drop <repo name>
  init
  start [expo, convex] <repo name>
  login [github, cloudflare, k8s] <username>
  logout [github, cloudflare, k8s] <username>
  create [expo, convex-backend, convex-component, lib, k8s-service, contract] <org name> <repo name>
```