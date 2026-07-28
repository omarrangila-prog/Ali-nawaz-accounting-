/**
 * Named ledgers (Najeeb, Kamran…): roll-up behaviour.
 *
 * A ledger's total = entries posted directly to it + the balances of every
 * party assigned to it. A party may sit under several ledgers, so totals can
 * legitimately overlap — that must be surfaced, not hidden.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, buildAllLedgerViews, buildLedgerView, buildLines,
  buildCreditAdjustment, buildDebitAdjustment, ledgerAcc, ledgerOwnBalances,
  ledgerIsBalanced, partyAcc, type Posting,
} from './pdcEngine';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed Traders', openingBalance: 0, active: true, ledgerIds: ['L1'], createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal & Co', openingBalance: 0, active: true, ledgerIds: ['L1'], createdAt: 1, updatedAt: 1 },
      { id: 'C', name: 'Karim Sons', openingBalance: 0, active: true, ledgerIds: ['L2'], createdAt: 1, updatedAt: 1 },
      // Shared: belongs to BOTH Najeeb and Kamran.
      { id: 'S', name: 'Shared Customer', openingBalance: 0, active: true, ledgerIds: ['L1', 'L2'], createdAt: 1, updatedAt: 1 },
      { id: 'U', name: 'Unassigned Co', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [
      { id: 'L1', name: 'Najeeb', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'L2', name: 'Kamran', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    banks: [], bankAccounts: [], cheques: [], transactions: [],
    ledger: [], movements: [], allocations: [], audit: [],
    settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: 1 },
  };
}

function apply(d: PdcDataSet, p: Posting | { error: string }): PdcDataSet {
  if ('error' in p) throw new Error(p.error);
  return { ...d,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines] };
}

/** Post a balanced entry DIRECTLY to a named ledger's own account. */
function postToLedger(d: PdcDataSet, ledgerId: string, amount: number): PdcDataSet {
  const txn = {
    id: `T${d.transactions.length + 1}`, reference: `DR-${d.transactions.length + 1}`,
    type: 'Debit Adjustment' as const, date: '2026-07-01', month: 7, year: 2026,
    amount, createdAt: 1, updatedAt: 1,
  };
  const lines = buildLines(txn, [
    { account: ledgerAcc(ledgerId), debit: amount, description: 'Direct to ledger' },
    { account: { kind: 'cash', id: 'ADJ' }, credit: amount, description: 'Direct to ledger', mainLedger: 'Adjustments' },
  ]);
  return { ...d, transactions: [...d.transactions, txn], ledger: [...d.ledger, ...lines] };
}

describe('named ledger roll-up', () => {
  it('totals its assigned parties', () => {
    let d = seed();
    d = apply(d, buildDebitAdjustment(d, { partyId: 'A', amount: 150000, date: '2026-07-01' }));
    d = apply(d, buildDebitAdjustment(d, { partyId: 'B', amount: 60000, date: '2026-07-01' }));

    const v = buildLedgerView(d, 'L1')!;
    expect(v.ledger.name).toBe('Najeeb');
    expect(v.partiesTotal).toBe(210000);
    expect(v.ownBalance).toBe(0);
    expect(v.total).toBe(210000);
    // Only Najeeb's parties appear — Karim (Kamran's) is absent.
    expect(v.parties.map((r) => r.party.id).sort()).toEqual(['A', 'B', 'S']);
  });

  it('counts entries posted DIRECTLY to the ledger as well as its parties', () => {
    let d = seed();
    d = apply(d, buildDebitAdjustment(d, { partyId: 'A', amount: 100000, date: '2026-07-01' }));
    d = postToLedger(d, 'L1', 25000);   // e.g. cash Najeeb personally took

    const v = buildLedgerView(d, 'L1')!;
    expect(v.ownBalance).toBe(25000);
    expect(v.partiesTotal).toBe(100000);
    expect(v.total).toBe(125000);       // both sides included
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('ledger own-balance is tracked separately from party balances', () => {
    let d = seed();
    d = postToLedger(d, 'L1', 40000);
    d = postToLedger(d, 'L2', 15000);

    const own = ledgerOwnBalances(d);
    expect(own.get('L1')).toBe(40000);
    expect(own.get('L2')).toBe(15000);
    // A direct ledger entry must NOT leak into any party's balance.
    expect(accountBalance(d, partyAcc('A'))).toBe(0);
    expect(accountBalance(d, ledgerAcc('L1'))).toBe(40000);
  });

  it('flags a party shared across ledgers and names the other ledger', () => {
    let d = seed();
    d = apply(d, buildDebitAdjustment(d, { partyId: 'S', amount: 80000, date: '2026-07-01' }));

    const najeeb = buildLedgerView(d, 'L1')!;
    const kamran = buildLedgerView(d, 'L2')!;

    const inNajeeb = najeeb.parties.find((r) => r.party.id === 'S')!;
    expect(inNajeeb.shared).toBe(true);
    expect(inNajeeb.sharedWith).toEqual(['Kamran']);

    const inKamran = kamran.parties.find((r) => r.party.id === 'S')!;
    expect(inKamran.shared).toBe(true);
    expect(inKamran.sharedWith).toEqual(['Najeeb']);

    // The SAME balance appears in both totals — overlap is real and reported.
    expect(najeeb.sharedPartyIds).toContain('S');
    expect(kamran.sharedPartyIds).toContain('S');
    expect(najeeb.total).toBe(80000);
    expect(kamran.total).toBe(80000);
  });

  it('splits receivable and payable across the ledger and its parties', () => {
    let d = seed();
    d = apply(d, buildDebitAdjustment(d, { partyId: 'A', amount: 120000, date: '2026-07-01' }));  // owes us
    d = apply(d, buildCreditAdjustment(d, { partyId: 'B', amount: 45000, date: '2026-07-01' })); // we owe

    const v = buildLedgerView(d, 'L1')!;
    expect(v.receivable).toBe(120000);
    expect(v.payable).toBe(45000);
    expect(v.total).toBe(75000);   // net
  });

  it('an unassigned party appears in no ledger', () => {
    let d = seed();
    d = apply(d, buildDebitAdjustment(d, { partyId: 'U', amount: 99000, date: '2026-07-01' }));
    for (const v of buildAllLedgerViews(d)) {
      expect(v.parties.some((r) => r.party.id === 'U')).toBe(false);
    }
  });

  it('lists every ledger, name-sorted', () => {
    const views = buildAllLedgerViews(seed());
    expect(views.map((v) => v.ledger.name)).toEqual(['Kamran', 'Najeeb']);
  });

  it('returns null for a ledger that does not exist', () => {
    expect(buildLedgerView(seed(), 'nope')).toBeNull();
  });
});
