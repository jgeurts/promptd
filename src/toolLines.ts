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
/** The heading the output section starts under. The setup block follows it directly. */
export const OUTPUT_HEADING = '--- output ---';
/** A tool call's line or a failure's, at the main agent's depth or a subagent's. */
export const TOOL_LINE = /^ {0,4}[⏺✗] /;

/** A key padded to the column, as every record line starts. */
export function key(name: string): string {
  return name.padEnd(KEY_WIDTH);
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
 * Only a log whose output opens with the setup block has tool records. One
 * from an older node, or whose CLI reported nothing, is left alone from its
 * first output line on, however much of a `⏺` it quotes later, and costs
 * nothing more to feed. The block is read once, from the top of the output,
 * so a quoted block further down changes nothing; `⏺` lines are counted
 * anywhere in the output after it, and the tally at the end takes over.
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

  private state: 'header' | 'block' | 'output' | 'none' = 'header';
  private blockLines = 0;
  /** The unfinished last line, until the rest of it comes. */
  private rest = '';

  /** Whether the log has tool records: its output opened with the setup block. */
  public get active(): boolean {
    return this.state === 'block' || this.state === 'output';
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
        if (line === OUTPUT_HEADING) this.state = 'block';
        return false;
      case 'block':
        if (this.blockLine(line)) {
          this.blockLines += 1;
          return true;
        }
        // The block is over — or never came, and then the log has no records.
        this.state = this.blockLines ? 'output' : 'none';
        return this.state === 'output' && this.outputLine(line);
      case 'output':
        return this.outputLine(line);
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

  /** One line of the output after the block: a call, the context line when it came late, or the tally. */
  private outputLine(line: string): boolean {
    const records = this.records;
    let m: RegExpExecArray | null;
    if ((m = CALL.exec(line))) {
      // The tool's name ends at the two spaces before its summary; an MCP tool has none.
      const name = m[1]!.split('  ')[0]!;
      records.calls.set(name, (records.calls.get(name) ?? 0) + 1);
      return true;
    }
    if ((m = BLOCK.context.exec(line))) return records.context === null && Boolean((records.context = m[1]!));
    if ((m = USED.exec(line))) {
      records.used = parseTally(m[1]!);
      return true;
    }
    if ((m = DENIED.exec(line))) {
      records.denied = m[1]!;
      return true;
    }
    return false;
  }
}

/** `12 calls: Read ×6, Bash ×4, Linear · save_issue ×2`, or `none`, as a count per name. */
function parseTally(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  const list = /^\d+ calls?: (.+)$/.exec(value);
  if (!list) return counts;
  for (const item of list[1]!.split(', ')) {
    const found = /^(.+?)(?: ×(\d+))?$/.exec(item);
    if (found) counts.set(found[1]!, Number(found[2] ?? 1));
  }
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
