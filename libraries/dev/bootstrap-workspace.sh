#!/bin/bash
if ! command -v bun; then
  npm install -g bun
fi
cur_dir=$(pwd)
dev_dir="${cur_dir}/libraries/dev"
cd $dev_dir
bun install
cd $cur_dir
alias dev="bun ${dev_dir}/src/index.ts"
