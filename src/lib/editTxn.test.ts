/**
 * Editing a posted transaction.
 *
 * An edit is a reversal plus a correction, so the wrong figure and the right
 * one both stay in history. What matters is that the BALANCE ends up as if only
 * the corrected entry had ever been posted, and that the books stay balanced
 * throughout.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildCashReceived,
  ledgerIsBalanced, accountBalance, partyAcc, cashBalance, bankBalances,
  computeProfit, type Posting,
} from './pdcEngine';
import { buildPartyLedger } from './pdcRegister';
import { buildReversal } from './chequeWorkflow';

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

/** The store's edit: reverse the original, then post the correction. */
function edit(d: PdcDataSet, txnId: string, corrected: Posting, on = '2026-08-10'): PdcDataSet {
  const rev = buildReversal(d, txnId, on);
  if ('error' in rev) throw new Error(rev.error);
  let next = apply(d, { ...rev, movements: [] } as unknown as Posting);
  // The original is marked reversed, exactly as the store records it.
  next = {
    ...next,
    transactions: next.transactions.map((t) =>
      t.id === txnId ? { ...t, reversed: true, reversedByTxnId: rev.txn.id } : t
    ),
  };
  return apply(next, corrected);
}

const bal = (d: PdcDataSet, id: string) => accountBalance(d, partyAcc(id));

describe('editing an amount', () => {
  it('leaves the balance as if only the corrected figure was posted', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    expect(bal(d, 'A')).toBe(100_000);

    // The amount was mistyped: it should have been 10,000.
    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    expect(bal(d, 'A')).toBe(10_000);
    expect(computeProfit(d).sales).toBe(10_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('keeps the original and the correction both visible in history', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    // Original, its reversal, and the correction — nothing is erased.
    expect(d.transactions).toHaveLength(3);
    expect(d.transactions.find((t) => t.id === id)!.reversed).toBe(true);
    expect(d.transactions.some((t) => t.type === 'Reversal')).toBe(true);
  });
});

describe('editing the party', () => {
  it('moves the entry off the wrong party and onto the right one', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;

    // It was Bilal's sale, not Ahmed's.
    d = edit(d, id, buildSale(d, { partyId: 'B', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));

    expect(bal(d, 'A')).toBe(0);
    expect(bal(d, 'B')).toBe(50_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('editing the details that only describe an entry', () => {
  it('changes quantity, rate, item and description without disturbing balances', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit',
      quantity: 100, rate: 500, itemName: 'Sugar', description: 'wrong note',
    }));
    const id = d.transactions[0].id;

    d = edit(d, id, buildSale(d, {
      partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit',
      quantity: 250, rate: 200, itemName: 'Rice', description: 'Rizwan order',
    }));

    const latest = d.transactions[d.transactions.length - 1];
    expect(latest.quantity).toBe(250);
    expect(latest.rate).toBe(200);
    expect(latest.itemName).toBe('Rice');
    expect(latest.description).toBe('Rizwan order');
    // The figure never changed, so neither did the balance.
    expect(bal(d, 'A')).toBe(50_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('editing how a payment was made', () => {
  it('switches a cash receipt to a bank receipt', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02', paymentMethod: 'cash',
    }));
    const id = d.transactions[1].id;
    expect(cashBalance(d)).toBe(60_000);

    // It actually went into the bank.
    d = edit(d, id, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));

    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(60_000);
    expect(bal(d, 'A')).toBe(0);             // still settled
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('switches a cash receipt to a cheque, which stays pending', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02', paymentMethod: 'cash',
    }));
    const id = d.transactions[1].id;

    d = edit(d, id, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));

    // The cash is gone; a pending cheque holds the value instead.
    expect(cashBalance(d)).toBe(0);
    expect(d.cheques).toHaveLength(1);
    expect(d.cheques[0].status).toBe('pending');
    expect(bal(d, 'A')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('the statement after an edit', () => {
  it('shows the correction and ends on the corrected balance', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    const led = buildPartyLedger(d, 'A');
    expect(led.balance).toBe(10_000);
    expect(led.balance).toBe(bal(d, 'A'));
    // Original, reversal and correction all appear — an audit trail, not a
    // silent rewrite.
    expect(led.rows).toHaveLength(3);
  });
});
