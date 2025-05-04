#!/bin/bash
cur_dir=$(pwd)
cli_dir="${cur_dir}/packages/cmds/chaine"
cd $cli_dir
npx --quiet pnpm install
# Load HCP env vars if doing local dev
if [ -f ./.env ]; then
  echo "loading .env"
  set -o allexport
  source ./.env
  set +o allexport
else
  echo "no .env detected"
fi
cd $cur_dir
alias chaine="npx --quiet tsx ${cli_dir}/src/index.tsx"