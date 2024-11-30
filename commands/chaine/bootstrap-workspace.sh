#!/bin/bash
if ! command -v bun; then
  npm install -g bun
fi
cur_dir=$(pwd)
cli_dir="${cur_dir}/commands/chaine"
cd $cli_dir
bun install
cd $cur_dir
alias chaine="bun ${cli_dir}/src/index.tsx"
