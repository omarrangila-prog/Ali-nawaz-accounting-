/**
 * Backup and restore safety.
 *
 * A backup is the last line of defence, so these check the round-trip is
 * lossless and that a bad file is refused BEFORE anything is written.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import { buildBackup, validateBackup, describeBackup, BACKUP_VERSION } from './pdcBackup';
import { buildPdcReceived, buildSale, type Posting } from './pdcEngine';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 1000, active: true, ledgerIds: ['L1'], createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [{ id: 'L1', name: 'Najeeb', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{ id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 500, active: true, createdAt: 1, updatedAt: 1 }],
    cheques: [], transactions: [], ledger: [], movements: [], allocations: [], audit: [],
    settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: 1 },
  };
}
function apply(d: PdcDataSet, p: Posting): PdcDataSet {
  const cheques = p.cheque ? [...d.cheques, p.cheque] : d.cheques;
  return { ...d, cheques,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines],
    movements: [...d.movements, ...p.movements] };
}

function populated(): PdcDataSet {
  let d = seed();
  d = apply(d, buildSale(d, { partyId: 'A', amount: 50000, date: '2026-07-01', settlement: 'credit' }));
  d = apply(d, buildPdcReceived(d, {
    partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
    chequeDate: '2026-08-01', amount: 50000, date: '2026-07-02',
  }));
  return d;
}

describe('backup round-trip', () => {
  it('captures every record with nothing lost', () => {
    const d = populated();
    const b = buildBackup(d);

    expect(b.version).toBe(BACKUP_VERSION);
    expect(b.data.parties).toHaveLength(d.parties.length);
    expect(b.data.ledgers).toHaveLength(d.ledgers.length);
    expect(b.data.cheques).toHaveLength(d.cheques.length);
    expect(b.data.transactions).toHaveLength(d.transactions.length);
    expect(b.data.ledger).toHaveLength(d.ledger.length);
    expect(b.data.movements).toHaveLength(d.movements.length);
    // Counts must match the payload, since the restore dialog shows them.
    expect(b.counts.transactions).toBe(d.transactions.length);
    expect(b.counts.ledgerEntries).toBe(d.ledger.length);
  });

  it('survives JSON serialisation unchanged', () => {
    const d = populated();
    const round = JSON.parse(JSON.stringify(buildBackup(d)));
    const check = validateBackup(round);
    expect(check.ok).toBe(true);
    expect(check.backup!.data.transactions).toEqual(d.transactions);
    expect(check.backup!.data.ledger).toEqual(d.ledger);
    expect(check.backup!.data.cheques).toEqual(d.cheques);
    // Ledger assignments and opening balances survive.
    expect(check.backup!.data.parties[0].ledgerIds).toEqual(['L1']);
    expect(check.backup!.data.parties[0].openingBalance).toBe(1000);
  });

  it('describes itself for the confirmation dialog', () => {
    const text = describeBackup(buildBackup(populated()));
    expect(text).toContain('2 transactions');
    expect(text).toContain('1 cheques');
  });
});

describe('restore validation refuses bad files', () => {
  it('rejects junk', () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup('hello').ok).toBe(false);
    expect(validateBackup({}).ok).toBe(false);
  });

  it('rejects a backup from a NEWER app version', () => {
    const b = buildBackup(populated());
    const res = validateBackup({ ...b, version: BACKUP_VERSION + 1 });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('newer version');
  });

  it('rejects a file missing core collections', () => {
    const b = buildBackup(populated());
    const broken = { ...b, data: { ...b.data, transactions: undefined } };
    expect(validateBackup(broken).ok).toBe(false);
  });

  it('warns about orphan ledger lines rather than silently importing them', () => {
    const b = buildBackup(populated());
    b.data.ledger = b.data.ledger.map((l) => ({ ...l, txnId: 'GONE' }));
    const res = validateBackup(b);
    expect(res.ok).toBe(true);                        // still importable
    expect(res.warnings.join(' ')).toContain('missing transaction');
  });

  it('warns when a posting in the file does not balance', () => {
    const b = buildBackup(populated());
    b.data.ledger[0] = { ...b.data.ledger[0], debit: 999999 };
    const res = validateBackup(b);
    expect(res.warnings.join(' ')).toContain('do not balance');
  });

  it('warns on an empty backup', () => {
    const res = validateBackup(buildBackup(seed()));
    expect(res.warnings.join(' ')).toContain('no transactions');
  });
});
