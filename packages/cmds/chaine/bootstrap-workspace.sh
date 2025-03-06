#!/bin/bash
cur_dir=$(pwd)
cli_dir="${cur_dir}/packages/cmds/chaine"
cd $cli_dir
npx --quiet pnpm install
cd $cur_dir
alias chaine="npx --quiet tsx ${cli_dir}/src/index.tsx"
