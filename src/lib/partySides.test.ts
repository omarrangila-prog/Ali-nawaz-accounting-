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
  buildSale, buildPurchase, buildCashReceived, buildCashPaid,
  partyBalances, type Posting,
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
