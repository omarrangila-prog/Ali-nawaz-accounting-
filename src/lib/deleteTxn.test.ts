/**
 * Deleting a transaction removes it completely — no ledger lines, no cheque,
 * no orphans — and balances return to exactly what they were beforehand.
 *
 * These test the same rules the store enforces, against the pure engine, so a
 * regression shows up without needing Firestore.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, cashBalance, ledgerIsBalanced, partyAcc,
  buildCashReceived, buildPdcReceived, buildSale, type Posting,
} from './pdcEngine';
import { buildChequeTransfer } from './chequeWorkflow';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [], banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{ id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    cheques: [], transactions: [], ledger: [], movements: [], allocations: [], audit: [],
    settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: 1 },
  };
}
function apply(d: PdcDataSet, p: Posting | { error: string }): PdcDataSet {
  if ('error' in p) throw new Error(p.error);
  const cheques = p.cheque ? [...d.cheques.filter((c) => c.id !== p.cheque!.id), p.cheque] : d.cheques;
  return { ...d, cheques,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines],
    movements: [...d.movements, ...p.movements] };
}

/** Mirrors what pdcStore.deleteTransaction() writes. */
function removeTxn(d: PdcDataSet, txnId: string): PdcDataSet {
  const txn = d.transactions.find((t) => t.id === txnId)!;
  const cheque = txn.chequeId ? d.cheques.find((c) => c.id === txn.chequeId) : undefined;
  return {
    ...d,
    transactions: d.transactions.filter((t) => t.id !== txnId),
    ledger: d.ledger.filter((l) => l.txnId !== txnId),
    cheques: cheque ? d.cheques.filter((c) => c.id !== cheque.id) : d.cheques,
    movements: cheque ? d.movements.filter((m) => m.chequeId !== cheque.id) : d.movements,
  };
}

/**
 * The store refuses only when entries came AFTER this one on the same cheque.
 * Deleting the most recent entry is always safe; deleting an earlier one would
 * orphan everything that followed it.
 */
function hasLaterEntries(d: PdcDataSet, txnId: string): boolean {
  const txn = d.transactions.find((t) => t.id === txnId)!;
  if (!txn.chequeId) return false;
  return d.transactions.some(
    (t) =>
      t.chequeId === txn.chequeId &&
      t.id !== txnId &&
      (t.date > txn.date || (t.date === txn.date && t.createdAt > txn.createdAt))
  );
}

describe('deleting a transaction', () => {
  it('restores balances to exactly what they were before', () => {
    const before = seed();
    let d = apply(before, buildCashReceived(before, { partyId: 'A', amount: 5000, date: '2026-07-01' }));
    expect(cashBalance(d)).toBe(5000);
    expect(accountBalance(d, partyAcc('A'))).toBe(-5000);

    d = removeTxn(d, d.transactions[0].id);
    expect(cashBalance(d)).toBe(0);
    expect(accountBalance(d, partyAcc('A'))).toBe(0);
    expect(d.transactions).toHaveLength(0);
    expect(d.ledger).toHaveLength(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('leaves NO orphan ledger lines behind', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 40000, date: '2026-07-01', settlement: 'credit' }));
    d = apply(d, buildSale(d, { partyId: 'B', amount: 25000, date: '2026-07-02', settlement: 'cash' }));
    const firstId = d.transactions[0].id;

    d = removeTxn(d, firstId);
    // The other sale survives untouched.
    expect(d.transactions).toHaveLength(1);
    expect(accountBalance(d, partyAcc('A'))).toBe(0);
    expect(cashBalance(d)).toBe(25000);
    // Every remaining line still belongs to a real transaction.
    const ids = new Set(d.transactions.map((t) => t.id));
    for (const l of d.ledger) expect(ids.has(l.txnId)).toBe(true);
  });

  it('removes the cheque and its history when deleting a cheque entry', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 90000, date: '2026-07-01',
    }));
    expect(d.cheques).toHaveLength(1);
    expect(d.movements).toHaveLength(1);

    d = removeTxn(d, d.transactions[0].id);
    expect(d.cheques).toHaveLength(0);      // cheque gone
    expect(d.movements).toHaveLength(0);    // history gone with it
    expect(accountBalance(d, partyAcc('A'))).toBe(0);
  });

  it('REFUSES to delete a cheque entry that later entries depend on', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 90000, date: '2026-07-01',
    }));
    const createId = d.transactions[0].id;
    // Endorse it to Bilal — now a second entry depends on this cheque.
    d = apply(d, buildChequeTransfer(d, {
      chequeId: d.cheques[0].id, toPartyId: 'B', amount: 90000, date: '2026-07-05',
    }));

    expect(hasLaterEntries(d, createId)).toBe(true);
    // Deleting the endorsement itself is fine — nothing depends on it.
    expect(hasLaterEntries(d, d.transactions[1].id)).toBe(false);
  });

  it('the ledger still balances after any delete', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 10000, date: '2026-07-01', settlement: 'cash' }));
    d = apply(d, buildCashReceived(d, { partyId: 'B', amount: 3000, date: '2026-07-02' }));
    d = removeTxn(d, d.transactions[0].id);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
