import { randomInt } from 'node:crypto';

const CODE_TTL_MS = 15 * 60 * 1000;
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

/**
 * One-time codes a new node trades for the hub's token, so adding a Mac never
 * means copying the token itself. Kept in memory: a restart voids them.
 */
export class JoinCodes {
  private codes = new Map<string, number>();
  private failures: { count: number; firstAt: number } | null = null;

  public create(now = Date.now()): JoinCode {
    this.prune(now);
    const code = normalizeCode(String(randomInt(0, 100_000_000)).padStart(8, '0'))!;
    this.codes.set(code, now + CODE_TTL_MS);
    return { code, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
  }

  /** Uses the code up. False when it is wrong, spent or expired, or while too many wrong ones have arrived. */
  public redeem(code: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.failures && now - this.failures.firstAt >= FAILURE_WINDOW_MS) this.failures = null;
    if (this.failures && this.failures.count >= MAX_FAILURES) return false;
    const normalized = normalizeCode(code);
    if (normalized && this.codes.delete(normalized)) return true;
    this.failures = this.failures ? { ...this.failures, count: this.failures.count + 1 } : { count: 1, firstAt: now };
    return false;
  }

  private prune(now: number): void {
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }
}
