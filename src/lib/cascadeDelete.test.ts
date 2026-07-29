/**
 * Deleting a party or ledger removes everything attached to it, leaving no
 * orphaned rows and no wrong balances.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, cashBalance, ledgerIsBalanced, partyAcc, ledgerAcc, buildLines,
  buildCashReceived, buildPdcReceived, buildSale, buildPartyTransfer,
  partyDeleteImpact, partyDeleteTxnIds, ledgerDeleteImpact, type Posting,
} from './pdcEngine';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 0, active: true, ledgerIds: ['L1'], createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [{ id: 'L1', name: 'Najeeb', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
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

/** Mirrors pdcStore.deleteParty(). */
function removeParty(d: PdcDataSet, id: string): PdcDataSet {
  const txnIds = new Set(partyDeleteTxnIds(d, id));
  const chequeIds = new Set(d.cheques.filter((c) => c.partyId === id).map((c) => c.id));
  return {
    ...d,
    parties: d.parties.filter((p) => p.id !== id),
    transactions: d.transactions.filter((t) => !txnIds.has(t.id)),
    ledger: d.ledger.filter((l) => !txnIds.has(l.txnId)),
    cheques: d.cheques.filter((c) => !chequeIds.has(c.id)),
    movements: d.movements.filter((m) => !chequeIds.has(m.chequeId)),
  };
}

describe('deleting a party with transactions', () => {
  it('removes the party AND its transactions, leaving no orphans', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 40000, date: '2026-07-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 10000, date: '2026-07-02' }));
    d = apply(d, buildSale(d, { partyId: 'B', amount: 25000, date: '2026-07-03', settlement: 'cash' }));

    const impact = partyDeleteImpact(d, 'A');
    expect(impact.transactions).toBe(2);
    expect(impact.clean).toBe(false);

    d = removeParty(d, 'A');
    expect(d.parties.map((p) => p.id)).toEqual(['B']);
    expect(d.transactions).toHaveLength(1);            // only Bilal's sale left
    // No ledger line points at a transaction that no longer exists.
    const ids = new Set(d.transactions.map((t) => t.id));
    for (const l of d.ledger) expect(ids.has(l.txnId)).toBe(true);
    // No ledger line points at the deleted party.
    expect(d.ledger.some((l) => l.account.kind === 'party' && l.account.id === 'A')).toBe(false);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('takes the party\'s cheques and their history with it', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 90000, date: '2026-07-01',
    }));
    expect(d.cheques).toHaveLength(1);
    expect(d.movements).toHaveLength(1);

    const impact = partyDeleteImpact(d, 'A');
    expect(impact.cheques).toBe(1);

    d = removeParty(d, 'A');
    expect(d.cheques).toHaveLength(0);
    expect(d.movements).toHaveLength(0);
    expect(d.transactions).toHaveLength(0);
  });

  it('catches a transfer where the party is only the OTHER side', () => {
    let d = seed();
    d = apply(d, buildPartyTransfer(d, {
      fromPartyId: 'B', toPartyId: 'A', amount: 15000, date: '2026-07-01',
    }));
    // Deleting A must remove the transfer even though A is the "to" side.
    expect(partyDeleteImpact(d, 'A').transactions).toBe(1);

    d = removeParty(d, 'A');
    expect(d.transactions).toHaveLength(0);
    // Bilal's balance returns to zero — the transfer no longer exists.
    expect(accountBalance(d, partyAcc('B'))).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('leaves other parties\' balances untouched', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 40000, date: '2026-07-01', settlement: 'credit' }));
    d = apply(d, buildSale(d, { partyId: 'B', amount: 25000, date: '2026-07-02', settlement: 'cash' }));
    const bBefore = accountBalance(d, partyAcc('B'));
    const cashBefore = cashBalance(d);

    d = removeParty(d, 'A');
    expect(accountBalance(d, partyAcc('B'))).toBe(bBefore);
    expect(cashBalance(d)).toBe(cashBefore);   // A's sale was on credit
  });

  it('reports a clean delete when the party has no history', () => {
    const d = seed();
    const impact = partyDeleteImpact(d, 'B');
    expect(impact.clean).toBe(true);
    expect(impact.transactions).toBe(0);
  });
});

describe('deleting a named ledger', () => {
  it('counts only entries posted DIRECTLY to it', () => {
    let d = seed();
    // A party sale rolls up to the ledger but is NOT the ledger's own entry.
    d = apply(d, buildSale(d, { partyId: 'A', amount: 40000, date: '2026-07-01', settlement: 'credit' }));
    expect(ledgerDeleteImpact(d, 'L1').transactions).toBe(0);

    // Now post directly to the ledger.
    const txn = { id: 'T9', reference: 'DR-9', type: 'Debit Adjustment' as const,
      date: '2026-07-02', month: 7, year: 2026, amount: 5000, createdAt: 2, updatedAt: 2 };
    const lines = buildLines(txn, [
      { account: ledgerAcc('L1'), debit: 5000, description: 'direct' },
      { account: { kind: 'cash', id: 'ADJ' }, credit: 5000, description: 'direct', mainLedger: 'Adjustments' },
    ]);
    d = { ...d, transactions: [...d.transactions, txn], ledger: [...d.ledger, ...lines] };
    expect(ledgerDeleteImpact(d, 'L1').transactions).toBe(1);
  });

  it('unlinking a ledger leaves the party and its balance intact', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 40000, date: '2026-07-01', settlement: 'credit' }));
    const before = accountBalance(d, partyAcc('A'));

    // Deleting the ledger only strips the ledgerIds link.
    d = {
      ...d,
      ledgers: [],
      parties: d.parties.map((p) => ({ ...p, ledgerIds: (p.ledgerIds ?? []).filter((x) => x !== 'L1') })),
    };
    expect(d.parties.find((p) => p.id === 'A')!.ledgerIds).toEqual([]);
    expect(accountBalance(d, partyAcc('A'))).toBe(before);   // untouched
    expect(d.transactions).toHaveLength(1);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
