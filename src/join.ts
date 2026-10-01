import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isLoopbackHost } from './auth.js';

const execFileAsync = promisify(execFile);

// The Mac app installs no `tailscale` on PATH unless its CLI integration is turned on.
const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** The parts of `tailscale serve status --json` read here. */
export interface ServeConfig {
  TCP?: Record<string, { HTTP?: boolean; HTTPS?: boolean } | undefined>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | undefined> } | undefined>;
}

export interface JoinUrlInput {
  host: string;
  port: number;
  /** How the browser asking reached this hub. */
  origin: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackHost(hostname.replace(/^\[(.*)\]$/, '$1'));
}

/** The address `tailscale serve` shares this hub on: the entry whose `/` handler proxies to the hub's port on loopback. */
export function serveUrl(config: ServeConfig, port: number): string | null {
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const proxy = web?.Handlers?.['/']?.Proxy;
    if (!proxy) continue;
    let target: URL;
    try {
      target = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    } catch {
      continue;
    }
    if (!isLoopbackHostname(target.hostname) || Number(target.port || 80) !== port) continue;
    const split = hostPort.lastIndexOf(':');
    const servePort = hostPort.slice(split + 1);
    const scheme = config.TCP?.[servePort]?.HTTPS ? 'https' : 'http';
    const defaultPort = scheme === 'https' ? '443' : '80';
    return `${scheme}://${hostPort.slice(0, split)}${servePort === defaultPort ? '' : `:${servePort}`}`;
  }
  return null;
}

async function output(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 3000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function tailscaleServeUrl(port: number): Promise<string | null> {
  for (const bin of TAILSCALE_BINS) {
    const json = await output(bin, ['serve', 'status', '--json']);
    if (json === null) continue;
    try {
      return serveUrl(JSON.parse(json) as ServeConfig, port);
    } catch {
      return null;
    }
  }
  return null;
}

function reachableOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) ? null : url.origin;
  } catch {
    return null;
  }
}

async function localHostnameUrl(host: string, port: number): Promise<string | null> {
  if (isLoopbackHost(host)) return null;
  const name = await output('scutil', ['--get', 'LocalHostName']);
  return name ? `http://${name}.local:${port}` : null;
}

/**
 * Where a node on another machine should find this hub: its `tailscale serve`
 * address, then the address the browser used, then the Mac's Bonjour name when
 * the hub listens beyond loopback. Null when nothing off this machine can reach it.
 */
export async function joinUrl({ host, port, origin }: JoinUrlInput): Promise<string | null> {
  return (await tailscaleServeUrl(port)) ?? reachableOrigin(origin) ?? (await localHostnameUrl(host, port));
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface JoinSource {
  /** Whether the hub serves its installer and build itself. */
  servesBuild: boolean;
  /** The GitHub repository a binary hub was released from, or null for a checkout. */
  repo: string | null;
}

/**
 * The command that adds another Mac as a node of this hub with a join code: the
 * hub's own installer when it can serve the node its build, else the installer
 * from `repo`'s latest release for a hub that is a binary, else the register
 * script, run from a checkout there.
 */
export function joinCommand(hubUrl: string, code: string, { servesBuild, repo }: JoinSource): string {
  if (servesBuild) {
    return `curl -fsSL ${shellQuote(`${hubUrl.replace(/\/+$/, '')}/install.sh`)} | bash -s -- --code ${shellQuote(code)}`;
  }
  if (repo) {
    const installer = `https://github.com/${repo}/releases/latest/download/install.sh`;
    return `curl -fsSL ${installer} | bash -s -- --hub ${shellQuote(hubUrl)} --code ${shellQuote(code)}`;
  }
  return `NODE_ONLY=1 HUB_URL=${shellQuote(hubUrl)} JOIN_CODE=${shellQuote(code)} ./scripts/register-app-mac-os.sh`;
}
