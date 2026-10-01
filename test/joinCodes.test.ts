import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JoinCodes, normalizeCode } from '../src/joinCodes.js';

const MINUTE = 60 * 1000;

describe('normalizeCode', () => {
  it('accepts the digits however they are grouped', () => {
    expect(normalizeCode('12345678')).toBe('1234-5678');
    expect(normalizeCode(' 1234 5678 ')).toBe('1234-5678');
    expect(normalizeCode('1234-5678')).toBe('1234-5678');
  });

  it('rejects anything but eight digits', () => {
    expect(normalizeCode('1234-567')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });
});

describe('JoinCodes', () => {
  it('redeems a code once', () => {
    const codes = new JoinCodes();
    const { code } = codes.create(0);
    expect(code).toMatch(/^\d{4}-\d{4}$/);
    expect(codes.redeem(code, MINUTE)).toBe(true);
    expect(codes.redeem(code, MINUTE)).toBe(false);
  });

  it('expires a code after a day', () => {
    const codes = new JoinCodes();
    const { code, expiresAt } = codes.create(0);
    expect(expiresAt).toBe(new Date(24 * 60 * MINUTE).toISOString());
    expect(codes.redeem(code, 24 * 60 * MINUTE)).toBe(false);
  });

  it('still takes a code hours later', () => {
    const codes = new JoinCodes();
    const { code } = codes.create(0);
    expect(codes.redeem(code, 5 * 60 * MINUTE)).toBe(true);
  });

  it('refuses every code after ten wrong ones, for 15 minutes', () => {
    const codes = new JoinCodes();
    const { code } = codes.create(0);
    const wrong = code === '0000-0000' ? '0000-0001' : '0000-0000';
    for (let i = 0; i < 10; i += 1) expect(codes.redeem(wrong, MINUTE)).toBe(false);
    expect(codes.redeem(code, MINUTE)).toBe(false);
    const fresh = codes.create(15 * MINUTE);
    expect(codes.redeem(fresh.code, 16 * MINUTE)).toBe(true);
  });

  it('checks a code without using it up', () => {
    const codes = new JoinCodes();
    const { code } = codes.create(0);
    expect(codes.check(code, MINUTE)).toBe(true);
    expect(codes.check(code, MINUTE)).toBe(true);
    expect(codes.redeem(code, MINUTE)).toBe(true);
    expect(codes.check(code, MINUTE)).toBe(false);
  });

  it('counts a wrong code checked against the same allowance as one redeemed', () => {
    const codes = new JoinCodes();
    const { code } = codes.create(0);
    const wrong = code === '0000-0000' ? '0000-0001' : '0000-0000';
    for (let i = 0; i < 5; i += 1) expect(codes.check(wrong, MINUTE)).toBe(false);
    for (let i = 0; i < 5; i += 1) expect(codes.redeem(wrong, MINUTE)).toBe(false);
    expect(codes.check(code, MINUTE)).toBe(false);
    expect(codes.redeem(code, MINUTE)).toBe(false);
  });

  it('keeps unused codes across a restart when given a file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-codes-')), 'join-codes.json');
    const { code } = new JoinCodes(file).create(Date.now());
    const restarted = new JoinCodes(file);
    expect(restarted.redeem(code)).toBe(true);
    expect(new JoinCodes(file).redeem(code)).toBe(false);
  });
});
