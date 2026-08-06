/**
 * The bundled Pakistani bank list, which an empty workspace seeds by itself.
 *
 * These guard the data the seed writes: the count the user expects, no
 * duplicates (which would create two ledgers for one bank), and no blank or
 * padded names that would break name-matching when a bank is typed instead of
 * picked.
 */
import { describe, it, expect } from 'vitest';
import { PAKISTAN_BANKS, PAKISTAN_BANK_OPTIONS } from '@/config/pakistanBanks';

describe('the bundled Pakistani banks', () => {
  it('holds the full list of 48', () => {
    expect(PAKISTAN_BANKS).toHaveLength(48);
  });

  it('has no duplicate names', () => {
    // A duplicate would seed the same bank twice and split its ledger in two.
    const keys = PAKISTAN_BANKS.map((b) => b.name.trim().toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has a usable name and kind', () => {
    for (const b of PAKISTAN_BANKS) {
      expect(b.name.trim()).not.toBe('');
      // Names are matched case-insensitively after trimming when a user types
      // one; stray whitespace would defeat that.
      expect(b.name).toBe(b.name.trim());
      expect(b.kind.trim()).not.toBe('');
    }
  });

  it('covers the banks used day to day', () => {
    const names = PAKISTAN_BANKS.map((b) => b.name.toLowerCase());
    for (const expected of ['habib', 'united bank', 'meezan', 'allied', 'alfalah', 'askari']) {
      expect(names.some((n) => n.includes(expected))).toBe(true);
    }
  });

  it('exposes the same list to the dropdown', () => {
    expect(PAKISTAN_BANK_OPTIONS).toHaveLength(PAKISTAN_BANKS.length);
    expect(new Set(PAKISTAN_BANK_OPTIONS.map((o) => o.id)).size)
      .toBe(PAKISTAN_BANK_OPTIONS.length);
  });
});

describe('seeding into a workspace', () => {
  /** The same skip-by-name rule the seed uses, in isolation. */
  const toSeed = (existing: string[]) => {
    const have = new Set(existing.map((n) => n.trim().toLowerCase()));
    return PAKISTAN_BANKS.filter((b) => !have.has(b.name.trim().toLowerCase()));
  };

  it('an empty workspace receives all 48', () => {
    expect(toSeed([])).toHaveLength(48);
  });

  it('never re-adds a bank that is already there', () => {
    // Running twice must be a no-op, so a retry cannot duplicate anything.
    const all = PAKISTAN_BANKS.map((b) => b.name);
    expect(toSeed(all)).toHaveLength(0);
  });

  it('fills only the gaps when some banks exist', () => {
    const some = PAKISTAN_BANKS.slice(0, 10).map((b) => b.name);
    expect(toSeed(some)).toHaveLength(38);
  });

  it('matches regardless of case or surrounding spaces', () => {
    const messy = ['  habib bank limited (hbl)  ', 'MEEZAN BANK'];
    const remaining = toSeed(messy);
    expect(remaining).toHaveLength(46);
    expect(remaining.some((b) => b.name.toLowerCase().includes('meezan'))).toBe(false);
  });
});

/**
 * The seed writes each bank under an id derived from its NAME, not a random
 * one. That is what makes a repeat seed overwrite rather than duplicate — with
 * random ids, two tabs seeding at once would leave 96 banks instead of 48.
 */
describe('the name-derived document id', () => {
  // Mirrors seedBankId in the store.
  const seedBankId = (name: string) =>
    `pk-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

  it('gives every bank a distinct id', () => {
    // A collision would merge two banks into one ledger.
    const ids = PAKISTAN_BANKS.map((b) => seedBankId(b.name));
    expect(new Set(ids).size).toBe(PAKISTAN_BANKS.length);
  });

  it('is stable — the same name always yields the same id', () => {
    for (const b of PAKISTAN_BANKS) {
      expect(seedBankId(b.name)).toBe(seedBankId(b.name));
    }
  });

  it('ignores case and surrounding spaces', () => {
    expect(seedBankId('  Meezan Bank ')).toBe(seedBankId('meezan bank'));
  });

  it('produces ids Firestore accepts', () => {
    for (const b of PAKISTAN_BANKS) {
      const id = seedBankId(b.name);
      expect(id).toMatch(/^[a-z0-9-]+$/);   // no slashes, spaces or brackets
      expect(id.startsWith('__')).toBe(false); // double underscore is reserved
      expect(id.length).toBeLessThan(1500);
      expect(id).not.toBe('.');
      expect(id).not.toBe('..');
    }
  });

  it('keeps banks with bracketed short names apart', () => {
    // "Habib Bank Limited (HBL)" and "Habib Metropolitan Bank" must not collapse
    // to the same id once punctuation is stripped.
    expect(seedBankId('Habib Bank Limited (HBL)'))
      .not.toBe(seedBankId('Habib Metropolitan Bank'));
  });
});
