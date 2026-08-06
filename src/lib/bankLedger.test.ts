/**
 * Bank ledgers, bank statements, deleting banks, and parent / sub-ledgers.
 *
 * Covers the promise that selecting a bank on any entry gives that bank its own
 * ledger, that the ledger carries deposits, withdrawals and cheques with a
 * running balance, and that deleting a bank removes everything it touched.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid,
  ledgerIsBalanced, bankBalances, buildLedgerView, accountBalance, partyAcc,
  bankAccountDeleteImpact, bankAccountDeleteTxnIds, bankDeleteImpact,
  type Posting,
} from './pdcEngine';
import { buildBankLedger } from './pdcRegister';
import { buildChequeDeposit, buildChequeClear } from './chequeWorkflow';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'CUST', name: 'Ahmed Traders', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'SUPP', name: 'Karachi Mills', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [],
    banks: [{ id: 'HABIB', name: 'Habib Bank', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{
      id: 'ACC1', bankId: 'HABIB', title: 'Main Account',
      openingBalance: 100_000, active: true, createdAt: 1, updatedAt: 1,
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

// --- The bank ledger records everything -----------------------------------

describe('a bank ledger records every kind of movement', () => {
  it('starts from its opening balance', () => {
    const d = seed();
    expect(bankBalances(d).get('ACC1')).toBe(100_000);
    expect(buildBankLedger(d, 'ACC1').balance).toBe(100_000);
  });

  it('records money received into the bank on a Receive', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    expect(bankBalances(d).get('ACC1')).toBe(160_000);
    expect(buildBankLedger(d, 'ACC1').rows).toHaveLength(1);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('records money paid out of the bank on a Pay', () => {
    let d = seed();
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 25_000, date: '2026-08-03',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    expect(bankBalances(d).get('ACC1')).toBe(75_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('keeps deposits, withdrawals and a running balance in order', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 25_000, date: '2026-08-03',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 15_000, date: '2026-08-04',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));

    const led = buildBankLedger(d, 'ACC1');
    const chrono = [...led.rows].reverse();
    // 100,000 → +60,000 → −25,000 → +15,000
    expect(chrono.map((r) => r.running)).toEqual([160_000, 135_000, 150_000]);
    expect(led.balance).toBe(150_000);
    // A deposit is a debit on the account; a withdrawal is a credit.
    expect(chrono[0].entry.debit).toBe(60_000);
    expect(chrono[1].entry.credit).toBe(25_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('shows a cheque only once it clears, and names the cheque on the line', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'CUST', amount: 80_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 80_000, date: '2026-08-02',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-77', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));

    // Pending — the bank has not moved.
    expect(buildBankLedger(d, 'ACC1').rows).toHaveLength(0);
    expect(bankBalances(d).get('ACC1')).toBe(100_000);

    const id = d.cheques[0].id;
    d = apply(d, buildChequeDeposit(d, { chequeId: id, bankAccountId: 'ACC1', date: '2026-09-01' }));
    d = apply(d, buildChequeClear(d, { chequeId: id, date: '2026-09-02' }));

    const led = buildBankLedger(d, 'ACC1');
    expect(led.balance).toBe(180_000);
    // The cheque is attached to its ledger line, so the statement can print it.
    expect(led.rows.some((r) => r.cheque?.chequeNumber === 'CH-77')).toBe(true);
    expect(accountBalance(d, partyAcc('CUST'))).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

// --- Deleting a bank account ----------------------------------------------

describe('deleting a bank account', () => {
  it('reports exactly what would go with it', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'SUPP', amount: 25_000, date: '2026-08-03',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));

    const impact = bankAccountDeleteImpact(d, 'ACC1');
    expect(impact.transactions).toBe(2);
    expect(impact.clean).toBe(false);
    expect(bankAccountDeleteTxnIds(d, 'ACC1')).toHaveLength(2);
  });

  it('an untouched account is clean', () => {
    expect(bankAccountDeleteImpact(seed(), 'ACC1').clean).toBe(true);
  });

  it('counts a cheque deposited into the account', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 80_000, date: '2026-08-02',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-77', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    const id = d.cheques[0].id;
    d = apply(d, buildChequeDeposit(d, { chequeId: id, bankAccountId: 'ACC1', date: '2026-09-01' }));

    expect(bankAccountDeleteImpact(d, 'ACC1').cheques).toBe(1);
  });

  it('deleting the whole bank covers its accounts and its cheques', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'CUST', amount: 80_000, date: '2026-08-03',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-77', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));

    const impact = bankDeleteImpact(d, 'HABIB');
    // Both the bank transfer and the cheque receipt belong to this bank.
    expect(impact.transactions).toBe(2);
    expect(impact.cheques).toBe(1);
    expect(impact.clean).toBe(false);
  });
});

// --- Parent and sub-ledgers -----------------------------------------------

describe('parent and sub-ledgers', () => {
  /** Yameen as the parent, with Jeeb and Kamran beneath him. */
  function nested(): PdcDataSet {
    const d = seed();
    return {
      ...d,
      ledgers: [
        { id: 'YAMEEN', name: 'Yameen', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
        { id: 'JEEB', name: 'Jeeb', parentId: 'YAMEEN', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
        { id: 'KAMRAN', name: 'Kamran', parentId: 'YAMEEN', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      ],
      parties: [
        { id: 'P1', name: 'Customer One', openingBalance: 30_000, ledgerIds: ['JEEB'], active: true, createdAt: 1, updatedAt: 1 },
        { id: 'P2', name: 'Customer Two', openingBalance: 20_000, ledgerIds: ['KAMRAN'], active: true, createdAt: 1, updatedAt: 1 },
        { id: 'P3', name: 'Customer Three', openingBalance: 50_000, ledgerIds: ['YAMEEN'], active: true, createdAt: 1, updatedAt: 1 },
      ],
    };
  }

  it('lists its sub-ledgers', () => {
    const v = buildLedgerView(nested(), 'YAMEEN')!;
    expect(v.subLedgers.map((s) => s.ledger.name)).toEqual(['Jeeb', 'Kamran']);
  });

  it('rolls a sub-ledger total up into its parent', () => {
    const v = buildLedgerView(nested(), 'YAMEEN')!;
    expect(v.partiesTotal).toBe(50_000);      // Yameen's own party
    expect(v.subLedgersTotal).toBe(50_000);   // Jeeb 30,000 + Kamran 20,000
    expect(v.total).toBe(100_000);            // everything beneath him
  });

  it('a sub-ledger reports only its own book', () => {
    const jeeb = buildLedgerView(nested(), 'JEEB')!;
    expect(jeeb.total).toBe(30_000);
    expect(jeeb.subLedgers).toHaveLength(0);
    expect(jeeb.ledger.parentId).toBe('YAMEEN');
  });

  it("a parent's receivable includes what sits under its sub-ledgers", () => {
    const v = buildLedgerView(nested(), 'YAMEEN')!;
    expect(v.receivable).toBe(100_000);
    expect(v.payable).toBe(0);
  });

  it('keeps working when a sub-ledger owes money', () => {
    const d = nested();
    d.parties = d.parties.map((p) =>
      p.id === 'P2' ? { ...p, openingBalance: -20_000 } : p
    );
    const v = buildLedgerView(d, 'YAMEEN')!;
    expect(v.subLedgersTotal).toBe(10_000);   // 30,000 − 20,000
    expect(v.total).toBe(60_000);
    expect(v.receivable).toBe(80_000);        // Yameen 50,000 + Jeeb 30,000
    expect(v.payable).toBe(20_000);           // Kamran
  });

  it('a top-level ledger with no children still totals correctly', () => {
    const d = seed();
    const flat: PdcDataSet = {
      ...d,
      ledgers: [{ id: 'SOLO', name: 'Solo', openingBalance: 5_000, active: true, createdAt: 1, updatedAt: 1 }],
      parties: [{ id: 'P9', name: 'Nine', openingBalance: 15_000, ledgerIds: ['SOLO'], active: true, createdAt: 1, updatedAt: 1 }],
    };
    const v = buildLedgerView(flat, 'SOLO')!;
    expect(v.subLedgers).toHaveLength(0);
    expect(v.subLedgersTotal).toBe(0);
    expect(v.total).toBe(20_000);
  });
});
