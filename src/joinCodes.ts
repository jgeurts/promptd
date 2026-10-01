import { randomInt } from 'node:crypto';
import fs from 'node:fs';

// A day, so a code still works when the other Mac is reached later; it works once either way.
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
// Eight digits against ten guesses a quarter hour: a code cannot be found by trying.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export interface JoinCode {
  code: string;
  expiresAt: string;
}

/** 1234-5678 however it was typed, or null when it is not eight digits. */
export function normalizeCode(code: string): string | null {
  const digits = String(code).replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : null;
}

function readCodes(file: string): Array<[string, number]> {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.entries(saved).filter((entry): entry is [string, number] => normalizeCode(entry[0]) === entry[0] && typeof entry[1] === 'number');
  } catch {
    return [];
  }
}

/**
 * One-time codes a new node trades for the hub's token, so adding a Mac never
 * means copying the token itself. With a file they survive a restart of the hub.
 */
export class JoinCodes {
  private file: string | null;
  private codes: Map<string, number>;
  private failures: { count: number; firstAt: number } | null = null;

  public constructor(file: string | null = null) {
    this.file = file;
    this.codes = new Map(file ? readCodes(file) : []);
  }

  public create(now = Date.now()): JoinCode {
    this.prune(now);
    const code = normalizeCode(String(randomInt(0, 100_000_000)).padStart(8, '0'))!;
    this.codes.set(code, now + CODE_TTL_MS);
    this.save();
    return { code, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
  }

  /** Uses the code up. False when it is wrong, spent or expired, or while too many wrong ones have arrived. */
  public redeem(code: string, now = Date.now()): boolean {
    return this.accept(code, now, true);
  }

  /**
   * Whether `redeem` would take the code, leaving it unused: the installer
   * downloads promptd with the code that the node then pairs with. A wrong code
   * counts against the same allowance, so checking is no way to find one.
   */
  public check(code: string, now = Date.now()): boolean {
    return this.accept(code, now, false);
  }

  private accept(code: string, now: number, use: boolean): boolean {
    this.prune(now);
    if (this.failures && now - this.failures.firstAt >= FAILURE_WINDOW_MS) this.failures = null;
    if (this.failures && this.failures.count >= MAX_FAILURES) return false;
    const normalized = normalizeCode(code);
    if (normalized && this.codes.has(normalized)) {
      if (use) {
        this.codes.delete(normalized);
        this.save();
      }
      return true;
    }
    this.failures = this.failures ? { ...this.failures, count: this.failures.count + 1 } : { count: 1, firstAt: now };
    return false;
  }

  private prune(now: number): void {
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }

  private save(): void {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.codes)), { mode: 0o600 });
  }
}
