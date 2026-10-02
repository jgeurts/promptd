// Builds promptd as one executable for Apple silicon Macs with Bun:
//   bun scripts/build-binary.ts
// into dist/bin/promptd-darwin-arm64. The version is the short commit unless
// PROMPTD_BUILD_VERSION says otherwise; the repository the binary updates from
// is GITHUB_REPOSITORY in CI, else PROMPTD_BUILD_REPO.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const PLATFORM = 'darwin-arm64';

const version =
  process.env.PROMPTD_BUILD_VERSION || execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const repo = process.env.GITHUB_REPOSITORY || process.env.PROMPTD_BUILD_REPO || 'promptilicious/promptd';

// The page's files are embedded as text; an image added to public/ needs this to change first.
const TEXT_FILES = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);
const publicDir = path.join(ROOT, 'public');
const publicFiles = Object.fromEntries(
  fs.readdirSync(publicDir).map((name) => {
    if (!TEXT_FILES.has(path.extname(name))) throw new Error(`public/${name} is not a text file, which the binary cannot embed yet`);
    return [name, fs.readFileSync(path.join(publicDir, name), 'utf8')];
  }),
);
// The modules the page imports from /shared/, compiled from src/ as a checkout's dist/ has them.
const transpiler = new Bun.Transpiler({ loader: 'ts' });
for (const name of ['naming', 'jobFormRules', 'toolLines']) {
  publicFiles[`shared/${name}.js`] = transpiler.transformSync(fs.readFileSync(path.join(ROOT, 'src', `${name}.ts`), 'utf8'));
}

// A hub serves its nodes the installer, so the binary carries it and the register script it runs.
const installerScripts = {
  install: fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8'),
  register: fs.readFileSync(path.join(ROOT, 'scripts', 'register-app-mac-os.sh'), 'utf8'),
};
const embedded: Record<string, unknown> = { 'promptd:public': publicFiles, 'promptd:scripts': installerScripts };

const outfile = path.join(ROOT, 'dist', 'bin', `promptd-${PLATFORM}`);
const result = await Bun.build({
  entrypoints: [path.join(ROOT, 'src', 'entry-cli.ts')],
  compile: { target: `bun-${PLATFORM}`, outfile },
  define: { PROMPTD_BUILD_VERSION: JSON.stringify(version), PROMPTD_BUILD_REPO: JSON.stringify(repo) },
  plugins: [
    {
      name: 'promptd',
      setup(build) {
        // better-sqlite3's main entry finds its addon at run time, which a binary
        // cannot follow; the per-platform entry requires it by name, so it is embedded.
        build.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: path.join(ROOT, 'node_modules', 'better-sqlite3', 'lib', `${PLATFORM}.js`),
        }));
        build.onResolve({ filter: /^promptd:(public|scripts)$/ }, (args) => ({ path: args.path, namespace: 'promptd-embedded' }));
        build.onLoad({ filter: /.*/, namespace: 'promptd-embedded' }, (args) => ({
          contents: `export default ${JSON.stringify(embedded[args.path])};`,
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
