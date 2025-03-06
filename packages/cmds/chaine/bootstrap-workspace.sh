#!/bin/bash
if ! command -v tsx; then
  npm install -g tsx
fi
if ! command -v pnpm; then
  npm install -g pnpm
fi
cur_dir=$(pwd)
cli_dir="${cur_dir}/packages/cmds/chaine"
cd $cli_dir
pnpm install
cd $cur_dir
alias chaine="tsx ${cli_dir}/src/index.tsx"
