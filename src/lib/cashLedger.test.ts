/**
 * The Cash Account — every physical-cash movement in one place.
 *
 * It reads the same ledger lines the cash balance is replayed from, so a cash
 * entry cannot be recorded without appearing here, and the breakdown can never
 * disagree with the balance.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid, buildExpense,
  cashBalance, ledgerIsBalanced, type Posting,
} from './pdcEngine';
import { buildCashLedger } from './pdcRegister';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
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
  const cheques = p.cheque
    ? [...d.cheques.filter((c) => c.id !== p.cheque!.id), p.cheque]
    : d.cheques;
  return {
    ...d, cheques,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines],
    movements: [...d.movements, ...p.movements],
  };
}

describe('the cash account', () => {
  it('starts empty', () => {
    const c = buildCashLedger(seed());
    expect(c.rows).toHaveLength(0);
    expect(c.balance).toBe(0);
    expect(c.totalIn).toBe(0);
    expect(c.totalOut).toBe(0);
  });

  it('records cash received through Receive', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 40_000, date: '2026-08-02', paymentMethod: 'cash',
    }));
    const c = buildCashLedger(d);
    expect(c.rows).toHaveLength(1);
    expect(c.breakdown.fromReceive).toBe(40_000);
    expect(c.totalIn).toBe(40_000);
    expect(c.balance).toBe(40_000);
  });

  it('records cash paid through Pay', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 40_000, date: '2026-08-02', paymentMethod: 'cash',
    }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'B', amount: 15_000, date: '2026-08-03', paymentMethod: 'cash',
    }));
    const c = buildCashLedger(d);
    expect(c.breakdown.forPay).toBe(15_000);
    expect(c.totalOut).toBe(15_000);
    expect(c.balance).toBe(25_000);
  });

  it('records cash taken on a Sale and cash paid on a Purchase', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash',
    }));
    d = apply(d, buildPurchase(d, {
      partyId: 'B', amount: 20_000, date: '2026-08-02', settlement: 'cash',
    }));
    const c = buildCashLedger(d);
    expect(c.breakdown.fromSales).toBe(70_000);
    expect(c.breakdown.forPurchases).toBe(20_000);
    expect(c.balance).toBe(50_000);
  });

  it('records cash spent on an Expense', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 30_000, date: '2026-08-01', paymentMethod: 'cash',
    }));
    d = apply(d, buildExpense(d, { amount: 5_000, date: '2026-08-02', category: 'Rent' }));
    const c = buildCashLedger(d);
    expect(c.breakdown.forExpenses).toBe(5_000);
    expect(c.balance).toBe(25_000);
  });

  it('ignores anything that did not touch physical cash', () => {
    let d = seed();
    // A credit sale, a bank receipt and a cheque receipt: none is cash.
    d = apply(d, buildSale(d, { partyId: 'A', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 30_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 20_000, date: '2026-08-03',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));

    const c = buildCashLedger(d);
    expect(c.rows).toHaveLength(0);
    expect(c.balance).toBe(0);
  });
});

describe('the cash account always agrees with the engine', () => {
  it('its balance equals cashBalance, entry for entry', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash' }));
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 40_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = apply(d, buildPurchase(d, { partyId: 'B', amount: 20_000, date: '2026-08-03', settlement: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 15_000, date: '2026-08-04', paymentMethod: 'cash' }));
    d = apply(d, buildExpense(d, { amount: 5_000, date: '2026-08-05', category: 'Fuel' }));

    const c = buildCashLedger(d);
    expect(c.balance).toBe(cashBalance(d));
    // 70,000 + 40,000 in; 20,000 + 15,000 + 5,000 out.
    expect(c.totalIn).toBe(110_000);
    expect(c.totalOut).toBe(40_000);
    expect(c.balance).toBe(70_000);
    expect(c.rows).toHaveLength(5);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('in minus out always equals the balance', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 12_345, date: '2026-08-01', paymentMethod: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 2_345, date: '2026-08-02', paymentMethod: 'cash' }));
    const c = buildCashLedger(d);
    expect(c.totalIn - c.totalOut).toBe(c.balance);
  });

  it('the breakdown adds up to the totals, leaving nothing unaccounted for', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash' }));
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 40_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = apply(d, buildPurchase(d, { partyId: 'B', amount: 20_000, date: '2026-08-03', settlement: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 15_000, date: '2026-08-04', paymentMethod: 'cash' }));
    d = apply(d, buildExpense(d, { amount: 5_000, date: '2026-08-05', category: 'Fuel' }));

    const { breakdown: b, totalIn, totalOut } = buildCashLedger(d);
    expect(b.fromSales + b.fromReceive + b.fromOther).toBe(totalIn);
    expect(b.forPurchases + b.forPay + b.forExpenses + b.forOther).toBe(totalOut);
  });

  it('runs the balance up and down in date order', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 50_000, date: '2026-08-01', paymentMethod: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 20_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 10_000, date: '2026-08-03', paymentMethod: 'cash' }));

    // Oldest first, as the statement prints it.
    const chrono = [...buildCashLedger(d).rows].reverse();
    expect(chrono.map((r) => r.running)).toEqual([50_000, 30_000, 40_000]);
  });
});
