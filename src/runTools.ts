/**
 * What a run had to work with, and what it called, as lines for its log.
 *
 * The CLI's event stream says which tools, MCP servers, skills, plugins and
 * agents a session started with, carries every tool call and its result, and
 * lists the calls that permissions refused. The log is the only record a run
 * leaves — the node uploads nothing else — so all of that goes into it as
 * readable lines: a key-aligned block from the init event, one line per call
 * between Claude's paragraphs, and a tally at the end. Nothing here writes;
 * the run feeds events in and writes the lines it gets back. How the lines
 * look, and how the page reads them back, is in toolLines.ts.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CALL_GLYPH, FAIL_GLYPH, key, tallyItem } from './toolLines.js';

/**
 * How much of any input is looked at, before anything else is done with it.
 * Enough for a line; little enough that nothing below can take long on it,
 * since this runs in the stdout handler while the run goes.
 */
const RAW_MAX = 400;
/** The most one call's summary, or one failure's reason, takes up in the log. */
const SUMMARY_MAX = 100;
/** How many servers a status line names before "and N more". */
const NAMES_MAX = 12;
/** What the CLI puts before an MCP tool's name: `mcp__<server>__<tool>`. */
const MCP_PREFIX = 'mcp__';
/** How many folders up from the run's directory the project probe looks before giving up on finding a git root. */
const PROBE_DEPTH = 8;
/** The `source` values the CLI gives a server the project itself configures, in its `.mcp.json`. */
const PROJECT_SOURCES = new Set(['project', 'local']);

/** The fields of the CLI's `system` / `init` event that the setup block reads. */
export interface InitEvent {
  cwd?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  claude_code_version?: unknown;
  tools?: unknown;
  mcp_servers?: unknown;
  skills?: unknown;
  plugins?: unknown;
  agents?: unknown;
}

/** A complete message, as the CLI's `assistant` and `user` events carry it. */
export interface CliMessage {
  content?: unknown;
  usage?: unknown;
}

/**
 * What the run's project supplies itself: the skills and agents found under
 * `.claude/` from the run's directory up to its git root. Everything else the
 * session had is the user's own, from their home folder, account or plugins.
 */
export interface ProjectScope {
  skills: string[];
  agents: string[];
}

interface McpServer {
  /** The name as the log shows it: a leading `claude.ai ` dropped when that leaves it unambiguous. */
  display: string;
  status: string;
  /** Configured by the project, or by the user, their account or a plugin. */
  scope: 'project' | 'global';
  /** How the server's name appears inside its tools' names, in each spelling the CLI may use. */
  prefixes: string[];
  tools: number;
}

/** One call the log has a line for. */
interface Call {
  /** The name the log shows: the tool's, or `Server · tool`. */
  display: string;
  /** An MCP tool's failure is reported without its text, which can echo the input. */
  mcp: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function firstLine(value: string): string {
  return value.split('\n').find((line) => line.trim()) ?? '';
}

/** The message's content blocks, whatever shape the content came in. */
function blocks(message: CliMessage | undefined): Record<string, unknown>[] {
  return Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
}

/** One line of at most `max` characters, with an ellipsis where it was cut. */
export function bounded(value: string, max = SUMMARY_MAX): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// Credentials as they tend to appear in text. A secret keyword's whole value
// word goes, and so does whatever follows the usual token prefixes. Every
// pattern is anchored on a fixed word, so a long run of letters before it
// costs one look per character and no more: GITHUB_TOKEN=x keeps GITHUB_
// and loses x. The key may be quoted, as JSON writes it.
const KEYWORD = /(?:api[_-]?key|token|secret|password|passwd|pwd)["']?\s*[=:]\s*|--?(?:api-?key|token|secret|password)\s+/gi;
const PREFIXED: [RegExp, string][] = [
  [/\b(bearer|basic)\s+[^\s"']+/gi, '$1 ***'],
  [/\bsk-[a-z0-9_-]{8,}/gi, 'sk-***'],
  [/\b(gh[pousr]_)[a-z0-9]{8,}/gi, '$1***'],
  [/\b(xox[abprs]-)[a-z0-9-]{8,}/gi, '$1***'],
];

/**
 * Where the value word that starts at `start` ends: at the next whitespace
 * outside quotes, with single and double quotes and backslash escapes
 * honoured the way a shell does, or at the end of the text when a quote
 * never closes — which is what a value too long for the cut looks like.
 */
function valueEnd(text: string, start: number): number {
  let quote: string | null = null;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') i += 2;
    else if (quote) {
      if (ch === quote) quote = null;
      i += 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
    } else if (/\s/.test(ch)) break;
    else i += 1;
  }
  return Math.min(i, text.length);
}

/** The text with anything that looks like a credential replaced by `***`. */
export function redactSecrets(value: string): string {
  let out = '';
  let at = 0;
  KEYWORD.lastIndex = 0;
  for (let found = KEYWORD.exec(value); found; found = KEYWORD.exec(value)) {
    const start = found.index + found[0].length;
    const end = valueEnd(value, start);
    out += `${value.slice(at, start)}${end > start ? '***' : ''}`;
    at = end;
    KEYWORD.lastIndex = end;
  }
  out += value.slice(at);
  return PREFIXED.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), out);
}

// A URL: its scheme, then everything up to the first slash, question mark or
// hash — the authority — then the path, then whatever else, which goes.
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)([^\s?#]*)\S*/gi;

/**
 * Every URL in the text kept to scheme, host and path: whoever stood before
 * the host, and whatever followed the path, is where keys go. An authority
 * that runs to the end of a text the cut shortened may have lost its end,
 * and with it the `@` that would show where the host starts; it is not
 * trusted at all, and the URL becomes `scheme://…`.
 */
export function stripUrls(text: string, cut = false): string {
  return text.replace(URL_PATTERN, (whole: string, scheme: string, authority: string, path: string, offset: number) => {
    const complete = !cut || offset + scheme.length + authority.length < text.length;
    if (!complete) return `${scheme}…`;
    return `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}${path}`;
  });
}

/**
 * The one way anything a tool was given reaches the log. The text is cut to
 * RAW_MAX before any pattern sees it, then credentials are blanked, URLs
 * kept to scheme, host and path, and the rest put on one bounded line.
 */
export function sanitize(value: string): string {
  const cut = value.length > RAW_MAX;
  return bounded(stripUrls(redactSecrets(value.slice(0, RAW_MAX)), cut));
}

/** The path as the run's directory sees it, when the file is inside; else as given. */
function relativePath(file: string | null, cwd: string): string {
  if (!file) return '';
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/** Where a fetch went: scheme, host and path of the URL, and nothing it carried. */
function urlOnly(url: string | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
}

/**
 * What one call was about, in a line: enough to follow the run, never the
 * whole input. A Bash call shows Claude's description of the command and
 * never the command, which is where credentials go; file tools their path,
 * relative to the run's directory when inside it; searches their pattern or
 * query; a fetch where it went; a subagent or skill its name. Whatever the
 * tool, the answer has been through `sanitize`, which also does the cut.
 */
export function summarizeCall(name: string, input: unknown, cwd: string): string {
  const field = (...keys: string[]): string | null => {
    for (const k of keys) {
      const value = isRecord(input) ? text(input[k]) : null;
      if (value) return value;
    }
    return null;
  };
  const summary = ((): string => {
    switch (name) {
      case 'Bash':
        return field('description') ?? '';
      case 'Read':
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
        return relativePath(field('file_path'), cwd);
      case 'NotebookEdit':
        return relativePath(field('notebook_path', 'file_path'), cwd);
      case 'Grep':
      case 'Glob':
        return field('pattern') ?? '';
      case 'WebFetch':
        return urlOnly(field('url'));
      case 'WebSearch':
        return field('query') ?? '';
      case 'Task':
      case 'Agent':
        return field('description') ?? '';
      case 'Skill':
        return field('skill', 'name') ?? '';
      default:
        return field('description', 'query') ?? '';
    }
  })();
  return sanitize(summary);
}

/** Token counts as the context line says them: 950, 1.5k, 31k. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(count / 1000)}k`;
}

/** The names, each once with how often it came, most often first; ties keep their order. */
function countList(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => tallyItem(name, count))
    .join(', ');
}

/** Up to NAMES_MAX of the names, then how many were left out. */
function someNames(names: string[]): string {
  if (names.length <= NAMES_MAX) return names.join(', ');
  return `${names.slice(0, NAMES_MAX).join(', ')} and ${names.length - NAMES_MAX} more`;
}

/**
 * A failure's reason as the log gives it: the first line, cut where a JSON
 * payload starts, since that is a tool echoing what it was given.
 */
function failureReason(content: unknown): string {
  const line = firstLine(resultText(content));
  const payload = line.search(/[{[]/);
  return sanitize(payload < 0 ? line : `${line.slice(0, payload)}…`);
}

/** The text of a tool result, which comes as a string or as content blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const block = content.find((item) => isRecord(item) && typeof item.text === 'string');
  return isRecord(block) ? String(block.text) : '';
}

/**
 * The init event's servers with the names the log shows. `claude.ai GitHub`
 * becomes `GitHub` unless another server is already called that, in which
 * case both keep their full names.
 */
function nameServers(value: unknown): McpServer[] {
  const listed = Array.isArray(value) ? value.filter((item): item is Record<string, unknown> & { name: string } => isRecord(item) && typeof item.name === 'string') : [];
  const short = listed.map((server) => server.name.replace(/^claude\.ai /, ''));
  return listed.map((server, index) => {
    const display = short[index] ?? server.name;
    return {
      display: short.filter((name) => name === display).length === 1 ? display : server.name,
      status: text(server.status) ?? 'unknown',
      scope: PROJECT_SOURCES.has(text(server.source) ?? '') ? 'project' : 'global',
      // Spaces and dots become underscores in a tool's name; anything else may too.
      prefixes: [...new Set([server.name.replace(/[\s.]/g, '_'), server.name.replace(/[^A-Za-z0-9_]/g, '_')])],
      tools: 0,
    };
  });
}

/** How the log labels a server status: the CLI's `needs-auth` is a sign-in the user can do. */
function statusLabel(status: string): string {
  return status === 'needs-auth' ? 'needs sign-in' : status;
}

/** The statuses someone can act on first, then whatever else the CLI reported, alphabetically. */
function byUrgency(a: string, b: string): number {
  const order = ['needs-auth', 'failed'];
  const rank = (status: string): number => (order.includes(status) ? order.indexOf(status) : order.length);
  return rank(a) - rank(b) || a.localeCompare(b);
}

function sortedNames(servers: McpServer[]): string[] {
  return servers.map((server) => server.display).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

async function exists(file: string): Promise<boolean> {
  return fsp.stat(file).then(
    () => true,
    () => false,
  );
}

/**
 * The skills and agents the project supplies: `.claude/skills/<name>/SKILL.md`
 * and `.claude/agents/<name>.md` in the run's directory or any folder above it
 * up to the one holding `.git`, which is where Claude Code stops reading
 * project files too. The home folder is the user's, not a project's, and
 * nothing at or above it is looked at, so a run outside any repository never
 * has the user's own skills written up as the project's. A few directory
 * reads, never a walk down.
 */
export async function projectScope(dir: string, home = os.homedir()): Promise<ProjectScope> {
  const skills = new Set<string>();
  const agents = new Set<string>();
  const userHome = path.resolve(home);
  let at = path.resolve(dir);
  for (let depth = 0; depth < PROBE_DEPTH; depth += 1) {
    if (at === userHome || userHome.startsWith(at + path.sep) || at === path.dirname(at)) break;
    const claude = path.join(at, '.claude');
    const [skillDirs, agentFiles] = await Promise.all([
      fsp.readdir(path.join(claude, 'skills'), { withFileTypes: true }).catch(() => []),
      fsp.readdir(path.join(claude, 'agents'), { withFileTypes: true }).catch(() => []),
    ]);
    for (const entry of skillDirs) {
      if (entry.isDirectory() && (await exists(path.join(claude, 'skills', entry.name, 'SKILL.md')))) skills.add(entry.name);
    }
    for (const entry of agentFiles) {
      if (entry.isFile() && entry.name.endsWith('.md')) agents.add(entry.name.slice(0, -'.md'.length));
    }
    if (await exists(path.join(at, '.git'))) break;
    at = path.dirname(at);
  }
  return { skills: [...skills], agents: [...agents] };
}

/**
 * Follows one run's events and answers the lines its log gets. The setup
 * block comes from the first init event, a `context` line from the first
 * request's token count, a `⏺` line from each tool call in a complete
 * assistant message (the CLI sends one assistant event per content block
 * under one message id, and the call streams in pieces before that, so
 * calls are kept by id and never written twice), a `✗` line from each
 * result that reports an error, and the tally once the run is over.
 */
export class RunTools {
  /** For relative paths: where claude ran, which the init event says exactly. */
  private cwd: string;
  private started = false;
  private contextSaid = false;
  private permissionMode: string | null = null;
  private servers: McpServer[] = [];
  private project: ProjectScope = { skills: [], agents: [] };
  /** Every call so far by its id, in order. */
  private readonly calls = new Map<string, Call>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** What the project supplies, so the setup block can set it apart from the user's own. */
  public withProject(scope: ProjectScope): void {
    this.project = scope;
  }

  /** The setup block for the init event. Empty for any init after the first. */
  public init(event: InitEvent): string[] {
    if (this.started) return [];
    this.started = true;
    this.cwd = text(event.cwd) ?? this.cwd;
    this.permissionMode = text(event.permissionMode);
    this.servers = nameServers(event.mcp_servers);
    const tools = strings(event.tools);
    const builtIn = tools.filter((tool) => !tool.startsWith(MCP_PREFIX));
    const mcp = tools.filter((tool) => tool.startsWith(MCP_PREFIX));
    // Each MCP tool counts under its server. One whose server the init did not
    // list is grouped by the name inside the tool, so the server count holds.
    const unlisted = new Set<string>();
    for (const tool of mcp) {
      const rest = tool.slice(MCP_PREFIX.length);
      const match = this.serverFor(rest);
      if (match) match.server.tools += 1;
      else unlisted.add(rest.split('__')[0] ?? rest);
    }
    const serverCount = this.servers.filter((server) => server.tools > 0).length + unlisted.size;
    // Only when every MCP tool found its server is a server with none known to have none.
    const everyToolPlaced = this.servers.reduce((sum, server) => sum + server.tools, 0) === mcp.length;
    const withCount = (server: McpServer): string => `${server.display} ${server.tools || (everyToolPlaced ? 0 : '?')}`;

    const lines: string[] = [];
    const version = text(event.claude_code_version);
    const setup = [version ? `claude ${version}` : null, text(event.model), this.permissionMode ? `permissions ${this.permissionMode}` : null].filter(Boolean);
    if (setup.length) lines.push(`${key('setup')}${setup.join(' · ')}`);
    if (tools.length) {
      lines.push(`${key('tools')}${tools.length} at startup: ${builtIn.length} built-in${mcp.length ? `, ${mcp.length} from ${plural(serverCount, 'MCP server')}` : ''}`);
    }

    // What the project brought: its own servers, and the skills and agents
    // found under its .claude folder. One line, left out when there is none.
    const skills = strings(event.skills);
    const agents = strings(event.agents);
    const projectSkills = skills.filter((name) => this.project.skills.includes(name));
    const projectAgents = agents.filter((name) => this.project.agents.includes(name));
    const projectServers = this.servers.filter((server) => server.scope === 'project').sort((a, b) => byUrgency(a.status, b.status) || a.display.localeCompare(b.display));
    const project = [
      projectServers.length ? `mcp: ${projectServers.map((server) => (server.status === 'connected' ? withCount(server) : `${server.display} (${statusLabel(server.status)})`)).join(', ')}` : null,
      projectSkills.length ? `skills: ${someNames(projectSkills)}` : null,
      projectAgents.length ? `agents: ${someNames(projectAgents)}` : null,
    ].filter(Boolean);
    if (project.length) lines.push(`${key('project')}${project.join(' · ')}`);

    // The user's own: servers by status, those someone can act on first, then
    // how many skills, plugins and agents came from outside the project.
    const global = this.servers.filter((server) => server.scope === 'global');
    const connected = global.filter((server) => server.status === 'connected').sort((a, b) => b.tools - a.tools || a.display.localeCompare(b.display));
    if (connected.length) lines.push(`${key('global')}mcp connected: ${connected.map(withCount).join(' · ')}`);
    const statuses = [...new Set(global.map((server) => server.status))].filter((status) => status !== 'connected').sort(byUrgency);
    for (const status of statuses) {
      const names = sortedNames(global.filter((server) => server.status === status));
      lines.push(`${key('global')}mcp ${statusLabel(status)} (${names.length}): ${someNames(names)}`);
    }
    const extras = (
      [
        ['skill', Array.isArray(event.skills) ? skills.length - projectSkills.length : null],
        ['plugin', Array.isArray(event.plugins) ? event.plugins.length : null],
        ['agent', Array.isArray(event.agents) ? agents.length - projectAgents.length : null],
      ] as const
    ).flatMap(([noun, count]) => (count === null ? [] : [plural(count, noun)]));
    if (extras.length) lines.push(`${key('global')}${extras.join(' · ')}`);
    if (builtIn.length) lines.push(`${key('built-in')}${builtIn.join(', ')}`);
    return lines;
  }

  /** The context line, once: what the first request carried, from its usage. */
  public context(usage: unknown): string[] {
    if (this.contextSaid || !isRecord(usage)) return [];
    const total = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, field) => {
      const value = usage[field];
      return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    }, 0);
    if (total <= 0) return [];
    this.contextSaid = true;
    return [`${key('context')}${formatTokens(total)} tokens in the first request`];
  }

  /** A line for each tool call in a complete assistant message that the log has not had yet. */
  public uses(message: CliMessage | undefined, parentToolUseId: string | null): string[] {
    const lines: string[] = [];
    for (const block of blocks(message)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string' || this.calls.has(block.id)) continue;
      const mcp = block.name.startsWith(MCP_PREFIX);
      const display = this.displayName(block.name);
      this.calls.set(block.id, { display, mcp });
      // An MCP call's input is the server's business; the tool's name says enough.
      const summary = mcp ? '' : summarizeCall(block.name, block.input, this.cwd);
      lines.push(`${parentToolUseId ? '  ' : ''}${CALL_GLYPH} ${display}${summary ? `  ${summary}` : ''}`);
    }
    return lines;
  }

  /**
   * A line for each tool result in a user message that reports an error: the
   * first line of the reason, up to any payload and sanitized, for a built-in
   * tool; the name alone for an MCP tool, whose error can echo what it was sent.
   */
  public results(message: CliMessage | undefined, parentToolUseId: string | null): string[] {
    const lines: string[] = [];
    for (const block of blocks(message)) {
      if (block.type !== 'tool_result' || block.is_error !== true) continue;
      const call = typeof block.tool_use_id === 'string' ? this.calls.get(block.tool_use_id) : undefined;
      const reason = call?.mcp ? '' : failureReason(block.content);
      lines.push(`${parentToolUseId ? '    ' : '  '}${FAIL_GLYPH} ${call?.display ?? 'tool'} failed${reason ? `: ${reason}` : ''}`);
    }
    return lines;
  }

  /**
   * The closing tally: calls by tool, most called first, and the calls that
   * permissions refused. Empty when the run never got as far as saying what
   * it had, so a log from a CLI without these events stays as it was.
   */
  public tally(result: { permission_denials?: unknown } | null): string[] {
    if (!this.started && this.calls.size === 0) return [];
    const names = [...this.calls.values()].map((call) => call.display);
    const used = names.length ? `${plural(names.length, 'call')}: ${countList(names)}` : 'none';
    const lines = [`${key('tools used')}${used}`];
    const denied = Array.isArray(result?.permission_denials)
      ? result.permission_denials.filter(isRecord).map((denial) => this.displayName(text(denial.tool_name) ?? 'tool'))
      : [];
    if (denied.length) {
      lines.push(`${key('denied')}${plural(denied.length, 'call')}: ${countList(denied)}${this.permissionMode ? ` (permission mode ${this.permissionMode})` : ''}`);
    }
    return lines;
  }

  /** `Server · tool` for an MCP tool, by the server the init listed, else by the name inside the tool; built-ins as they are. */
  private displayName(tool: string): string {
    if (!tool.startsWith(MCP_PREFIX)) return tool;
    const rest = tool.slice(MCP_PREFIX.length);
    const match = this.serverFor(rest);
    if (match) return `${match.server.display} · ${rest.slice(match.prefix.length + 2)}`;
    const at = rest.indexOf('__');
    return at > 0 ? `${rest.slice(0, at)} · ${rest.slice(at + 2)}` : rest;
  }

  /** The listed server whose name starts an MCP tool's name (after `mcp__`), the longest match when one name begins another. */
  private serverFor(rest: string): { server: McpServer; prefix: string } | null {
    let best: { server: McpServer; prefix: string } | null = null;
    for (const server of this.servers) {
      for (const prefix of server.prefixes) {
        if (rest.startsWith(`${prefix}__`) && (!best || prefix.length > best.prefix.length)) best = { server, prefix };
      }
    }
    return best;
  }
}
