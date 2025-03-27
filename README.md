# chaine

The Chaîné monorepo

# development

All work is done through the `chaine` CLI.
Install node then run `source ./startup.sh` to make it available.

# tech stack

- cdK8s
- Kafka (will do reverse ETL pattern if needed)
- Expo for mobile and web (React native web)
- Convex
- [Hashicorp Vault](https://www.youtube.com/watch?v=VYfl-DpZ5wM) for secrets management
- services emit open telemetry and it's consumed by prometheus, loki. grafana for observability viz ([article](https://mrintegrity.medium.com/monitoring-from-scratch-ea2b83a8f8a5))
- backstage for service registry and team configuration
- https://spot.rackspace.com/ or Digital Ocean for K8s hosting (currently using DO)

# organization

- libraries, services top level folders
- no other files besides README and LICENSE allowed at top level
- no nested services or libraries allowed
- 1 bun lockfile per service (don't have services share lockfiles as this slows down builds over time)
- 1 unique pipeline per service / library managed by GHA
- lib or service must have 3 folders: `src`, `cicd`
- service must also have an `infra` folder w/ an index.ts containing cdk8s code (seems wrong tbh why does a service own infra?)

# invariants

- package name must start with `@chaine/lib-` `@chaine/cli-` or `@chaine/svc-`

# long term goals

- there should be no dockerfiles per service. Instead all services have same dockerfile (it bun installs then runs the service's published npm mmodule. no other dockerfile needed in this world.) There should also be an option to specify sidecars by name. The name should refer to a blank alpine image with all  necessary software such that a `COPY / /` will bring everything over for that sidecar.

# AI Tools to evaluate
https://addyo.substack.com/p/ai-driven-prototyping-v0-bolt-and
- bolt
- v0
- Lovable
- Cursor
- Windsurf