import fsp from 'node:fs/promises';
import { BINARY_REPO } from './binary.js';
import { joinCommand, joinUrl } from './join.js';
import type { JoinCode } from './joinCodes.js';
import { servesNodeBuild } from './nodeBuild.js';
import { NODE_TOKEN_FILE } from './paths.js';

// Prints the command that adds another Mac as a node of the hub on this machine,
// with a fresh join code: what Settings → Nodes shows, for a terminal or a script.
//   promptd join-command [hub-address]
// The address defaults to the one the hub works out for Settings → Nodes.

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

async function main(): Promise<void> {
  const token = process.env.PROMPTD_NODE_TOKEN?.trim() || (await fsp.readFile(NODE_TOKEN_FILE, 'utf8').catch(() => '')).trim();
  if (!token) throw new Error(`no hub on this machine: ${NODE_TOKEN_FILE} does not exist`);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/node/join-codes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`the hub on port ${PORT} answered ${res.status}`);
  const { code, expiresAt } = (await res.json()) as JoinCode;
  const hubUrl = process.argv[2] ?? (await joinUrl({ host: HOST, port: PORT, origin: '' }));
  if (!hubUrl) throw new Error('other Macs cannot reach this hub yet; share it with tailscale serve, or pass the address to use');
  // Run from the hub's own install, so this serves a build exactly when the hub does.
  console.log(joinCommand(hubUrl, code, { servesBuild: servesNodeBuild(), repo: BINARY_REPO }));
  console.error(`The code works once, until ${new Date(expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`);
}

try {
  await main();
} catch (err) {
  console.error(`join-command: ${(err as Error).message}`);
  process.exitCode = 1;
}
