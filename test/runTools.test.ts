import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { RunTools, bounded, projectScope, redactSecrets, sanitize, stripUrls, summarizeCall } from '../src/runTools.js';

const CWD = '/Users/me/work/app';

/** A session like the CLI reports today, cut down to a few servers and tools. */
function init(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: CWD,
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    claude_code_version: '2.1.287',
    tools: [
      'Task',
      'Bash',
      'Read',
      'Edit',
      'mcp__Neon__run_sql',
      'mcp__Neon__list_projects',
      'mcp__claude_ai_Claude_Docs__read',
      'mcp__claude_ai_Linear__save_issue',
      'mcp__claude_ai_Linear__get_issue',
    ],
    mcp_servers: [
      { name: 'Neon', status: 'connected', source: 'user' },
      { name: 'claude.ai Claude Docs', status: 'connected', source: 'claudeai' },
      { name: 'claude.ai Linear', status: 'connected', source: 'claudeai' },
      { name: 'claude.ai Zapier', status: 'failed', source: 'claudeai' },
      { name: 'probe', status: 'failed', source: 'project' },
      ...['Figma', 'GitHub', 'Gmail', 'Stripe', 'Slack', 'Notion', 'Miro', 'Canva', 'Pendo', 'Sentry', 'Webflow', 'Clay', 'Ambient', 'Swoogo'].map((name) => ({
        name: `claude.ai ${name}`,
        status: 'needs-auth',
        source: 'claudeai',
      })),
    ],
    skills: ['probe-skill', 'ls:tdd', 'commit'],
    plugins: [{ name: 'ls' }, { name: 'basecamp' }],
    agents: ['reviewer', 'Explore'],
    ...overrides,
  };
}

function tracker(): RunTools {
  const tools = new RunTools(CWD);
  tools.withProject({ skills: ['probe-skill'], agents: ['reviewer'] });
  return tools;
}

const use = (id: string, name: string, input: unknown = {}): { content: unknown[] } => ({ content: [{ type: 'tool_use', id, name, input }] });
const failure = (id: string, content: unknown): { content: unknown[] } => ({ content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] });

describe('the setup block', () => {
  it('says what the session had, the project first, then the user, servers by status', () => {
    expect(tracker().init(init())).toEqual([
      'setup      claude 2.1.287 · claude-opus-5-5 · permissions default',
      'tools      9 at startup: 4 built-in, 5 from 3 MCP servers',
      'project    mcp: probe (failed) · skills: probe-skill · agents: reviewer',
      'global     mcp connected: Linear 2 · Neon 2 · Claude Docs 1',
      'global     mcp needs sign-in (14): Ambient, Canva, Clay, Figma, GitHub, Gmail, Miro, Notion, Pendo, Sentry, Slack, Stripe and 2 more',
      'global     mcp failed (1): Zapier',
      'global     2 skills · 2 plugins · 1 agent',
      'built-in   Task, Bash, Read, Edit',
    ]);
  });

  it('keeps the key column as wide as the header', () => {
    for (const line of tracker().init(init())) expect(line.slice(0, 11)).toMatch(/^[a-z-]+ +$/);
  });

  it('leaves the project line out when the project brought nothing', () => {
    const tools = new RunTools(CWD);
    const lines = tools.init(init({ mcp_servers: [{ name: 'Neon', status: 'connected', source: 'user' }] }));
    expect(lines.some((line) => line.startsWith('project'))).toBe(false);
    expect(lines).toContain('global     3 skills · 2 plugins · 2 agents');
  });

  it('keeps full names when dropping claude.ai would make two servers one', () => {
    const lines = tracker().init(
      init({
        tools: ['Bash', 'mcp__GitHub__pr', 'mcp__claude_ai_GitHub__issue'],
        mcp_servers: [
          { name: 'GitHub', status: 'connected', source: 'user' },
          { name: 'claude.ai GitHub', status: 'connected', source: 'claudeai' },
        ],
      }),
    );
    expect(lines).toContain('global     mcp connected: claude.ai GitHub 1 · GitHub 1');
  });

  it('counts a connected server at 0 only when every MCP tool found its server, else ?', () => {
    const servers = [
      { name: 'Neon', status: 'connected', source: 'user' },
      { name: 'Quiet', status: 'connected', source: 'user' },
    ];
    expect(tracker().init(init({ tools: ['Bash', 'mcp__Neon__run_sql'], mcp_servers: servers }))).toContain('global     mcp connected: Neon 1 · Quiet 0');
    expect(tracker().init(init({ tools: ['Bash', 'mcp__Neon__run_sql', 'mcp__Mystery__go'], mcp_servers: servers }))).toContain('global     mcp connected: Neon 1 · Quiet ?');
    expect(tracker().init(init({ tools: ['Bash', 'mcp__Neon__run_sql', 'mcp__Mystery__go'], mcp_servers: servers }))).toContain('tools      3 at startup: 1 built-in, 2 from 2 MCP servers');
  });

  it('says only the built-ins when the session had no MCP tools', () => {
    const lines = tracker().init(init({ tools: ['Bash', 'Read'], mcp_servers: [] }));
    expect(lines).toContain('tools      2 at startup: 2 built-in');
    expect(lines.some((line) => line.includes('mcp'))).toBe(false);
  });

  it('writes the block once', () => {
    const tools = tracker();
    expect(tools.init(init()).length).toBeGreaterThan(0);
    expect(tools.init(init())).toEqual([]);
  });
});

describe('the context line', () => {
  it('sums what the first request carried, once', () => {
    const tools = tracker();
    expect(tools.context({ input_tokens: 10, cache_creation_input_tokens: 17022, cache_read_input_tokens: 14172, output_tokens: 3 })).toEqual([
      'context    31k tokens in the first request',
    ]);
    expect(tools.context({ input_tokens: 99999 })).toEqual([]);
  });

  it('rounds to what a reader needs', () => {
    expect(tracker().context({ input_tokens: 950 })[0]).toContain('950 tokens');
    expect(tracker().context({ input_tokens: 1500 })[0]).toContain('1.5k tokens');
    expect(tracker().context({ input_tokens: 2000 })[0]).toContain('2k tokens');
  });

  it('says nothing for a request without a count', () => {
    expect(tracker().context({ output_tokens: 3 })).toEqual([]);
    expect(tracker().context(undefined)).toEqual([]);
  });
});

describe('a tool call line', () => {
  it('summarizes each built-in by what matters about it', () => {
    const tools = tracker();
    expect(tools.uses(use('1', 'Bash', { command: 'npm test', description: 'Run the test suite' }), null)).toEqual(['⏺ Bash  Run the test suite']);
    expect(tools.uses(use('2', 'Read', { file_path: `${CWD}/src/cronService.ts` }), null)).toEqual(['⏺ Read  src/cronService.ts']);
    expect(tools.uses(use('3', 'Edit', { file_path: '/etc/hosts' }), null)).toEqual(['⏺ Edit  /etc/hosts']);
    expect(tools.uses(use('4', 'Grep', { pattern: 'TODO', path: CWD }), null)).toEqual(['⏺ Grep  TODO']);
    expect(tools.uses(use('5', 'WebFetch', { url: 'https://example.com/docs/api?key=secret#top' }), null)).toEqual(['⏺ WebFetch  https://example.com/docs/api']);
    expect(tools.uses(use('6', 'WebSearch', { query: 'vitest fake timers' }), null)).toEqual(['⏺ WebSearch  vitest fake timers']);
    expect(tools.uses(use('7', 'Task', { description: 'Review the diff', prompt: 'long…' }), null)).toEqual(['⏺ Task  Review the diff']);
    expect(tools.uses(use('8', 'Skill', { skill: 'tdd' }), null)).toEqual(['⏺ Skill  tdd']);
    expect(tools.uses(use('9', 'TodoWrite', { todos: [] }), null)).toEqual(['⏺ TodoWrite']);
  });

  it('writes a Bash call with no description by its name alone, never its command', () => {
    const tools = tracker();
    const bash = (id: string, command: string): string[] => tools.uses(use(id, 'Bash', { command }), null);
    expect(bash('1', 'npm test')).toEqual(['⏺ Bash']);
    expect(bash('2', 'curl -H "Authorization: Bearer abcdefgh12345678" https://api.example.com/v1?key=1\necho done')).toEqual(['⏺ Bash']);
    expect(bash('3', "API_TOKEN='alpha C0balt123X' curl https://host")).toEqual(['⏺ Bash']);
    expect(bash('4', "TOKEN=$(printf 'C0balt123X') curl https://host")).toEqual(['⏺ Bash']);
  });

  it('puts every summary through the same filter, whatever the tool', () => {
    const tools = tracker();
    expect(tools.uses(use('1', 'Bash', { description: 'Deploy with token=abc123 to https://user:pw@host/x?y=1' }), null)).toEqual(['⏺ Bash  Deploy with token=*** to https://host/x']);
    expect(tools.uses(use('2', 'Grep', { pattern: 'password=hunter2' }), null)).toEqual(['⏺ Grep  password=***']);
    expect(tools.uses(use('3', 'WebSearch', { query: 'ghp_abcdefghijklmnop leaked?' }), null)).toEqual(['⏺ WebSearch  ghp_*** leaked?']);
    expect(tools.uses(use('4', 'Task', { description: 'Check https://api.example.com/v1/items?api_key=zzz' }), null)).toEqual(['⏺ Task  Check https://api.example.com/v1/items']);
    expect(tools.uses(use('5', 'Read', { file_path: `${CWD}/notes/token=abc.md` }), null)).toEqual(['⏺ Read  notes/token=***']);
  });

  it('keeps a summary to one bounded line', () => {
    const tools = tracker();
    const [line] = tools.uses(use('1', 'Bash', { description: 'x'.repeat(200) }), null);
    expect(line?.length).toBeLessThanOrEqual('⏺ Bash  '.length + 100);
    expect(line?.endsWith('…')).toBe(true);
    expect(tools.uses(use('2', 'Bash', { description: 'first\nsecond' }), null)).toEqual(['⏺ Bash  first second']);
  });

  it('names an MCP tool by its server and shows none of its input', () => {
    const tools = tracker();
    tools.init(init());
    expect(tools.uses(use('1', 'mcp__claude_ai_Linear__save_issue', { title: 'private' }), null)).toEqual(['⏺ Linear · save_issue']);
    expect(tools.uses(use('2', 'mcp__Neon__run_sql', { sql: 'drop table' }), null)).toEqual(['⏺ Neon · run_sql']);
  });

  it('falls back to the name inside the tool for a server the init did not list', () => {
    expect(tracker().uses(use('1', 'mcp__Other__do_it', {}), null)).toEqual(['⏺ Other · do_it']);
  });

  it('writes each call once, however often its message is repeated', () => {
    const tools = tracker();
    const message = { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x' } }] };
    expect(tools.uses(message, null)).toEqual(['⏺ Read  x']);
    expect(tools.uses(message, null)).toEqual([]);
    expect(tools.uses({ content: [...message.content, { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'y' } }] }, null)).toEqual(['⏺ Read  y']);
  });

  it("indents a subagent's calls", () => {
    expect(tracker().uses(use('1', 'Grep', { pattern: 'x' }), 'task-1')).toEqual(['  ⏺ Grep  x']);
  });

  it('ignores content that is not a complete tool call', () => {
    expect(tracker().uses({ content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'hi' }, 'junk'] }, null)).toEqual([]);
    expect(tracker().uses(undefined, null)).toEqual([]);
  });
});

describe('a failed tool result', () => {
  it('names the call it answers and gives the first line of the reason, filtered', () => {
    const tools = tracker();
    tools.uses(use('a', 'Read', { file_path: 'missing.ts' }), null);
    tools.uses(use('b', 'Bash', { description: 'fetch' }), null);
    const message = {
      content: [
        { type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'File does not exist.\nMore detail.' },
        { type: 'tool_result', tool_use_id: 'b', is_error: false, content: 'fine' },
      ],
    };
    expect(tools.results(message, null)).toEqual(['  ✗ Read failed: File does not exist.']);
    expect(tools.results(failure('b', '401 from https://api.example.com/v1?token=abc with Bearer abcdefgh12345678'), null)).toEqual([
      '  ✗ Bash failed: 401 from https://api.example.com/v1 with Bearer ***',
    ]);
  });

  it('reads the reason out of content blocks, and indents under a subagent', () => {
    const tools = tracker();
    tools.uses(use('a', 'Bash', { description: 'build' }), 'task-1');
    expect(tools.results(failure('a', [{ type: 'text', text: 'Exit code 1' }]), 'task-1')).toEqual(['    ✗ Bash failed: Exit code 1']);
  });

  it("says only that an MCP call failed, since a server's error can echo its input", () => {
    const tools = tracker();
    tools.init(init());
    tools.uses(use('l', 'mcp__claude_ai_Linear__save_issue', { title: 'Private title' }), null);
    expect(tools.results(failure('l', 'Validation failed for title "Private title"'), null)).toEqual(['  ✗ Linear · save_issue failed']);
  });

  it('still reports a failure whose call it never saw', () => {
    expect(tracker().results(failure('zz', ''), null)).toEqual(['  ✗ tool failed']);
  });
});

describe('the tally', () => {
  it('is nothing for a run whose CLI never said what it had or called', () => {
    expect(tracker().tally(null)).toEqual([]);
    expect(tracker().tally({ permission_denials: [{ tool_name: 'Bash' }] })).toEqual([]);
  });

  it('says none after an init with no calls', () => {
    const tools = tracker();
    tools.init(init());
    expect(tools.tally(null)).toEqual(['tools used none']);
  });

  it('counts calls by tool, most called first, and what permissions refused', () => {
    const tools = tracker();
    tools.init(init());
    for (const [id, name] of [
      ['1', 'Bash'],
      ['2', 'Read'],
      ['3', 'Read'],
      ['4', 'mcp__claude_ai_Linear__save_issue'],
      ['5', 'Read'],
      ['6', 'mcp__claude_ai_Linear__save_issue'],
    ]) {
      tools.uses(use(id!, name!, {}), null);
    }
    expect(
      tools.tally({
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: '1', tool_input: {} },
          { tool_name: 'mcp__claude_ai_Linear__save_issue', tool_use_id: '4', tool_input: {} },
          { tool_name: 'Bash', tool_use_id: '7', tool_input: {} },
        ],
      }),
    ).toEqual(['tools used 6 calls: Read ×3, Linear · save_issue ×2, Bash ×1', 'denied     3 calls: Bash ×2, Linear · save_issue ×1 (permission mode default)']);
  });

  it('leaves the permission mode out when the init never said it', () => {
    const tools = tracker();
    tools.uses(use('1', 'Bash', {}), null);
    expect(tools.tally({ permission_denials: [{ tool_name: 'Bash' }] })).toEqual(['tools used 1 call: Bash ×1', 'denied     1 call: Bash ×1']);
  });
});

describe('the filter every written input goes through', () => {
  it('blanks the usual shapes of a credential and keeps what it was for', () => {
    expect(redactSecrets('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc" x')).toBe('curl -H "Authorization: Bearer ***" x');
    expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnop npm publish')).toBe('GITHUB_TOKEN=*** npm publish');
    expect(redactSecrets('mysql --password="p@ss word" -u root')).toBe('mysql --password=*** -u root');
    expect(redactSecrets('tool --token abc123def456')).toBe('tool --token ***');
    expect(redactSecrets('export OPENAI_API_KEY=sk-proj-abcdefghijklmnop')).toBe('export OPENAI_API_KEY=***');
    expect(redactSecrets('echo sk-abcdefghijklmnop ghp_abcdefghijklmnop xoxb-1234-abcdefgh')).toBe('echo sk-*** ghp_*** xoxb-***');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('git commit -m "Fix the token parser"')).toBe('git commit -m "Fix the token parser"');
    expect(redactSecrets('npm test -- --reporter=dot')).toBe('npm test -- --reporter=dot');
  });

  it('keeps a URL to its scheme, host and path', () => {
    expect(stripUrls('fetch https://user:pw@host.example/path/to?x=1&token=2#frag now')).toBe('fetch https://host.example/path/to now');
    expect(stripUrls('see http://h/ and https://a.b/c?d')).toBe('see http://h/ and https://a.b/c');
    expect(stripUrls('no url here')).toBe('no url here');
  });

  it('drops a quoted value whole when the cut took its closing quote', () => {
    expect(sanitize(`password="${'x'.repeat(500)}`)).toBe('password=***');
    expect(sanitize(`token='${'y'.repeat(500)}' rest`)).toBe('token=***');
    expect(sanitize(`--password "${'z'.repeat(500)}`)).toBe('--password ***');
    expect(sanitize(`api_key=${'q'.repeat(500)}`)).toBe('api_key=***');
    expect(sanitize('password="short" rest')).toBe('password=*** rest');
  });

  it('cuts the input first, then filters, then bounds the line', () => {
    const line = sanitize(`${'a'.repeat(1_000_000)} token=x`);
    expect(line.length).toBe(100);
    expect(line.endsWith('…')).toBe(true);
    expect(sanitize('a\n\n  b   token=c  ')).toBe('a b token=***');
  });

  it('takes no longer on a megabyte of argument than on a line', () => {
    const megabyte = `${'a'.repeat(1_000_000)} password=x`;
    const started = performance.now();
    summarizeCall('Bash', { command: `echo ${megabyte}` }, CWD);
    summarizeCall('Bash', { description: megabyte }, CWD);
    summarizeCall('Grep', { pattern: megabyte }, CWD);
    summarizeCall('Read', { file_path: `/x/${megabyte}` }, CWD);
    sanitize(megabyte);
    const tools = tracker();
    tools.uses(use('a', 'Read', { file_path: 'x' }), null);
    tools.results(failure('a', megabyte), null);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('no credential reaches the log', () => {
  const SECRET = 'C0balt123X';
  const tools = (): RunTools => {
    const tracked = tracker();
    tracked.init(init());
    return tracked;
  };
  const line = (name: string, input: unknown): string => tools().uses(use('1', name, input), null)[0]!;
  const failed = (content: string): string => {
    const tracked = tools();
    tracked.uses(use('1', 'Bash', { description: 'fetch' }), null);
    return tracked.results(failure('1', content), null)[0]!;
  };
  const url = `https://user:${SECRET}@host/x?token=${SECRET}`;
  const cases: [string, string, string | RegExp][] = [
    ['a Bash command with a quoted assignment', line('Bash', { command: `API_TOKEN='alpha ${SECRET}' curl https://host` }), '⏺ Bash'],
    ['a description whose quoted value the cut leaves open', line('Bash', { description: `password="${SECRET}${'x'.repeat(500)}` }), '⏺ Bash  password=***'],
    ['a Bash command with a substitution', line('Bash', { command: `TOKEN=$(printf '${SECRET}') curl https://host` }), '⏺ Bash'],
    ['a description with an escaped quote inside the value', line('Bash', { description: `password="first\\"${SECRET}"` }), '⏺ Bash  password=***'],
    ['a description whose value runs on past its quotes', line('Bash', { description: `TOKEN='first'${SECRET}` }), '⏺ Bash  TOKEN=***'],
    ['a Grep pattern written as JSON', line('Grep', { pattern: `"password":"${SECRET}"` }), '⏺ Grep  "password":***'],
    ['a failure that echoes a payload', failed(`Invalid {"token":"${SECRET}"}`), '  ✗ Bash failed: Invalid …'],
    ['a URL with a password and a key', line('WebFetch', { url }), '⏺ WebFetch  https://host/x'],
    ['the same URL in a description', line('Task', { description: `Fetch ${url}` }), '⏺ Task  Fetch https://host/x'],
    ['the same URL with a long password, which the cut takes the host of', line('Task', { description: `Fetch https://user:${SECRET}${'a'.repeat(450)}@host/x?token=${SECRET}` }), '⏺ Task  Fetch https://…'],
    ['a file named after a token', line('Read', { file_path: `/repo/token=${SECRET}.txt` }), '⏺ Read  /repo/token=***'],
    ['a failure quoting an authorization header', failed(`Authorization: Bearer ${SECRET}`), '  ✗ Bash failed: Authorization: Bearer ***'],
    ['a name that ends in KEY', line('Bash', { description: `Export AWS_SECRET_ACCESS_KEY=${SECRET} then run` }), '⏺ Bash  Export AWS_SECRET_ACCESS_KEY=*** then run'],
    ['a credentials file setting', line('Bash', { description: `Set aws_credentials: ${SECRET}` }), '⏺ Bash  Set aws_credentials: ***'],
    ['a word that only ends in key', line('Bash', { description: 'Feed the monkey: bananas' }), '⏺ Bash  Feed the monkey: bananas'],
  ];
  for (const [what, written, expected] of cases) {
    it(`keeps the secret out of ${what}`, () => {
      expect(written).not.toContain(SECRET);
      expect(written).toEqual(expected);
    });
  }
});

describe('bounded and summarizeCall', () => {
  it('collapses whitespace and cuts at the limit with an ellipsis', () => {
    expect(bounded('a\n\n b\tc')).toBe('a b c');
    expect(bounded('x'.repeat(120), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(bounded('x'.repeat(20), 20)).toBe('x'.repeat(20));
  });

  it('keeps a relative path as given, and a notebook by its own field', () => {
    expect(summarizeCall('Read', { file_path: 'src/a.ts' }, CWD)).toBe('src/a.ts');
    expect(summarizeCall('NotebookEdit', { notebook_path: `${CWD}/nb.ipynb` }, CWD)).toBe('nb.ipynb');
    expect(summarizeCall('Read', {}, CWD)).toBe('');
    expect(summarizeCall('Read', 'not an object', CWD)).toBe('');
  });

  it('shows where a fetch went even when the URL does not parse', () => {
    expect(summarizeCall('WebFetch', { url: 'example.com/path?x=1' }, CWD)).toBe('example.com/path');
    expect(summarizeCall('WebFetch', { url: 'https://example.com/' }, CWD)).toBe('https://example.com');
  });
});

describe('projectScope', () => {
  const tree = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-scope-'));
  const write = (file: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  };

  it('finds the skills and agents under .claude from the directory up to the git root, and no further', async () => {
    const root = tree();
    write(path.join(root, '.claude', 'skills', 'above-root', 'SKILL.md'));
    const repo = path.join(root, 'repo');
    write(path.join(repo, '.git'));
    write(path.join(repo, '.claude', 'skills', 'repo-skill', 'SKILL.md'));
    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'no-skill-file'), { recursive: true });
    write(path.join(repo, '.claude', 'agents', 'reviewer.md'));
    write(path.join(repo, '.claude', 'agents', 'notes.txt'));
    const sub = path.join(repo, 'packages', 'web');
    write(path.join(sub, '.claude', 'skills', 'web-skill', 'SKILL.md'));
    write(path.join(sub, '.claude', 'agents', 'designer.md'));

    const scope = await projectScope(sub, path.join(root, 'elsewhere'));
    expect(scope.skills.sort()).toEqual(['repo-skill', 'web-skill']);
    expect(scope.agents.sort()).toEqual(['designer', 'reviewer']);
  });

  it("never reads the home folder's own skills as a project's, with no git root below it", async () => {
    const home = tree();
    write(path.join(home, '.claude', 'skills', 'personal', 'SKILL.md'));
    write(path.join(home, '.claude', 'agents', 'me.md'));
    const app = path.join(home, 'projects', 'app');
    write(path.join(app, '.claude', 'skills', 'own', 'SKILL.md'));

    expect(await projectScope(app, home)).toEqual({ skills: ['own'], agents: [] });
  });

  it('answers nothing for a run in the home folder itself', async () => {
    const home = tree();
    write(path.join(home, '.claude', 'skills', 'personal', 'SKILL.md'));
    expect(await projectScope(home, home)).toEqual({ skills: [], agents: [] });
  });

  it('answers nothing for a folder with no .claude anywhere up to the root', async () => {
    const dir = tree();
    fs.writeFileSync(path.join(dir, '.git'), '');
    expect(await projectScope(dir, path.join(dir, 'home'))).toEqual({ skills: [], agents: [] });
  });
});
