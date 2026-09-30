import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_VERSION } from './binary.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(DIR, '..');
const watching = process.argv.includes('--watch');
const watch = watching ? ['--watch'] : [];

const compiler: ChildProcess | null = watching
  ? spawn(
      process.execPath,
      [
        createRequire(import.meta.url).resolve('typescript/bin/tsc'),
        '-w',
        '-p',
        path.join(PROJECT_DIR, 'tsconfig.build.json'),
        '--preserveWatchOutput',
      ],
      { stdio: 'inherit', env: process.env },
    )
  : null;

// A binary runs itself once per role; a checkout runs each compiled entry.
const roles = BINARY_VERSION ? [['hub'], ['node']] : ['entry-hub.js', 'entry-node.js'].map((entry) => [...watch, path.join(DIR, entry)]);
const children: ChildProcess[] = roles.map((args) => spawn(process.execPath, args, { stdio: 'inherit', env: process.env }));

let exiting = false;
function stopAll(code: number): void {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  if (compiler && compiler.exitCode === null) compiler.kill('SIGTERM');
  process.exitCode = code;
}

for (const child of children) child.on('exit', (code, signal) => stopAll(code ?? (signal ? 1 : 0)));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
