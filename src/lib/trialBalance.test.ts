/**
 * Trial Balance, and a bank account carrying its money through to its ledger.
 *
 * The trial balance is the proof that the whole system is internally
 * consistent: every account replayed from the ledger, each in its natural
 * column, with the two totals agreeing. If these tests pass, no posting in the
 * system is lopsided.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid, buildExpense,
  ledgerIsBalanced, accountBalance, partyAcc, cashBalance, bankBalances,
  buildCreditAdjustment, trialBalanceRows,
  type Posting,
} from './pdcEngine';
import { buildBankLedger } from './pdcRegister';
import { buildChequeDeposit, buildChequeClear } from './chequeWorkflow';
import { round2 } from './utils';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'CUST', name: 'Ahmed Traders', openingBalance: 50_000, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'SUPP', name: 'Karachi Mills', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [],
    banks: [{ id: 'HABIB', name: 'Bank AL Habib', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{
      id: 'ACC1', bankId: 'HABIB', title: 'Main Account',
      openingBalance: 200_000, active: true, createdAt: 1, updatedAt: 1,
    }],
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

/** The Trial Balance report's own rows, totalled. */
function trialBalance(d: PdcDataSet): { debit: number; credit: number; rows: number } {
  const rows = trialBalanceRows(d);
  return {
    debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
    credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
    rows: rows.length,
  };
}

describe('trial balance', () => {
  it('balances on an empty book', () => {
    const tb = trialBalance(seed());
    // Only the two opening balances exist, and they offset each other.
    expect(tb.debit).toBe(tb.credit);
  });

  it('balances after trading across every module', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 300_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPurchase(d, { partyId: 'SUPP', amount: 120_000, date: '2026-08-02', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'CUST', amount: 80_000, date: '2026-08-03', paymentMethod: 'cash' }));
    d = apply(d, buildCashPaid(d, { partyId: 'SUPP', amount: 50_000, date: '2026-08-04', paymentMethod: 'cash' }));
    d = apply(d, buildExpense(d, { amount: 15_000, date: '2026-08-05', category: 'Rent' }));

    const tb = trialBalance(d);
    expect(tb.debit).toBe(tb.credit);
    expect(tb.rows).toBeGreaterThan(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('still balances with cheques outstanding', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 300_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 300_000, date: '2026-08-06',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    expect(trialBalance(d).debit).toBe(trialBalance(d).credit);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('still balances after that cheque clears into the bank', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 300_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 300_000, date: '2026-08-06',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    const id = d.cheques[0].id;
    d = apply(d, buildChequeDeposit(d, { chequeId: id, bankAccountId: 'ACC1', date: '2026-09-01' }));
    d = apply(d, buildChequeClear(d, { chequeId: id, date: '2026-09-02' }));

    const tb = trialBalance(d);
    expect(tb.debit).toBe(tb.credit);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('lists an adjustment, so it does not tip the totals', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCreditAdjustment(d, { partyId: 'CUST', amount: 350_000, date: '2026-08-02' }));
    const rows = trialBalanceRows(d);
    expect(rows.find((r) => r.name === 'Adjustments')?.debit).toBe(350_000);
    const tb = trialBalance(d);
    expect(tb.debit).toBe(tb.credit);
  });

  it('counts a cheque by what the books hold, not by the label on it', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 300_000, date: '2026-08-06',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    // A cheque record that never had an entry behind it (left over from a
    // deleted receipt): its status says pending, but the books hold nothing.
    d = { ...d, cheques: [...d.cheques, { ...d.cheques[0], id: 'GHOST', chequeNumber: 'C2' }] };
    const rows = trialBalanceRows(d);
    expect(rows.find((r) => r.name.startsWith('Cheques in Hand'))?.debit).toBe(300_000);
    const tb = trialBalance(d);
    expect(tb.debit).toBe(tb.credit);
  });
});

describe('a bank account records its money and shows it on the ledger page', () => {
  it('opens with its opening balance already on the ledger', () => {
    const d = seed();
    // Bank AL Habib — Main Account was created with 200,000 on it.
    expect(bankBalances(d).get('ACC1')).toBe(200_000);
    expect(buildBankLedger(d, 'ACC1').balance).toBe(200_000);
  });

  it('carries every movement through to its own ledger', () => {
    let d = seed();
    // Money received straight into the bank.
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 75_000, date: '2026-08-03',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    // Money paid out of the bank.
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 25_000, date: '2026-08-04',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));

    // 200,000 + 75,000 − 25,000
    expect(bankBalances(d).get('ACC1')).toBe(250_000);

    const led = buildBankLedger(d, 'ACC1');
    expect(led.balance).toBe(250_000);
    expect(led.rows).toHaveLength(2);                 // both movements listed
    // The ledger page's own figure agrees with the engine's — one source.
    expect(led.balance).toBe(bankBalances(d).get('ACC1'));

    // Oldest-first, the running balance builds: 275,000 then 250,000.
    const chrono = [...led.rows].reverse();
    expect(chrono.map((r) => r.running)).toEqual([275_000, 250_000]);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('a cheque banked into it lands on the bank ledger only when it clears', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 90_000, date: '2026-08-02',
      paymentMethod: 'cheque', cheque: { chequeNumber: 'C9', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));

    // Pending: the bank has not moved.
    expect(bankBalances(d).get('ACC1')).toBe(200_000);
    expect(buildBankLedger(d, 'ACC1').rows).toHaveLength(0);

    const id = d.cheques[0].id;
    d = apply(d, buildChequeDeposit(d, { chequeId: id, bankAccountId: 'ACC1', date: '2026-09-01' }));
    d = apply(d, buildChequeClear(d, { chequeId: id, date: '2026-09-02' }));

    // Cleared: now it is real money in Bank AL Habib.
    expect(bankBalances(d).get('ACC1')).toBe(290_000);
    expect(buildBankLedger(d, 'ACC1').balance).toBe(290_000);
    expect(accountBalance(d, partyAcc('CUST'))).toBe(50_000); // back to opening
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
