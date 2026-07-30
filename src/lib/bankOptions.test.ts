/**
 * A bank picker must never be empty.
 *
 * Every Pakistani bank is offered as a ready option, so no form can dead-end
 * with "nothing to choose from" and no bank has to be created beforehand.
 */
import { describe, it, expect } from 'vitest';
import { PAKISTAN_BANKS } from '@/config/pakistanBanks';
import type { Bank, BankAccount } from '@/types/pdc';

const SUGGEST = 'new-bank:';

/** Mirrors the option list the entry forms build. */
function accountPickerOptions(banks: Bank[], accounts: BankAccount[]) {
  const real = accounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, label: a.title }));
  const haveBankIds = new Set(accounts.map((a) => a.bankId));
  const usedNames = new Set(
    banks.filter((b) => haveBankIds.has(b.id)).map((b) => b.name.trim().toLowerCase())
  );
  const suggestions = PAKISTAN_BANKS
    .filter((b) => !usedNames.has(b.name.trim().toLowerCase()))
    .map((b) => ({ id: `${SUGGEST}${b.name}`, label: b.name }));
  return [...real, ...suggestions];
}

describe('bank account picker options', () => {
  it('is never empty, even with no banks and no accounts', () => {
    const opts = accountPickerOptions([], []);
    expect(opts.length).toBe(PAKISTAN_BANKS.length);
    expect(opts.length).toBeGreaterThan(40);
  });

  it('offers the banks a Pakistani business would expect', () => {
    const labels = accountPickerOptions([], []).map((o) => o.label).join(' | ');
    for (const name of ['Habib Bank', 'United Bank', 'Meezan Bank', 'Bank Alfalah',
                        'National Bank of Pakistan', 'MCB Bank']) {
      expect(labels).toContain(name);
    }
  });

  it('marks suggestions distinctly from real accounts', () => {
    const opts = accountPickerOptions([], []);
    expect(opts.every((o) => o.id.startsWith(SUGGEST))).toBe(true);
  });

  it('lists existing accounts first, and stops suggesting their bank', () => {
    const banks: Bank[] = [{ id: 'b1', name: 'Meezan Bank', active: true, createdAt: 1, updatedAt: 1 }];
    const accounts: BankAccount[] = [
      { id: 'a1', bankId: 'b1', title: 'Meezan — Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ];
    const opts = accountPickerOptions(banks, accounts);
    // The real account comes first and is selectable directly.
    expect(opts[0].id).toBe('a1');
    expect(opts[0].id.startsWith(SUGGEST)).toBe(false);
    // Meezan is no longer suggested, since an account already exists for it.
    const suggested = opts.filter((o) => o.id.startsWith(SUGGEST)).map((o) => o.label);
    expect(suggested).not.toContain('Meezan Bank');
    expect(suggested.length).toBe(PAKISTAN_BANKS.length - 1);
  });
});
