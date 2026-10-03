/**
 * Which account to use first: the one whose weekly limit resets soonest while
 * it still has room. What it has left is lost at that reset, while a week that
 * resets later can spend its room on later work. The sidebar marks its
 * computers and a new one-time job's form picks one of them. The page loads
 * the compiled module, as it does jobFormRules.js, so the rule is tested here.
 *
 * Nothing here imports anything, for the same reason.
 */

/** One limit as the cluster summary reports it; older readings name the kind only in `key`. */
export interface UseFirstLimit {
  kind?: string;
  key?: string;
  usedPercent: number;
  status?: string;
  resetsAt?: string | null;
}

/** One computer as the cluster summary reports it. */
export interface UseFirstComputer {
  id: string;
  online: boolean;
  accountKey: string | null;
  reading?: { stale?: boolean; windows?: UseFirstLimit[]; limits?: UseFirstLimit[] } | null;
}

export interface UseFirstPick {
  accountKey: string;
  /** The account's online computers, in the order given. */
  nodeIds: string[];
  /** The share of the week left, 0 to 100. */
  leftPercent: number;
  /** When that week resets. */
  resetsAt: string;
}

/** A week needs this much left to be worth sending work to. */
export const USE_FIRST_MIN_LEFT = 10;

/** Its reset must come this much sooner than every other account's, so near-ties go unmarked. */
export const USE_FIRST_LEAD_MS = 24 * 60 * 60 * 1000;

function kindOf(limit: UseFirstLimit): string {
  return limit.kind ?? String(limit.key ?? '').split(':')[0] ?? '';
}

function isFull(limit: UseFirstLimit): boolean {
  return limit.status === 'near' || limit.status === 'reached';
}

/**
 * The hub keys a computer that names its account `account:<id>`, and one that
 * does not `unknown:<node id>`. An unknown one may share a known account's
 * reading, which would count that week twice, so only named accounts compete.
 */
function isNamedAccount(accountKey: string | null): accountKey is string {
  return Boolean(accountKey?.startsWith('account:'));
}

/**
 * The account to use first for work that starts at `at` (ms), or null when no
 * account stands out. Each candidate is a named account with a fresh reading
 * whose weekly limit has at least 10% left and resets after `at`, and whose
 * 5-hour session is not near or used up, unless it resets by `at`. The session only rules an
 * account out: it resets every 5 hours, so ranking on it would move the pick
 * all day. The candidate whose week resets first is the pick when that is at
 * least a day before every other candidate's; with one candidate there is
 * nothing to compare, so there is no pick.
 */
export function useFirst(computers: readonly UseFirstComputer[], at: number = Date.now()): UseFirstPick | null {
  const accounts = new Map<string, UseFirstComputer[]>();
  for (const computer of computers) {
    if (!computer.online || !isNamedAccount(computer.accountKey)) continue;
    accounts.set(computer.accountKey, [...(accounts.get(computer.accountKey) ?? []), computer]);
  }
  const candidates: UseFirstPick[] = [];
  for (const [accountKey, members] of accounts) {
    // Every computer on an account reports the same reading.
    const reading = members[0]!.reading;
    if (!reading || reading.stale) continue;
    const windows = reading.windows ?? reading.limits ?? [];
    const week = windows.find((limit) => kindOf(limit) === 'weekly_all');
    const resetsAt = week?.resetsAt ? Date.parse(week.resetsAt) : NaN;
    if (!week || !(resetsAt > at)) continue;
    const leftPercent = Math.max(0, 100 - (Number(week.usedPercent) || 0));
    if (leftPercent < USE_FIRST_MIN_LEFT) continue;
    const session = windows.find((limit) => kindOf(limit) === 'session');
    if (session && isFull(session) && !(session.resetsAt && Date.parse(session.resetsAt) <= at)) continue;
    candidates.push({ accountKey, nodeIds: members.map((computer) => computer.id), leftPercent, resetsAt: week.resetsAt! });
  }
  if (candidates.length < 2) return null;
  candidates.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
  const [first, second] = candidates;
  return Date.parse(second!.resetsAt) - Date.parse(first!.resetsAt) >= USE_FIRST_LEAD_MS ? first! : null;
}
