// Builds promptd as one executable per Mac with Bun:
//   bun scripts/build-binary.ts [darwin-arm64] [darwin-x64]
// Both by default, into dist/bin/promptd-<platform>. The version is the short
// commit unless PROMPTD_BUILD_VERSION says otherwise; the repository the binary
// updates from is GITHUB_REPOSITORY in CI, else PROMPTD_BUILD_REPO.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const TARGETS = { 'darwin-arm64': 'bun-darwin-arm64', 'darwin-x64': 'bun-darwin-x64' } as const;
type Platform = keyof typeof TARGETS;

const requested = process.argv.slice(2);
for (const name of requested) {
  if (!(name in TARGETS)) throw new Error(`unknown platform ${name}; expected ${Object.keys(TARGETS).join(' or ')}`);
}
const platforms = (requested.length ? requested : Object.keys(TARGETS)) as Platform[];

const version =
  process.env.PROMPTD_BUILD_VERSION || execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const repo = process.env.GITHUB_REPOSITORY || process.env.PROMPTD_BUILD_REPO || 'promptilicious/promptd';

const publicDir = path.join(ROOT, 'public');
const publicFiles = Object.fromEntries(fs.readdirSync(publicDir).map((name) => [name, fs.readFileSync(path.join(publicDir, name), 'utf8')]));

for (const platform of platforms) {
  const outfile = path.join(ROOT, 'dist', 'bin', `promptd-${platform}`);
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, 'src', 'entry-cli.ts')],
    compile: { target: TARGETS[platform], outfile },
    define: { PROMPTD_BUILD_VERSION: JSON.stringify(version), PROMPTD_BUILD_REPO: JSON.stringify(repo) },
    plugins: [
      {
        name: 'promptd',
        setup(build) {
          // better-sqlite3's main entry finds its addon at run time, which a binary
          // cannot follow; the per-platform entry requires it by name, so it is embedded.
          build.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: path.join(ROOT, 'node_modules', 'better-sqlite3', 'lib', `${platform}.js`),
          }));
          build.onResolve({ filter: /^promptd:public$/ }, () => ({ path: 'promptd:public', namespace: 'promptd-public' }));
          build.onLoad({ filter: /.*/, namespace: 'promptd-public' }, () => ({
            contents: `export default ${JSON.stringify(publicFiles)};`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!result.success) {
    console.error(result.logs.map(String).join('\n'));
    process.exit(1);
  }
  console.log(`built ${path.relative(ROOT, outfile)} (${version}, updates from ${repo})`);
}
