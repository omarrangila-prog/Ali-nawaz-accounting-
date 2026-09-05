/**
 * Splitting parties into RECEIVABLE and PAYABLE.
 *
 * The whole point is that a party can never appear on the wrong side — that is
 * the confusion the filter exists to remove. So the split is checked against
 * the balances the engine itself reports.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid, buildCreditAdjustment,
  partyBalances, cashBalance, computeProfit, ledgerIsBalanced, type Posting,
} from './pdcEngine';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'CUST', name: 'Ahmed', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'SUPP', name: 'Bilal', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'NIL', name: 'Chandio', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [],
    banks: [{ id: 'HABIB', name: 'Habib Bank', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{ id: 'ACC1', bankId: 'HABIB', title: 'Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    cheques: [], transactions: [], ledger: [], movements: [], allocations: [], audit: [],
    settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: 1 },
  };
}

function apply(d: PdcDataSet, p: Posting | { error: string }): PdcDataSet {
  if ('error' in p) throw new Error(p.error);
  return {
    ...d,
    cheques: p.cheque ? [...d.cheques, p.cheque] : d.cheques,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines],
    movements: [...d.movements, ...p.movements],
  };
}

/** The same rule the Ledger page applies to build each list. */
function split(d: PdcDataSet) {
  const bal = partyBalances(d);
  const rows = d.parties.map((p) => ({ party: p, balance: bal.get(p.id) ?? 0 }));
  return {
    receivable: rows.filter((r) => r.balance > 0),
    payable: rows.filter((r) => r.balance < 0),
    settled: rows.filter((r) => r.balance === 0),
    totalReceivable: rows.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0),
    totalPayable: rows.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0),
  };
}

describe('receivable and payable lists', () => {
  it('a customer who owes us is receivable, a supplier we owe is payable', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit' }));

    const s = split(d);
    expect(s.receivable.map((r) => r.party.id)).toEqual(['CUST']);
    expect(s.payable.map((r) => r.party.id)).toEqual(['SUPP']);
    expect(s.totalReceivable).toBe(90_000);
    expect(s.totalPayable).toBe(40_000);
  });

  it('never puts the same party on both sides', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit' }));

    const s = split(d);
    const ids = new Set(s.receivable.map((r) => r.party.id));
    expect(s.payable.every((r) => !ids.has(r.party.id))).toBe(true);
  });

  it('a settled party is on neither side', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 50_000, date: '2026-08-02', paymentMethod: 'cash' }));

    const s = split(d);
    expect(s.receivable).toHaveLength(0);
    expect(s.payable).toHaveLength(0);
    expect(s.settled.map((r) => r.party.id)).toContain('CUST');
  });

  it('a party moves sides when their balance crosses zero', () => {
    let d = seed();
    // Ahmed owes us 50,000.
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));
    expect(split(d).receivable.map((r) => r.party.id)).toContain('CUST');

    // He overpays by 20,000 — now WE owe him.
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 70_000, date: '2026-08-02', paymentMethod: 'cash' }));
    const s = split(d);
    expect(s.receivable.map((r) => r.party.id)).not.toContain('CUST');
    expect(s.payable.map((r) => r.party.id)).toContain('CUST');
    expect(s.totalPayable).toBe(20_000);
  });

  it('an opening balance alone decides the side', () => {
    const d = seed();
    d.parties = [
      { ...d.parties[0], openingBalance: 30_000 },    // owes us from before
      { ...d.parties[1], openingBalance: -15_000 },   // we owed them from before
      d.parties[2],
    ];
    const s = split(d);
    expect(s.receivable.map((r) => r.party.id)).toEqual(['CUST']);
    expect(s.payable.map((r) => r.party.id)).toEqual(['SUPP']);
  });

  it('every party is on exactly one list — none is lost', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashPaid(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', paymentMethod: 'cash' }));

    const s = split(d);
    expect(s.receivable.length + s.payable.length + s.settled.length)
      .toBe(d.parties.length);
  });

  it('the two totals match the engine, so the chips cannot mislead', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit' }));

    const s = split(d);
    let rec = 0, pay = 0;
    for (const v of partyBalances(d).values()) {
      if (v > 0) rec += v; else if (v < 0) pay += -v;
    }
    expect(s.totalReceivable).toBe(rec);
    expect(s.totalPayable).toBe(pay);
  });
});

/**
 * The list must always show the CURRENT outstanding position: a party settled
 * a moment ago should be gone from it, without anything being marked by hand.
 */
describe('the list reflects the current position', () => {
  it('a party drops off the Receivable list the moment they pay in full', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    expect(split(d).receivable.map((r) => r.party.id)).toContain('CUST');

    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 60_000, date: '2026-08-02', paymentMethod: 'cash' }));

    const s = split(d);
    expect(s.receivable.map((r) => r.party.id)).not.toContain('CUST');
    expect(s.payable.map((r) => r.party.id)).not.toContain('CUST');
    expect(s.settled.map((r) => r.party.id)).toContain('CUST');
    expect(s.totalReceivable).toBe(0);
  });

  it('a part payment leaves only the remainder outstanding', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 25_000, date: '2026-08-02', paymentMethod: 'cash' }));

    const s = split(d);
    expect(s.receivable.find((r) => r.party.id === 'CUST')!.balance).toBe(35_000);
    expect(s.totalReceivable).toBe(35_000);
  });

  it('a supplier drops off Payable once paid', () => {
    let d = seed();
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 45_000, date: '2026-08-01', settlement: 'credit' }));
    expect(split(d).payable.map((r) => r.party.id)).toContain('SUPP');

    d = apply(d, buildCashPaid(d, { partyId: 'SUPP', amount: 45_000, date: '2026-08-02', paymentMethod: 'cash' }));

    const s = split(d);
    expect(s.payable.map((r) => r.party.id)).not.toContain('SUPP');
    expect(s.totalPayable).toBe(0);
  });

  it('the listed total always equals the sum of the rows listed', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildSale(d, { partyId: 'NIL', amount: 15_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 45_000, date: '2026-08-03', settlement: 'credit' }));

    const s = split(d);
    // What the header prints is the sum of the visible rows, nothing else.
    expect(s.receivable.reduce((t, r) => t + Math.abs(r.balance), 0)).toBe(s.totalReceivable);
    expect(s.payable.reduce((t, r) => t + Math.abs(r.balance), 0)).toBe(s.totalPayable);
  });
});

/**
 * Recording a PAYABLE directly — an obligation with no money moving.
 *
 * This is the entry that was missing. Without it the only way to put a party on
 * the payable side was a Purchase (which also books a cost) or a negative
 * opening balance, so users reached for Pay instead — and Pay does the
 * opposite, because handing money over REDUCES what you owe.
 */
describe('recording a payable directly', () => {
  it('puts the party on the payable side without moving money', () => {
    let d = seed();
    d = apply(d, buildCreditAdjustment(d, {
      partyId: 'SUPP', amount: 80_000, date: '2026-09-01', description: 'goods owed',
    }));

    const s = split(d);
    expect(s.payable.map((r) => r.party.id)).toContain('SUPP');
    expect(s.receivable.map((r) => r.party.id)).not.toContain('SUPP');
    expect(s.totalPayable).toBe(80_000);
    // No money moved, and profit is untouched.
    expect(cashBalance(d)).toBe(0);
    expect(computeProfit(d).purchases).toBe(0);
    expect(computeProfit(d).expenses).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('paying it afterwards settles the party and reduces cash', () => {
    let d = seed();
    d = apply(d, buildCreditAdjustment(d, { partyId: 'SUPP', amount: 80_000, date: '2026-09-01' }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 80_000, date: '2026-09-02', paymentMethod: 'cash',
    }));

    const s = split(d);
    expect(s.payable.map((r) => r.party.id)).not.toContain('SUPP');
    expect(s.settled.map((r) => r.party.id)).toContain('SUPP');
    expect(cashBalance(d)).toBe(-80_000);   // the money genuinely left
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('PAY on its own makes the party RECEIVABLE — an advance, which is correct', () => {
    // This is the behaviour that looked wrong: paying someone who owed you
    // nothing means they now owe YOU. It is not a bug, so it is pinned here.
    let d = seed();
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 50_000, date: '2026-09-01', paymentMethod: 'cash',
    }));

    const s = split(d);
    expect(s.receivable.map((r) => r.party.id)).toContain('SUPP');
    expect(s.totalReceivable).toBe(50_000);
    expect(cashBalance(d)).toBe(-50_000);
  });

  it('a payable and a receivable on the same party net off', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 100_000, date: '2026-09-01', settlement: 'credit' }));
    d = apply(d, buildCreditAdjustment(d, { partyId: 'CUST', amount: 30_000, date: '2026-09-02' }));

    const s = split(d);
    expect(s.receivable.find((r) => r.party.id === 'CUST')!.balance).toBe(70_000);
    expect(s.payable).toHaveLength(0);
  });
});
