/**
 * Turning a cheque into Cash in Hand.
 *
 * A cheque reaches its due date and the party hands over cash for it. The value
 * has to move out of cheque custody and into cash, without touching any bank
 * account and without disturbing the party — they were settled when the cheque
 * was received, and only WHERE the value sits is changing.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildCashReceived, buildCashPaid,
  ledgerIsBalanced, accountBalance, partyAcc, cashBalance, bankBalances,
  computeSummary, type Posting,
} from './pdcEngine';
import { buildChequeToCash, buildChequeDeposit, buildChequeTransfer } from './chequeWorkflow';
import { buildCashLedger } from './pdcRegister';

const DUE = '2026-09-01';

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

/** A 200,000 sale settled by a cheque that is still in our hands. */
function withCheque(): PdcDataSet {
  let d = seed();
  d = apply(d, buildSale(d, { partyId: 'A', amount: 200_000, date: '2026-08-01', settlement: 'credit' }));
  d = apply(d, buildCashReceived(d, {
    partyId: 'A', amount: 200_000, date: '2026-08-02',
    paymentMethod: 'cheque',
    cheque: { chequeNumber: 'CH-500', bankId: 'HABIB', chequeDate: DUE },
  }));
  return d;
}

const bal = (d: PdcDataSet, id: string) => accountBalance(d, partyAcc(id));

describe('cheque to cash in hand', () => {
  it('moves the value out of cheques and into cash', () => {
    let d = withCheque();
    // Before: nothing in cash, the whole amount outstanding as a cheque.
    expect(cashBalance(d)).toBe(0);
    expect(computeSummary(d, DUE).totalCheques).toBe(200_000);

    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE }));

    // After: cash holds it, and it is no longer an outstanding cheque.
    expect(cashBalance(d)).toBe(200_000);
    expect(computeSummary(d, DUE).totalCheques).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('never touches a bank account', () => {
    let d = withCheque();
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE }));
    expect(bankBalances(d).get('ACC1')).toBe(0);
    // No bank account is recorded on the entry either.
    const txn = d.transactions[d.transactions.length - 1];
    expect(txn.toBankAccountId).toBeUndefined();
    expect(txn.fromBankAccountId).toBeUndefined();
  });

  it('leaves the party settled — it does not re-open their balance', () => {
    let d = withCheque();
    expect(bal(d, 'A')).toBe(0);              // settled when the cheque arrived
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE }));
    expect(bal(d, 'A')).toBe(0);              // still settled, not owing again
  });

  it('keeps the cheque, its number and its history intact', () => {
    let d = withCheque();
    const id = d.cheques[0].id;
    const before = d.movements.length;

    d = apply(d, buildChequeToCash(d, { chequeId: id, date: DUE }));

    // One cheque still — same record, not a copy.
    expect(d.cheques).toHaveLength(1);
    expect(d.cheques[0].id).toBe(id);
    expect(d.cheques[0].chequeNumber).toBe('CH-500');
    expect(d.cheques[0].status).toBe('cleared');
    // Held by the business as cash, not sitting in a bank.
    expect(d.cheques[0].holder.kind).toBe('business');
    expect(d.cheques[0].bankAccountId).toBeUndefined();
    // The hand-over is written into its timeline.
    expect(d.movements.length).toBe(before + 1);
    expect(d.movements[d.movements.length - 1].action).toBe('Received as cash');
  });

  it('records the entry against the cheque, so the reference survives', () => {
    let d = withCheque();
    const id = d.cheques[0].id;
    d = apply(d, buildChequeToCash(d, { chequeId: id, date: DUE }));
    const txn = d.transactions[d.transactions.length - 1];
    expect(txn.chequeId).toBe(id);
    expect(txn.partyId).toBe('A');
    expect(txn.reference).toBeTruthy();
  });

  it('shows up in the Cash Account with a running balance', () => {
    let d = withCheque();
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE }));

    const c = buildCashLedger(d);
    expect(c.rows).toHaveLength(1);
    expect(c.totalIn).toBe(200_000);
    expect(c.totalOut).toBe(0);
    expect(c.balance).toBe(200_000);
    expect(c.balance).toBe(cashBalance(d));
  });

  it('the cash can then be spent like any other cash', () => {
    let d = withCheque();
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'B', amount: 50_000, date: '2026-09-02', paymentMethod: 'cash',
    }));
    expect(cashBalance(d)).toBe(150_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('what cheque-to-cash refuses', () => {
  it('refuses a cheque we issued — that is money we owe', () => {
    let d = seed();
    d = apply(d, buildCashPaid(d, {
      partyId: 'B', amount: 40_000, date: '2026-08-02',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'OUT-1', bankId: 'HABIB', chequeDate: DUE },
    }));
    const res = buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE });
    expect('error' in res).toBe(true);
  });

  it('refuses a cheque endorsed away to someone else', () => {
    let d = withCheque();
    d = apply(d, buildChequeTransfer(d, {
      chequeId: d.cheques[0].id, toPartyId: 'B', amount: 200_000, date: '2026-08-05',
    }));
    const res = buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE });
    expect('error' in res).toBe(true);
  });

  it('refuses the same cheque twice', () => {
    let d = withCheque();
    const id = d.cheques[0].id;
    d = apply(d, buildChequeToCash(d, { chequeId: id, date: DUE }));
    const again = buildChequeToCash(d, { chequeId: id, date: DUE });
    expect('error' in again).toBe(true);
    // The first conversion stands; cash is not doubled.
    expect(cashBalance(d)).toBe(200_000);
  });

  it('refuses an unknown cheque', () => {
    const res = buildChequeToCash(seed(), { chequeId: 'nope', date: DUE });
    expect('error' in res).toBe(true);
  });

  it('works on a cheque already deposited but not yet cleared', () => {
    // Deposited, then the bank returns it and the party pays cash instead.
    let d = withCheque();
    d = apply(d, buildChequeDeposit(d, {
      chequeId: d.cheques[0].id, bankAccountId: 'ACC1', date: '2026-08-28',
    }));
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: DUE }));

    expect(cashBalance(d)).toBe(200_000);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
