import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { Request, RequestHandler, Response } from 'express';
import { BINARY_VERSION } from './binary.js';
import { BUILD_SHA256_HEADER, BUILD_VERSION_HEADER } from './binaryUpdate.js';
import { shellQuote } from './join.js';

// Nodes install and update from their hub, the one machine that talks to
// GitHub, so a hub that is a binary hands out its own executable.

/** The body of a 404 from a hub with no build to hand out. */
export const NO_NODE_BUILD = 'this hub cannot serve a node build';

/** install.sh and the register script it runs, as a build ships them. */
export interface InstallerScripts {
  install: string;
  register: string;
}

/** The build a hub hands its nodes, and the installer that puts it on a new one. */
export interface NodeBuild {
  version: string;
  size: number;
  scripts: InstallerScripts;
  sha256(): Promise<string>;
  stream(): Readable;
}

/**
 * The build in `file` as it is now. It is read through a descriptor opened
 * here, so a newer build renamed over the file later, as an update does, is
 * never handed out under this one's version.
 */
export function buildFromFile(file: string, version: string, scripts: InstallerScripts): NodeBuild {
  const fd = fs.openSync(file, 'r');
  const { size } = fs.fstatSync(fd);
  // Each read is positioned, so any number of streams can share the descriptor at once.
  const stream = (): Readable => fs.createReadStream('', { fd, start: 0, end: size - 1, autoClose: false });
  let digest: Promise<string> | null = null;
  return {
    version,
    size,
    scripts,
    stream,
    sha256() {
      digest ??= new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        stream()
          .on('data', (chunk) => hash.update(chunk))
          .on('end', () => resolve(hash.digest('hex')))
          .on('error', reject);
      }).catch((err: unknown) => {
        digest = null;
        throw err;
      });
      return digest;
    },
  };
}

/** Whether this process is a binary a node can run: promptd is built for Apple silicon Macs only. */
export function servesNodeBuild(): boolean {
  return Boolean(BINARY_VERSION) && process.platform === 'darwin' && process.arch === 'arm64';
}

/** This hub's own executable, or null for a checkout or a hub on Linux. */
export async function ownBuild(): Promise<NodeBuild | null> {
  if (!servesNodeBuild()) return null;
  const { default: scripts } = await import('promptd:scripts');
  return buildFromFile(process.execPath, BINARY_VERSION!, scripts);
}

async function buildHeaders(build: NodeBuild): Promise<Record<string, string>> {
  return { [BUILD_VERSION_HEADER]: build.version, [BUILD_SHA256_HEADER]: await build.sha256() };
}

/** Answers that there is no build here, which a node takes as a reason to stop asking. */
export function sendNoBuild(res: Response): void {
  res.status(404).json({ error: NO_NODE_BUILD });
}

/** Sends the build itself, with the headers the downloader checks it against. */
export async function sendBuild(res: Response, build: NodeBuild): Promise<void> {
  res.set({ ...(await buildHeaders(build)), 'content-type': 'application/octet-stream', 'content-length': String(build.size) });
  build
    .stream()
    .on('error', (err) => res.destroy(err))
    .pipe(res);
}

function fillIn(script: string, name: string, value: string): string {
  const blank = new RegExp(`^${name}=''$`, 'm');
  if (!blank.test(script)) throw new Error(`install.sh has no ${name}='' to fill in`);
  // A function, since a replacement string would read the register script's $' as a pattern.
  return script.replace(blank, () => `${name}=${shellQuote(value)}`);
}

/**
 * install.sh as a hub serves it: the hub's address filled in as where the node
 * and its build come from, and the register script, which a release ships
 * beside it, carried inside it.
 */
export function installerScript({ install, register }: InstallerScripts, hubUrl: string): string {
  return fillIn(fillIn(install, 'FROM_HUB', hubUrl), 'REGISTER_SCRIPT', register);
}

/** GET /install.sh: the installer for a new node, pointed at this hub at `hubUrl(req)`. */
export function serveInstaller(build: NodeBuild | null, hubUrl: (req: Request) => Promise<string>): RequestHandler {
  return (req, res, next) => {
    if (!build) {
      res.status(404).type('text/plain').send(`${NO_NODE_BUILD}\n`);
      return;
    }
    Promise.all([hubUrl(req), buildHeaders(build)])
      .then(([url, headers]) => {
        res.set(headers).type('text/plain').send(installerScript(build.scripts, url));
      })
      .catch(next);
  };
}
