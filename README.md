# chaine

The Chaîné monorepo

# tech stack

- cdK8s
- Kafka (will do reverse ETL pattern if needed)
- Expo for mobile and web (React native web)
- GraphQL w/ Hasura atop a Postgres DB
- genql GraphQL client
- [Hashicorp Vault](https://www.youtube.com/watch?v=VYfl-DpZ5wM) for secrets management
- services emit open telemetry and it's consumed by prometheus, loki. grafana for observability viz ([article](https://mrintegrity.medium.com/monitoring-from-scratch-ea2b83a8f8a5))

# organization

- libraries & services top level folders
- no other files besides README and LICENSE allowed at top level
- no nested services or libraries allowed
- 1 pnpm lockfile per service (don't have services share lockfiles as this slows down builds over time)
- 1 unique pipeline per service / library managed by GHA
- lib or service must have 3 folders: `tests`, `source`, `cicd`
- service must also have an `infra` folder w/ an index.ts containing cdk8s code
