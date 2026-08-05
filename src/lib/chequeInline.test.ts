/**
 * A cheque entered on Sale / Purchase / Receive / Pay must create the cheque
 * record in the SAME posting — no second trip to a Cheques screen — and must
 * NOT be treated as cleared.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, bankBalances, cashBalance, computeProfit, ledgerIsBalanced,
  partyAcc, buildSale, buildPurchase, buildCashReceived, buildCashPaid,
  computeSummary, type Posting,
} from './pdcEngine';
import { buildChequeDeposit, buildChequeClear } from './chequeWorkflow';

function seed(): PdcDataSet {
  return {
    parties: [{ id: 'A', name: 'Ahmed', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    ledgers: [], banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{ id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    cheques: [], transactions: [], ledger: [], movements: [], allocations: [], audit: [],
    settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: 1 },
  };
}
function apply(d: PdcDataSet, p: Posting | { error: string }): PdcDataSet {
  if ('error' in p) throw new Error(p.error);
  const cheques = p.cheque ? [...d.cheques.filter((c) => c.id !== p.cheque!.id), p.cheque] : d.cheques;
  return { ...d, cheques,
    transactions: [...d.transactions, p.txn],
    ledger: [...d.ledger, ...p.lines],
    movements: [...d.movements, ...p.movements] };
}
const CQ = { chequeNumber: '100234', chequeDate: '2026-09-01', bankId: 'HBL' };
const D = '2026-08-01';

describe('cheque recorded from the Sale screen', () => {
  it('creates the cheque automatically, pending and not cleared', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 125000, date: D, settlement: 'cash',
      paymentMethod: 'cheque', cheque: CQ, itemName: 'Sugar',
    }));

    expect(d.cheques).toHaveLength(1);                 // no second entry needed
    expect(d.cheques[0].chequeNumber).toBe('100234');
    expect(d.cheques[0].status).toBe('pending');       // NOT cleared
    expect(d.cheques[0].direction).toBe('received');
    expect(d.movements).toHaveLength(1);               // history started
    // Revenue counted, but no cash or bank moved yet.
    expect(computeProfit(d).sales).toBe(125000);
    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('shows up in the outstanding-cheque total straight away', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 125000, date: D, settlement: 'cash',
      paymentMethod: 'cheque', cheque: CQ,
    }));
    const s = computeSummary(d, '2026-08-02');
    expect(s.pendingReceivedCheques).toBe(125000);
    expect(s.totalCheques).toBe(125000);
  });

  it('clears later through the normal workflow, moving real money then', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 125000, date: D, settlement: 'cash',
      paymentMethod: 'cheque', cheque: CQ,
    }));
    const id = d.cheques[0].id;
    d = apply(d, buildChequeDeposit(d, { chequeId: id, bankAccountId: 'ACC1', date: '2026-09-01' }));
    d = apply(d, buildChequeClear(d, { chequeId: id, date: '2026-09-02' }));

    expect(d.cheques[0].status).toBe('cleared');
    expect(bankBalances(d).get('ACC1')).toBe(125000);   // money arrives NOW
    // Revenue still counted once, not twice.
    expect(computeProfit(d).sales).toBe(125000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('cheque recorded from Receive', () => {
  it('settles the party and creates the cheque in one step', () => {
    let d = seed();
    d.parties = [{ ...d.parties[0], openingBalance: 90000 }];   // Ahmed owes us
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 90000, date: D, paymentMethod: 'cheque', cheque: CQ,
    }));

    expect(d.cheques).toHaveLength(1);
    expect(d.cheques[0].status).toBe('pending');
    expect(accountBalance(d, partyAcc('A'))).toBe(0);   // debt settled
    expect(cashBalance(d)).toBe(0);                     // but no cash yet
    expect(d.transactions[0].paymentMethod).toBe('cheque');
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('a CASH receipt still moves cash, unchanged', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 5000, date: D }));
    expect(cashBalance(d)).toBe(5000);
    expect(d.cheques).toHaveLength(0);
  });
});

describe('cheque recorded from Pay and Purchase', () => {
  it('Pay by cheque reduces the payable and carries the cheque outstanding', () => {
    let d = seed();
    d.parties = [{ ...d.parties[0], openingBalance: -40000 }];  // we owe Ahmed
    d = apply(d, buildCashPaid(d, {
      partyId: 'A', amount: 40000, date: D, paymentMethod: 'cheque',
      cheque: { ...CQ, chequeNumber: '5001' },
    }));
    expect(d.cheques[0].direction).toBe('issued');
    expect(d.cheques[0].holder).toEqual({ kind: 'party', partyId: 'A' });
    expect(accountBalance(d, partyAcc('A'))).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);        // not paid out yet
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('Purchase by cheque records cost and an outstanding cheque', () => {
    let d = seed();
    d = apply(d, buildPurchase(d, {
      partyId: 'A', amount: 60000, date: D, settlement: 'cash',
      paymentMethod: 'cheque', cheque: { ...CQ, chequeNumber: '5002' },
    }));
    expect(computeProfit(d).purchases).toBe(60000);
    expect(d.cheques[0].direction).toBe('issued');
    expect(d.cheques[0].status).toBe('pending');
    expect(cashBalance(d)).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
