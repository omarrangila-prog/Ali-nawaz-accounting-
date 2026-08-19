/**
 * Aggregate consistency — the class of bug where the BALANCE is right but a
 * total, a card or a running-balance column disagrees with it.
 *
 * These are the numbers a user actually reads. A figure that is quietly wrong
 * is worse than one that is obviously missing, so every headline aggregate is
 * checked against the ledger it claims to summarise.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid, buildExpense,
  cashBalance, bankBalances, computeProfit, computeSummary, ledgerIsBalanced,
  accountBalance, partyAcc, type Posting,
} from './pdcEngine';
import { buildRegister, buildCashLedger, buildPartyLedger, rowTotals } from './pdcRegister';
import { buildReversal } from './chequeWorkflow';
import { buildPdcReport } from './pdcReports';

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
  const cheques = p.cheque ? [...d.cheques.filter((c) => c.id !== p.cheque!.id), p.cheque] : d.cheques;
  return {
    ...d, cheques,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines],
    movements: [...d.movements, ...(p.movements ?? [])],
  };
}

/** Reverse an entry exactly as the store does. */
function reverse(d: PdcDataSet, txnId: string, on = '2026-08-20'): PdcDataSet {
  const rev = buildReversal(d, txnId, on);
  if ('error' in rev) throw new Error(rev.error);
  const next = apply(d, { ...rev, movements: [] } as unknown as Posting);
  return {
    ...next,
    transactions: next.transactions.map((t) =>
      t.id === txnId ? { ...t, reversed: true, reversedByTxnId: rev.txn.id } : t
    ),
  };
}

/** Total money the business holds, from the ledger itself. */
const funds = (d: PdcDataSet) =>
  cashBalance(d) + [...bankBalances(d).values()].reduce((s, v) => s + v, 0);

describe("the register's running balance", () => {
  it('ends on the real cash + bank total', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 20_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 30_000, date: '2026-08-03', paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));

    const reg = buildRegister(d);          // newest first
    expect(reg[0].running).toBe(funds(d));
  });

  it('still ends on the real total AFTER a reversal', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash' }));
    const id = d.transactions[0].id;
    d = reverse(d, id);

    // The ledger says the cash came and went: nothing left.
    expect(funds(d)).toBe(0);
    // The column the user reads must say the same.
    expect(buildRegister(d)[0].running).toBe(funds(d));
  });
});

describe('profit and the summary after a reversal', () => {
  it('a reversed sale is not counted as revenue', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash' }));
    d = reverse(d, d.transactions[0].id);
    expect(computeProfit(d).sales).toBe(0);
  });

  it('a reversed receipt leaves the party owing again', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 50_000, date: '2026-08-02', paymentMethod: 'cash' }));
    expect(accountBalance(d, partyAcc('A'))).toBe(0);

    d = reverse(d, d.transactions[1].id);
    expect(accountBalance(d, partyAcc('A'))).toBe(50_000);
    expect(cashBalance(d)).toBe(0);
  });

  it('the summary total funds equals the ledger', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 70_000, date: '2026-08-01', settlement: 'cash' }));
    d = apply(d, buildExpense(d, { amount: 5_000, date: '2026-08-02', category: 'Fuel' }));
    d = reverse(d, d.transactions[0].id);
    expect(computeSummary(d, '2026-08-25').totalFunds).toBe(funds(d));
  });
});

describe('the cash account after a reversal', () => {
  it('its balance still equals the engine, and in − out still equals it', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 40_000, date: '2026-08-01', paymentMethod: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 15_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = reverse(d, d.transactions[0].id);

    const c = buildCashLedger(d);
    expect(c.balance).toBe(cashBalance(d));
    expect(c.totalIn - c.totalOut).toBe(c.balance);
    // The reversal is a real movement, so it is listed, not hidden.
    expect(c.rows.length).toBe(3);
  });
});

describe('the party statement after a reversal', () => {
  it('its closing balance equals the party account', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = reverse(d, d.transactions[0].id);

    const led = buildPartyLedger(d, 'A');
    expect(led.balance).toBe(accountBalance(d, partyAcc('A')));
    expect(led.balance).toBe(0);
  });
});

describe('the whole book stays internally consistent', () => {
  it('every posting balances through a long mixed month', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit', quantity: 100, rate: 1_000 }));
    d = apply(d, buildPurchase(d, { partyId: 'B', amount: 60_000, date: '2026-08-02', settlement: 'credit', quantity: 300, rate: 200 }));
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 40_000, date: '2026-08-03', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-04',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    d = apply(d, buildCashPaid(d, { partyId: 'B', amount: 60_000, date: '2026-08-05', paymentMethod: 'bank', bankAccountId: 'ACC1' }));
    d = apply(d, buildExpense(d, { amount: 5_000, date: '2026-08-06', category: 'Rent' }));
    d = reverse(d, d.transactions[5].id);   // the expense was wrong

    expect(ledgerIsBalanced(d)).toBe(true);
    // Every view agrees with the ledger it summarises.
    expect(buildRegister(d)[0].running).toBe(funds(d));
    expect(buildCashLedger(d).balance).toBe(cashBalance(d));
    expect(buildPartyLedger(d, 'A').balance).toBe(accountBalance(d, partyAcc('A')));
    expect(buildPartyLedger(d, 'B').balance).toBe(accountBalance(d, partyAcc('B')));
    expect(computeSummary(d, '2026-08-25').totalFunds).toBe(funds(d));
    expect(computeProfit(d).expenses).toBe(0);   // reversed away
  });
});

/**
 * The totals row and the Total Quantity card skip a REVERSED entry. They must
 * skip its reversal too, or a cancelled entry still contributes its amount and
 * quantity to the figures on screen.
 */
describe('the on-screen totals after a reversal', () => {
  // The REAL function the Cash Book calls — re-implementing it here would
  // prove nothing about the code that actually ships.
  const screenTotals = (d: PdcDataSet) => rowTotals(buildRegister(d));

  it('a cancelled sale contributes nothing to amount or quantity', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit',
      quantity: 100, rate: 1_000,
    }));
    d = reverse(d, d.transactions[0].id);

    const t = screenTotals(d);
    expect(t.amount).toBe(0);
    expect(t.qty).toBe(0);
  });

  it('only the surviving entries are totalled', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit', quantity: 100, rate: 1_000,
    }));
    d = apply(d, buildSale(d, {
      partyId: 'B', amount: 40_000, date: '2026-08-02', settlement: 'credit', quantity: 40, rate: 1_000,
    }));
    d = reverse(d, d.transactions[0].id);   // cancel the first

    const t = screenTotals(d);
    expect(t.amount).toBe(40_000);
    expect(t.qty).toBe(40);
  });
});

/**
 * Reports must not count business that was cancelled. These read the rendered
 * PDF's text, so they test what is actually printed rather than an internal
 * figure that might never reach the page.
 */
describe('reports exclude cancelled entries', () => {
  const textOf = (doc: { output: (k: string) => unknown }) => {
    // jsPDF keeps the drawn strings in the document stream.
    const raw = String(doc.output('datauristring'));
    return Buffer.from(raw.split(',')[1] ?? '', 'base64').toString('latin1');
  };

  it('a reversed sale is not in the Sales report', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 123_456, date: '2026-08-01', settlement: 'credit',
      description: 'CANCELLED ORDER',
    }));
    d = apply(d, buildSale(d, {
      partyId: 'B', amount: 40_000, date: '2026-08-02', settlement: 'credit',
      description: 'REAL ORDER',
    }));
    d = reverse(d, d.transactions[0].id);

    const txt = textOf(buildPdcReport(d, 'sales'));
    expect(txt).toContain('REAL ORDER');
    expect(txt).not.toContain('CANCELLED ORDER');
    // Its figure is gone from the totals too.
    expect(txt).not.toContain('123,456');
  });

  it('a reversed expense is not in the Expense report', () => {
    let d = seed();
    d = apply(d, buildExpense(d, { amount: 77_777, date: '2026-08-01', category: 'WRONGCAT' }));
    d = apply(d, buildExpense(d, { amount: 5_000, date: '2026-08-02', category: 'Rent' }));
    d = reverse(d, d.transactions[0].id);

    const txt = textOf(buildPdcReport(d, 'expenses'));
    expect(txt).toContain('Rent');
    expect(txt).not.toContain('WRONGCAT');
    expect(txt).not.toContain('77,777');
  });

  it('the Trial Balance still balances after a reversal', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 90_000, date: '2026-08-01', settlement: 'cash' }));
    d = reverse(d, d.transactions[0].id);
    // Rendering asserts nothing threw; the balance check is the engine's.
    expect(() => buildPdcReport(d, 'trial-balance')).not.toThrow();
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
