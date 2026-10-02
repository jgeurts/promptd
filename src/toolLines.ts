/**
 * The lines a run's log carries about its tools: how the node writes them,
 * and how the page reads them back. The page loads this compiled module as
 * /shared/toolLines.js, the way it does naming.js, so the writer and the
 * reader cannot drift apart, and the reader is tested here rather than only
 * in a browser.
 *
 * Nothing here imports anything, for the same reason.
 */

/** The key column's width, the same as the log header's `directory  …` lines. */
export const KEY_WIDTH = 11;
/** Opens a tool call's line: `⏺ Bash  Run the test suite`. */
export const CALL_GLYPH = '⏺';
/** Opens the line under a call that failed: `  ✗ Read failed: …`. */
export const FAIL_GLYPH = '✗';
/** The heading the output section starts under. The setup block follows it, after at most a few stray lines. */
export const OUTPUT_HEADING = '--- output ---';
/** A tool call's line or a failure's, at the main agent's depth or a subagent's. */
export const TOOL_LINE = /^ {0,4}[⏺✗] /;
/** How many lines after the output heading the setup block may take to start: a CLI warning on stderr lands there. */
const BLOCK_WAIT_LINES = 50;

/** The retrospective's section, which the reader skips; kept in step with src/retrospective.ts. */
const RETRO_HEADING = '--- retrospective ---';
const RETRO_END = '--- end of retrospective ---';
/** The run's closing lines, which the tally sits right above: the statistics box, or the clean-up line alone when the CLI gave no statistics. */
const CLOSING = /^(?:=-+=|Worktree cleanup: )/;

/** A key padded to the column, as every record line starts. */
export function key(name: string): string {
  return name.padEnd(KEY_WIDTH);
}

/** One item of the tally: the name, then its count. Every item carries one, so a name may hold a comma. */
export function tallyItem(name: string, count: number): string {
  return `${name} ×${count}`;
}

/** What a log says about its run's tools. Strings are the lines' values as written. */
export interface ToolRecords {
  /** `claude 2.1.287 · claude-opus-5-5 · permissions default` */
  setup: string | null;
  startup: { tools: number; builtIn: number } | null;
  /** The project's own, by kind: `probe (failed)` under mcp, names under skills and agents. */
  project: { mcp?: string; skills?: string; agents?: string } | null;
  /** The user's servers, one entry per status line, in the order written. */
  servers: { status: string; count: number | null; names: string }[];
  /** `161 skills · 10 plugins · 10 agents` */
  extras: string | null;
  builtIn: string | null;
  context: string | null;
  /** Calls by the name the log shows, from the `⏺` lines so far. */
  calls: Map<string, number>;
  /** The closing tally, once written. It counts for the run over the `⏺` lines. */
  used: Map<string, number> | null;
  denied: string | null;
}

const BLOCK = {
  setup: /^setup {6}(\S.*)$/,
  startup: /^tools {6}(\d+) at startup: (\d+) built-in(?:, (\d+) from (\d+) MCP servers?)?$/,
  project: /^project {4}(\S.*)$/,
  server: /^global {5}mcp ([a-z][a-z -]*?)(?: \((\d+)\))?: (\S.*)$/,
  extras: /^global {5}(\S.*)$/,
  builtIn: /^built-in {3}(\S.*)$/,
  context: /^context {4}(\S.*)$/,
};
const CALL = /^ {0,2}⏺ (\S.*)$/;
const USED = /^tools used (\S.*)$/;
const DENIED = /^denied {5}(\S.*)$/;

/**
 * Reads a log as it streams and keeps what it says about the run's tools.
 *
 * Only a log whose output opens with the setup block has tool records. The
 * block may come after a few stray lines — a CLI warning arrives on stderr
 * and is piped into the same log — but once it starts its keys run on
 * without a break, and it is read once; a block quoted further down changes
 * nothing. A log from an older node, or whose CLI reported nothing, is left
 * alone and soon costs nothing more to feed. `⏺` lines are counted anywhere
 * in the output after the block, except inside the retrospective's section,
 * and the tally counts for the run once it is written — which is known only
 * when the closing lines follow it, so a tally quoted in prose does not.
 */
export class ToolLinesReader {
  public readonly records: ToolRecords = {
    setup: null,
    startup: null,
    project: null,
    servers: [],
    extras: null,
    builtIn: null,
    context: null,
    calls: new Map(),
    used: null,
    denied: null,
  };

  private state: 'header' | 'wait' | 'block' | 'output' | 'retro' | 'closed' | 'none' = 'header';
  private waited = 0;
  /** A tally seen but not yet followed by the closing lines, which is what makes it the run's. */
  private pending: { used: string; denied: string | null } | null = null;
  /** The unfinished last line, until the rest of it comes. */
  private rest = '';

  /** Whether the log has tool records: its output opened with the setup block. */
  public get active(): boolean {
    return this.state === 'block' || this.state === 'output' || this.state === 'retro' || this.state === 'closed';
  }

  /** Whether the log is known to say nothing, so there is nothing left to read. */
  public get finished(): boolean {
    return this.state === 'none';
  }

  /** Takes the next piece of the log, cut anywhere; answers whether the records changed. */
  public feed(text: string): boolean {
    if (this.state === 'none') return false;
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop() ?? '';
    let changed = false;
    for (const line of lines) {
      if (this.line(line)) changed = true;
      if (this.finished) {
        this.rest = '';
        break;
      }
    }
    return changed;
  }

  private line(line: string): boolean {
    switch (this.state) {
      case 'header':
        if (line === OUTPUT_HEADING) this.state = 'wait';
        return false;
      case 'wait':
        if (this.blockLine(line)) {
          this.state = 'block';
          return true;
        }
        this.waited += 1;
        if (this.waited >= BLOCK_WAIT_LINES) this.state = 'none';
        return false;
      case 'block':
        if (this.blockLine(line)) return true;
        this.state = 'output';
        return this.outputLine(line);
      case 'output':
        return this.outputLine(line);
      case 'retro':
        if (line === RETRO_END) this.state = 'output';
        return false;
      default:
        return false;
    }
  }

  /** One line of the setup block. The first of each key counts; the block never repeats one. */
  private blockLine(line: string): boolean {
    const records = this.records;
    let m: RegExpExecArray | null;
    if ((m = BLOCK.setup.exec(line))) return records.setup === null && Boolean((records.setup = m[1]!));
    if ((m = BLOCK.startup.exec(line))) return records.startup === null && Boolean((records.startup = { tools: Number(m[1]), builtIn: Number(m[2]) }));
    if ((m = BLOCK.project.exec(line))) {
      if (records.project !== null) return false;
      records.project = {};
      for (const part of m[1]!.split(' · ')) {
        const found = /^(mcp|skills|agents): (.+)$/.exec(part);
        if (found) records.project[found[1] as 'mcp' | 'skills' | 'agents'] = found[2]!;
      }
      return true;
    }
    if ((m = BLOCK.server.exec(line))) {
      records.servers.push({ status: m[1]!, count: m[2] ? Number(m[2]) : null, names: m[3]! });
      return true;
    }
    if ((m = BLOCK.extras.exec(line))) return records.extras === null && Boolean((records.extras = m[1]!));
    if ((m = BLOCK.builtIn.exec(line))) return records.builtIn === null && Boolean((records.builtIn = m[1]!));
    if ((m = BLOCK.context.exec(line))) return records.context === null && Boolean((records.context = m[1]!));
    return false;
  }

  /**
   * One line of the output after the block: a call, the retrospective's
   * heading, or the tally — held until the closing lines confirm it, with
   * only blank lines allowed in between.
   */
  private outputLine(line: string): boolean {
    const records = this.records;
    if (line === RETRO_HEADING) {
      this.state = 'retro';
      this.pending = null;
      return false;
    }
    let m: RegExpExecArray | null;
    if ((m = CALL.exec(line))) {
      this.pending = null;
      // The tool's name ends at the two spaces before its summary; an MCP tool has none.
      const name = m[1]!.split('  ')[0]!;
      records.calls.set(name, (records.calls.get(name) ?? 0) + 1);
      return true;
    }
    if ((m = USED.exec(line))) {
      this.pending = { used: m[1]!, denied: null };
      return false;
    }
    if ((m = DENIED.exec(line)) && this.pending && this.pending.denied === null) {
      this.pending.denied = m[1]!;
      return false;
    }
    if (line === '') return false;
    if (CLOSING.test(line) && this.pending) {
      records.used = parseTally(this.pending.used);
      records.denied = this.pending.denied;
      this.pending = null;
      this.state = 'closed';
      return true;
    }
    this.pending = null;
    return false;
  }
}

/** `12 calls: Read ×6, Bash ×4, Linear · save_issue ×2`, or `none`, as a count per name. */
function parseTally(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  const list = /^\d+ calls?: (.+)$/.exec(value);
  if (!list) return counts;
  // Every item ends in its count, so the count is what separates one from the
  // next, and a name may hold a comma.
  for (const item of list[1]!.matchAll(/(.+?) ×(\d+)(?:, |$)/g)) counts.set(item[1]!, Number(item[2]));
  return counts;
}

/** The calls by tool, most called first: the tally's once the log has one, else the `⏺` lines' so far. */
export function callCounts(records: ToolRecords): [string, number][] {
  return [...(records.used ?? records.calls)].sort((a, b) => b[1] - a[1]);
}

/** The calls as one line: `Read ×6 · Bash ×4 · Linear · save_issue`. */
export function callList(records: ToolRecords): string {
  return callCounts(records)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(' · ');
}

/** The disclosure's one line: `Tools · 326 at startup · 12 calls to 3 tools · 2 denied`. */
export function toolsSummary(records: ToolRecords, live: boolean): string {
  const counts = callCounts(records);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  const denied = Number(/^(\d+) call/.exec(records.denied ?? '')?.[1] ?? 0);
  const n = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return [
    'Tools',
    records.startup ? `${records.startup.tools} at startup` : null,
    total ? `${n(total, 'call')} to ${n(counts.length, 'tool')}` : `no calls${live && !records.used ? ' yet' : ''}`,
    denied ? `${denied} denied` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
