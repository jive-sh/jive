import * as path from 'path';
import * as YAML from 'yaml';
import * as fs from 'fs';
import { run } from '../../../../common/run';

export function buildApp({projectPath, packageName}: {projectPath: string; packageName: string;}) {
    run('npx pnpm expo export --platform web', projectPath);
    const lockfilePath = path.resolve(projectPath, 'pnpm-lock.yaml');
    const lockfile = YAML.parse(fs.readFileSync(lockfilePath).toString());
    const packages: Record<string, {resolution: {integrity: string}}>
      = lockfile.packages;
    const requiredPackage = 'expo-router'
    const installedPackage = Object.keys(packages)
      .find(pkg => pkg.startsWith(`${requiredPackage}@`));
    if (installedPackage === undefined) {
      console.log(`Error: no package named '${requiredPackage}' in lockfile.`);
      
      return;
    }
    const version = installedPackage.split('@')[1];
    const buildSubdir = 'build';
    const buildPath = path.resolve(projectPath, buildSubdir);
    run(`rm -rf ./${buildSubdir}`, projectPath);
    fs.mkdirSync(buildPath);
    const originalDistPath = path.resolve(projectPath, 'dist');
    const newDistPath = path.resolve(buildPath, 'dist');
    fs.renameSync(originalDistPath, newDistPath);
    const buildPackageJson = path.resolve(buildPath, 'package.json');
    const serviceFilename = 'service.js';
    fs.writeFileSync(buildPackageJson, JSON.stringify({
      name: `${packageName}-export`,
      version: `1.0.0`, // TODO: some kind of verison bumping needed.
      dependencies: {
        [requiredPackage]: version
      },
      bin: {
        service: `./${serviceFilename}`
      }
    }, null, 2));
    run('npx pnpm install', buildPath);
    const serveFilePath = path.resolve(buildPath, serviceFilename);
    fs.writeFileSync(serveFilePath, [
      '#!/usr/bin/env node',
      "require('child_process')",
      "  .execSync('expo serve', {stdio: 'inherit', cwd: __dirname})",
      ""
    ].join("\n"));
    run(`chmod +x ${serviceFilename}`, buildPath);
    run('npx pnpm pack', buildPath);
    console.log(fs.readdirSync(buildPath));
}