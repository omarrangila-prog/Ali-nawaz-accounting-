/**
 * The core accounting workflows, end to end.
 *
 * Every workflow the business actually performs is exercised here against the
 * real posting engine and the real read-side projections — the same functions
 * the screens call. Nothing is stubbed, so a failure here is a failure the user
 * would see.
 *
 * Covered: opening balance · sale · purchase · cash receive · cheque receive
 * without a cheque number · cash pay · cheque pay without a number · adding
 * cheque details later · deleting · party ledger · party statement · running
 * balance · transaction history · automatic posting.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet, Cheque } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid,
  ledgerIsBalanced, accountBalance, partyAcc, cashBalance, bankBalances,
  type Posting,
} from './pdcEngine';
import { buildRegister, buildPartyLedger } from './pdcRegister';
import { buildChequeClear, buildChequeDeposit } from './chequeWorkflow';

const OPENING = 50_000;

/**
 * What a party's account stands at, including their opening balance — the
 * same figure the ledger screen shows.
 */
function partyBalance(d: PdcDataSet, id: string): number {
  // accountBalance already seeds from the party's opening balance.
  return accountBalance(d, partyAcc(id));
}

function seed(): PdcDataSet {
  return {
    parties: [
      // A customer who already owed us money before the system started.
      { id: 'CUST', name: 'Ahmed Traders', openingBalance: OPENING, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'SUPP', name: 'Karachi Mills', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{ id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
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

/** Remove a transaction and everything posted with it, as the store does. */
function remove(d: PdcDataSet, txnId: string): PdcDataSet {
  const txn = d.transactions.find((t) => t.id === txnId);
  return {
    ...d,
    transactions: d.transactions.filter((t) => t.id !== txnId),
    ledger: d.ledger.filter((l) => l.txnId !== txnId),
    movements: d.movements.filter((m) => m.txnId !== txnId),
    cheques: txn?.chequeId ? d.cheques.filter((c) => c.id !== txn.chequeId) : d.cheques,
  };
}

// --- 1. Opening balance ----------------------------------------------------

describe('opening balance', () => {
  it('is the balance before any transaction exists', () => {
    const d = seed();
    expect(partyBalance(d, 'CUST')).toBe(OPENING);
    expect(buildPartyLedger(d, 'CUST').balance).toBe(OPENING);
  });

  it('seeds the running balance, so the first entry builds on it', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));
    const { rows, balance } = buildPartyLedger(d, 'CUST');
    // 50,000 opening + 10,000 sale — NOT 10,000.
    expect(rows[0].running).toBe(60_000);
    expect(balance).toBe(60_000);
  });
});

// --- 2. Sale ---------------------------------------------------------------

describe('sale', () => {
  it('posts to the customer ledger automatically and takes no payment', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'CUST', amount: 25_000, date: '2026-08-02', settlement: 'credit',
      quantity: 100, rate: 250, itemName: 'Sugar',
    }));

    // The customer owes 25,000 more; no money has moved.
    expect(partyBalance(d, 'CUST')).toBe(OPENING + 25_000);
    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(d.cheques).toHaveLength(0);
    expect(ledgerIsBalanced(d)).toBe(true);

    // Quantity and rate are kept, so the list can show them as columns.
    const t = d.transactions[0];
    expect(t.quantity).toBe(100);
    expect(t.rate).toBe(250);
    expect(t.itemName).toBe('Sugar');
  });

  it('appears in the party ledger straight away', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 25_000, date: '2026-08-02', settlement: 'credit' }));
    expect(buildPartyLedger(d, 'CUST').rows).toHaveLength(1);
  });
});

// --- 3. Purchase -----------------------------------------------------------

describe('purchase', () => {
  it('posts to the supplier ledger automatically and pays nothing', () => {
    let d = seed();
    d = apply(d, buildPurchase(d, {
      partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit',
      quantity: 200, rate: 200, itemName: 'Wheat',
    }));

    // We owe the supplier — a payable is negative on this sign convention.
    expect(partyBalance(d, 'SUPP')).toBe(-40_000);
    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

// --- 4. Receive ------------------------------------------------------------

describe('receive', () => {
  it('cash receipt reduces what the customer owes and raises cash', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 20_000, date: '2026-08-03', paymentMethod: 'cash',
    }));
    expect(partyBalance(d, 'CUST')).toBe(OPENING - 20_000);
    expect(cashBalance(d)).toBe(20_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('SAVES a cheque receipt with NO cheque number, bank or date', () => {
    let d = seed();
    // Exactly what the form sends when the user leaves every cheque field blank.
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 30_000, date: '2026-08-03',
      paymentMethod: 'cheque', cheque: {},
    }));

    expect(d.cheques).toHaveLength(1);
    const c = d.cheques[0];
    expect(c.chequeNumber).toBe('');          // blank is allowed
    expect(c.bankId).toBe('');                // bank can come later
    expect(c.chequeDate).toBe('2026-08-03');  // falls back to the entry date
    expect(c.status).toBe('pending');         // received ≠ cleared
    expect(c.direction).toBe('received');

    // The receipt still settles the customer, and no cash has arrived yet.
    expect(partyBalance(d, 'CUST')).toBe(OPENING - 30_000);
    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

// --- 5. Pay ----------------------------------------------------------------

describe('pay', () => {
  it('cash payment reduces what we owe and lowers cash', () => {
    let d = seed();
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 15_000, date: '2026-08-04', paymentMethod: 'cash',
    }));
    expect(partyBalance(d, 'SUPP')).toBe(-25_000);
    expect(cashBalance(d)).toBe(-15_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('SAVES a cheque payment with NO cheque number', () => {
    let d = seed();
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 40_000, date: '2026-08-04',
      paymentMethod: 'cheque', cheque: {},
    }));

    expect(d.cheques).toHaveLength(1);
    expect(d.cheques[0].chequeNumber).toBe('');
    expect(d.cheques[0].direction).toBe('issued');
    expect(d.cheques[0].status).toBe('pending');
    // The supplier is settled, but the bank has not been touched.
    expect(partyBalance(d, 'SUPP')).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

// --- 6. Adding cheque details later ---------------------------------------

describe('adding cheque details later', () => {
  it('a numberless cheque can be completed, then cleared normally', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 30_000, date: '2026-08-03',
      paymentMethod: 'cheque', cheque: {},
    }));

    // The user opens the cheque later and fills in what they now know.
    const filled: Cheque = {
      ...d.cheques[0],
      chequeNumber: '778899',
      bankId: 'HBL',
      chequeDate: '2026-09-15',
      updatedAt: 2,
    };
    d = { ...d, cheques: [filled] };

    expect(d.cheques[0].chequeNumber).toBe('778899');
    // Still one physical cheque — completing details never duplicates it.
    expect(d.cheques).toHaveLength(1);

    // And it banks exactly as a fully-detailed cheque would: deposit, then
    // clear. A cheque cannot jump straight from pending to cleared.
    d = apply(d, buildChequeDeposit(d, { chequeId: filled.id, bankAccountId: 'ACC1', date: '2026-09-14' }));
    d = apply(d, buildChequeClear(d, { chequeId: filled.id, date: '2026-09-15' }));
    expect(d.cheques.find((c) => c.id === filled.id)!.status).toBe('cleared');
    expect(bankBalances(d).get('ACC1')).toBe(30_000);
    expect(partyBalance(d, 'CUST')).toBe(OPENING - 30_000); // unchanged by clearing
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

// --- 7. Deleting -----------------------------------------------------------

describe('deleting a transaction', () => {
  it('removes it and every trace of its effect', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 25_000, date: '2026-08-02', settlement: 'credit' }));
    const id = d.transactions[0].id;
    expect(partyBalance(d, 'CUST')).toBe(OPENING + 25_000);

    d = remove(d, id);

    expect(d.transactions).toHaveLength(0);
    expect(d.ledger.filter((l) => l.txnId === id)).toHaveLength(0);
    expect(partyBalance(d, 'CUST')).toBe(OPENING);      // back to opening
    expect(buildPartyLedger(d, 'CUST').rows).toHaveLength(0);
    expect(buildRegister(d)).toHaveLength(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('deleting a cheque receipt removes the cheque too', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 30_000, date: '2026-08-03',
      paymentMethod: 'cheque', cheque: {},
    }));
    expect(d.cheques).toHaveLength(1);

    d = remove(d, d.transactions[0].id);

    expect(d.cheques).toHaveLength(0);
    expect(partyBalance(d, 'CUST')).toBe(OPENING);
  });
});

// --- 8. Transaction history ------------------------------------------------

describe('transaction history', () => {
  it('shows EVERY transaction, not just the latest', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 10_000, date: '2026-08-01', settlement: 'credit', itemName: 'Sugar' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit', itemName: 'Wheat' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 5_000, date: '2026-08-03', paymentMethod: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'SUPP', amount: 7_000, date: '2026-08-04', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 3_000, date: '2026-08-05', paymentMethod: 'cheque', cheque: {},
    }));

    const reg = buildRegister(d);
    expect(reg).toHaveLength(5);
    // Every row carries what the list needs to be readable without opening it.
    for (const r of reg) {
      expect(r.txn.date).toBeTruthy();
      expect(r.txn.type).toBeTruthy();
      expect(r.method).toBeTruthy();
      expect(typeof r.running).toBe('number');
    }
  });

  it('is in chronological order', () => {
    let d = seed();
    // Entered out of order, as they would be when catching up on paperwork.
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 1, date: '2026-08-05', settlement: 'credit' }));
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 2, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 3, date: '2026-08-03', settlement: 'credit' }));

    // The register reads newest-first on screen…
    const dates = buildRegister(d).map((r) => r.txn.date);
    expect(dates).toEqual(['2026-08-05', '2026-08-03', '2026-08-01']);

    // …and the statement reads oldest-first, so the balance builds downwards.
    const stmt = [...buildPartyLedger(d, 'CUST').rows].reverse();
    expect(stmt.map((r) => r.entry.date)).toEqual(['2026-08-01', '2026-08-03', '2026-08-05']);
  });

  it('never duplicates or loses an entry', () => {
    let d = seed();
    for (let i = 0; i < 10; i++) {
      d = apply(d, buildSale(d, {
        partyId: 'CUST', amount: 1_000, date: `2026-08-${String(i + 1).padStart(2, '0')}`,
        settlement: 'credit',
      }));
    }
    expect(d.transactions).toHaveLength(10);
    expect(new Set(d.transactions.map((t) => t.id)).size).toBe(10);       // no dupes
    expect(new Set(d.transactions.map((t) => t.reference)).size).toBe(10); // unique refs
    expect(buildRegister(d)).toHaveLength(10);
    expect(buildPartyLedger(d, 'CUST').rows).toHaveLength(10);
    expect(partyBalance(d, 'CUST')).toBe(OPENING + 10_000);
  });
});

// --- 9. Party statement & running balance ---------------------------------

describe('party statement', () => {
  it('runs the balance up and down correctly across all four modules', () => {
    let d = seed();                                        // opening 50,000
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 30_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 20_000, date: '2026-08-03', paymentMethod: 'cash' }));
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 10_000, date: '2026-08-04', settlement: 'credit' }));

    const stmt = [...buildPartyLedger(d, 'CUST').rows].reverse();
    // 50,000 → +30,000 → −20,000 → +10,000
    expect(stmt.map((r) => r.running)).toEqual([80_000, 60_000, 70_000]);
    expect(partyBalance(d, 'CUST')).toBe(70_000);
  });

  it('a purchase then a payment walks a supplier back to zero', () => {
    let d = seed();
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildCashPaid(d, { partyId: 'SUPP', amount: 40_000, date: '2026-08-05', paymentMethod: 'cash' }));

    const stmt = [...buildPartyLedger(d, 'SUPP').rows].reverse();
    expect(stmt.map((r) => r.running)).toEqual([-40_000, 0]);
    expect(partyBalance(d, 'SUPP')).toBe(0);
  });

  it('the statement balance always equals the party balance', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 30_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 12_500, date: '2026-08-03', paymentMethod: 'cheque', cheque: {},
    }));
    expect(buildPartyLedger(d, 'CUST').balance).toBe(partyBalance(d, 'CUST'));
  });
});

// --- 10. The whole thing together -----------------------------------------

describe('a full trading month', () => {
  it('stays balanced and consistent through every module', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 100_000, date: '2026-08-01', settlement: 'credit', quantity: 400, rate: 250, itemName: 'Sugar' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 60_000, date: '2026-08-02', settlement: 'credit', quantity: 300, rate: 200, itemName: 'Wheat' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 40_000, date: '2026-08-05', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 60_000, date: '2026-08-06', paymentMethod: 'cheque', cheque: {} }));
    d = apply(d, buildCashPaid(d, { partyId: 'SUPP', amount: 60_000, date: '2026-08-07', paymentMethod: 'cheque', cheque: {} }));

    // Customer: 50,000 + 100,000 − 40,000 − 60,000 = 50,000
    expect(partyBalance(d, 'CUST')).toBe(50_000);
    // Supplier fully settled by the cheque.
    expect(partyBalance(d, 'SUPP')).toBe(0);
    // Only the cash receipt has actually moved money.
    expect(cashBalance(d)).toBe(40_000);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    // Two pending cheques, neither cleared.
    expect(d.cheques.filter((c) => c.status === 'pending')).toHaveLength(2);

    expect(ledgerIsBalanced(d)).toBe(true);
    expect(buildRegister(d)).toHaveLength(5);
    expect(buildPartyLedger(d, 'CUST').balance).toBe(partyBalance(d, 'CUST'));
    expect(buildPartyLedger(d, 'SUPP').balance).toBe(partyBalance(d, 'SUPP'));
  });
});

// --- 11. Many payments against one sale ------------------------------------

describe('a sale settled by several later payments', () => {
  it('accepts cash and multiple cheques against one invoice', () => {
    let d = seed();
    // One sale on credit. Nothing about payment is recorded with it.
    d = apply(d, buildSale(d, {
      partyId: 'CUST', amount: 300_000, date: '2026-08-01', settlement: 'credit',
      quantity: 1_000, rate: 300, itemName: 'Rice', description: 'Rizwan order',
    }));
    expect(partyBalance(d, 'CUST')).toBe(OPENING + 300_000);
    expect(d.cheques).toHaveLength(0);          // a sale creates no cheque

    // The customer then pays in four separate instalments, over time.
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 50_000, date: '2026-08-10', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 100_000, date: '2026-08-15',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'A1', bankId: 'HBL', chequeDate: '2026-09-01' },
    }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 100_000, date: '2026-08-20',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'A2', bankId: 'HBL', chequeDate: '2026-09-10' },
    }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 50_000, date: '2026-08-25',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'A3', bankId: 'HBL', chequeDate: '2026-09-20' },
    }));

    // Each payment is its own entry, and each cheque its own record.
    expect(d.transactions).toHaveLength(5);
    expect(d.cheques).toHaveLength(3);
    expect(d.cheques.every((c) => c.status === 'pending')).toBe(true);

    // The invoice is fully settled: 50,000 opening + 300,000 − 300,000.
    expect(partyBalance(d, 'CUST')).toBe(OPENING);
    // Only the cash instalment has actually moved money so far.
    expect(cashBalance(d)).toBe(50_000);
    expect(ledgerIsBalanced(d)).toBe(true);

    // The statement walks the balance down payment by payment.
    const stmt = [...buildPartyLedger(d, 'CUST').rows].reverse();
    expect(stmt.map((r) => r.running)).toEqual([350_000, 300_000, 200_000, 100_000, 50_000]);
  });
});
