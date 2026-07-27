/**
 * Accounting-integrity tests for the PDC engine (spec §31).
 *
 * These lock down the rules that must never regress: balanced postings, one
 * cheque record per physical cheque, correct receivable/payable direction, and
 * reversals that truly net to zero.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet, Cheque, PdcLedgerEntry, PdcTransaction } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance,
  bankBalances,
  buildBankTransfer,
  buildCashPaid,
  buildCashReceived,
  buildCreditAdjustment,
  buildDebitAdjustment,
  buildPartyTransfer,
  buildPdcIssued,
  buildPdcReceived,
  buildSale,
  buildPurchase,
  buildExpense,
  buildIncome,
  computeProfit,
  totalFunds,
  cashBalance,
  computeSummary,
  ledgerIsBalanced,
  nextReference,
  partyAcc,
  partyBalances,
  type Posting,
} from './pdcEngine';
import {
  buildChequeBounce,
  buildChequeClear,
  buildChequeDeposit,
  buildChequeTransfer,
  buildReversal,
  isDuplicateCheque,
  linkReplacement,
  validateStatusChange,
} from './chequeWorkflow';

// --- helpers ----------------------------------------------------------------

function emptyData(overrides: Partial<PdcDataSet> = {}): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed Traders', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Ali Enterprises', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'C', name: 'Nawaz Brothers', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [
      { id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'ACC2', bankId: 'HBL', title: 'Second', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    cheques: [],
    transactions: [],
    ledger: [],
    movements: [],
    allocations: [],
    audit: [],
    settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: 1 },
    ...overrides,
  };
}

/** Apply a posting to a dataset, as the store would. */
function apply(data: PdcDataSet, p: Posting | { error: string }): PdcDataSet {
  if ('error' in p) throw new Error(`Unexpected error: ${p.error}`);
  const cheques = p.cheque
    ? [...data.cheques.filter((c) => c.id !== p.cheque!.id), p.cheque]
    : data.cheques;
  return {
    ...data,
    cheques,
    transactions: [...data.transactions, p.txn],
    ledger: [...data.ledger, ...p.lines],
    movements: [...data.movements, ...p.movements],
  };
}

const D = '2026-07-01';

// --- balanced postings ------------------------------------------------------

describe('every posting is balanced', () => {
  it('PDC received balances and reduces the party receivable', () => {
    let data = emptyData();
    const p = buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    });
    data = apply(data, p);
    expect(ledgerIsBalanced(data)).toBe(true);
    // Receiving a cheque settles what they owed: their balance goes negative.
    expect(accountBalance(data, partyAcc('A'))).toBe(-100000);
    expect(data.cheques).toHaveLength(1);
    expect(data.cheques[0].status).toBe('pending');
  });

  it('PDC issued balances and reduces what we owe the party', () => {
    let data = emptyData();
    data = apply(data, buildPdcIssued(data, {
      partyId: 'B', bankAccountId: 'ACC1', chequeNumber: '5001',
      chequeDate: '2026-08-01', amount: 40000, date: D,
    }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(accountBalance(data, partyAcc('B'))).toBe(40000);
    // Bank is untouched until the cheque clears.
    expect(bankBalances(data).get('ACC1')).toBe(0);
  });

  it('cash received debits cash and credits the party', () => {
    let data = emptyData();
    data = apply(data, buildCashReceived(data, { partyId: 'A', amount: 5000, date: D }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(cashBalance(data)).toBe(5000);
    expect(accountBalance(data, partyAcc('A'))).toBe(-5000);
  });

  it('cash paid credits cash and debits the party', () => {
    let data = emptyData();
    data = apply(data, buildCashPaid(data, { partyId: 'A', amount: 3000, date: D }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(cashBalance(data)).toBe(-3000);
    expect(accountBalance(data, partyAcc('A'))).toBe(3000);
  });

  it('debit and credit adjustments move the party balance in opposite directions', () => {
    let data = emptyData();
    data = apply(data, buildDebitAdjustment(data, { partyId: 'A', amount: 1000, date: D }));
    expect(accountBalance(data, partyAcc('A'))).toBe(1000);
    data = apply(data, buildCreditAdjustment(data, { partyId: 'A', amount: 400, date: D }));
    expect(accountBalance(data, partyAcc('A'))).toBe(600);
    expect(ledgerIsBalanced(data)).toBe(true);
  });
});

// --- everyday trading, expenses & profit -----------------------------------

describe('sale / purchase / expense / income', () => {
  it('a CASH sale increases cash and does not touch the party balance', () => {
    let data = emptyData();
    data = apply(data, buildSale(data, { partyId: 'A', amount: 10000, date: D, settlement: 'cash' }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(cashBalance(data)).toBe(10000);
    expect(accountBalance(data, partyAcc('A'))).toBe(0);
    expect(computeProfit(data).sales).toBe(10000);
  });

  it('a CREDIT sale makes the party owe us and does NOT move cash', () => {
    let data = emptyData();
    data = apply(data, buildSale(data, { partyId: 'A', amount: 10000, date: D, settlement: 'credit' }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(cashBalance(data)).toBe(0);           // no money moved yet
    expect(accountBalance(data, partyAcc('A'))).toBe(10000); // receivable
    expect(computeProfit(data).sales).toBe(10000);           // revenue still counted
  });

  it('a CASH purchase reduces cash; a CREDIT purchase creates a payable', () => {
    let cash = emptyData();
    cash = apply(cash, buildPurchase(cash, { partyId: 'A', amount: 4000, date: D, settlement: 'cash' }));
    expect(cashBalance(cash)).toBe(-4000);
    expect(accountBalance(cash, partyAcc('A'))).toBe(0);

    let credit = emptyData();
    credit = apply(credit, buildPurchase(credit, { partyId: 'A', amount: 4000, date: D, settlement: 'credit' }));
    expect(cashBalance(credit)).toBe(0);
    expect(accountBalance(credit, partyAcc('A'))).toBe(-4000); // payable
    expect(ledgerIsBalanced(credit)).toBe(true);
  });

  it('expenses reduce cash and profit; income increases both', () => {
    let data = emptyData();
    data = apply(data, buildExpense(data, { amount: 1500, date: D, category: 'Rent' }));
    data = apply(data, buildIncome(data, { amount: 500, date: D, category: 'Commission' }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(cashBalance(data)).toBe(-1000); // −1500 + 500
    const pl = computeProfit(data);
    expect(pl.expenses).toBe(1500);
    expect(pl.otherIncome).toBe(500);
    expect(pl.netProfit).toBe(-1000);
  });

  it('net profit = (sales + income) − (purchases + expenses)', () => {
    let data = emptyData();
    data = apply(data, buildSale(data, { partyId: 'A', amount: 50000, date: D, settlement: 'credit' }));
    data = apply(data, buildPurchase(data, { partyId: 'B', amount: 30000, date: D, settlement: 'credit' }));
    data = apply(data, buildExpense(data, { amount: 5000, date: D, category: 'Salary' }));
    data = apply(data, buildIncome(data, { amount: 2000, date: D, category: 'Rebate' }));

    const pl = computeProfit(data);
    expect(pl.netProfit).toBe(50000 + 2000 - 30000 - 5000); // 17,000
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('profit is NOT affected by collecting a receivable (no double-counting)', () => {
    let data = emptyData();
    data = apply(data, buildSale(data, { partyId: 'A', amount: 10000, date: D, settlement: 'credit' }));
    const before = computeProfit(data).netProfit;
    // Party later pays the invoice in cash.
    data = apply(data, buildCashReceived(data, { partyId: 'A', amount: 10000, date: D }));

    expect(computeProfit(data).netProfit).toBe(before); // revenue counted once
    expect(cashBalance(data)).toBe(10000);              // money arrived
    expect(accountBalance(data, partyAcc('A'))).toBe(0); // debt settled
    expect(ledgerIsBalanced(data)).toBe(true);
  });
});

describe('total funds = cash + banks only', () => {
  it('excludes nominal accounts and uncleared cheques', () => {
    let data = emptyData();
    data = apply(data, buildSale(data, { partyId: 'A', amount: 10000, date: D, settlement: 'cash' }));
    // A pending received cheque is NOT cash until it clears.
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '9', chequeDate: '2026-09-01',
      amount: 99999, date: D,
    }));
    expect(totalFunds(data)).toBe(10000);
  });

  it('adds bank balances to physical cash', () => {
    let data = emptyData({
      bankAccounts: [
        { id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 25000, active: true, createdAt: 1, updatedAt: 1 },
      ],
    });
    data = apply(data, buildSale(data, { partyId: 'A', amount: 5000, date: D, settlement: 'cash' }));
    expect(totalFunds(data)).toBe(30000);
  });
});

// --- transfers (spec §15, §16) ---------------------------------------------

describe('party-to-party transfer', () => {
  it('moves balance between parties with no cash effect and one shared reference', () => {
    let data = emptyData();
    data = apply(data, buildPartyTransfer(data, {
      fromPartyId: 'A', toPartyId: 'B', amount: 25000, date: D,
    }));
    expect(ledgerIsBalanced(data)).toBe(true);
    expect(accountBalance(data, partyAcc('A'))).toBe(-25000);
    expect(accountBalance(data, partyAcc('B'))).toBe(25000);
    // No cash or bank movement (spec §15).
    expect(cashBalance(data)).toBe(0);
    for (const v of bankBalances(data).values()) expect(v).toBe(0);
    // Both legs share one txnId (spec §6).
    const lines = data.ledger.filter((l) => l.txnId === data.transactions[0].id);
    expect(lines).toHaveLength(2);
  });
});

describe('bank-to-bank transfer', () => {
  it('reduces the source and increases the destination only', () => {
    let data = emptyData({
      bankAccounts: [
        { id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 100000, active: true, createdAt: 1, updatedAt: 1 },
        { id: 'ACC2', bankId: 'HBL', title: 'Second', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      ],
    });
    data = apply(data, buildBankTransfer(data, {
      fromBankAccountId: 'ACC1', toBankAccountId: 'ACC2', amount: 30000, date: D,
    }));
    expect(ledgerIsBalanced(data)).toBe(true);
    const b = bankBalances(data);
    expect(b.get('ACC1')).toBe(70000);
    expect(b.get('ACC2')).toBe(30000);
    // Parties untouched (spec §16).
    for (const v of partyBalances(data).values()) expect(v).toBe(0);
  });
});

// --- cheque endorsement (spec §13) -----------------------------------------

describe('cheque transfer to another party', () => {
  it('reuses the SAME cheque record and never duplicates it', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const original = data.cheques[0];

    data = apply(data, buildChequeTransfer(data, {
      chequeId: original.id, toPartyId: 'B', amount: 100000, date: D,
    }));

    // Still exactly ONE cheque (spec §31.4).
    expect(data.cheques).toHaveLength(1);
    const after = data.cheques[0];
    expect(after.id).toBe(original.id);
    expect(after.chequeNumber).toBe('1001');   // number preserved
    expect(after.bankId).toBe('HBL');          // bank preserved
    expect(after.chequeDate).toBe('2026-08-01'); // date preserved
    expect(after.amount).toBe(100000);         // amount preserved
    expect(after.partyId).toBe('A');           // original party recorded
    expect(after.status).toBe('transferred');
    expect(after.holder).toEqual({ kind: 'party', partyId: 'B' });
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('settles the payable of the party the cheque is endorsed to', () => {
    let data = emptyData();
    // We owe B 100,000.
    data = apply(data, buildCreditAdjustment(data, { partyId: 'B', amount: 100000, date: D }));
    expect(accountBalance(data, partyAcc('B'))).toBe(-100000);

    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    data = apply(data, buildChequeTransfer(data, {
      chequeId: data.cheques[0].id, toPartyId: 'B', amount: 100000, date: D,
    }));

    // B's payable is now settled by the endorsed cheque.
    expect(accountBalance(data, partyAcc('B'))).toBe(0);
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('rejects a partial transfer when partial allocation is disabled', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const res = buildChequeTransfer(data, {
      chequeId: data.cheques[0].id, toPartyId: 'B', amount: 60000, date: D,
    });
    expect('error' in res).toBe(true);
  });

  it('allows a split across two parties when partial allocation is enabled', () => {
    let data = emptyData();
    data.settings = { ...data.settings, allowPartialAllocation: true };
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const id = data.cheques[0].id;
    data = apply(data, buildChequeTransfer(data, { chequeId: id, toPartyId: 'B', amount: 60000, date: D }));
    data = apply(data, buildChequeTransfer(data, { chequeId: id, toPartyId: 'C', amount: 40000, date: D }));

    expect(data.cheques).toHaveLength(1);
    expect(data.cheques[0].allocatedAmount).toBe(100000);
    expect(accountBalance(data, partyAcc('B'))).toBe(60000);
    expect(accountBalance(data, partyAcc('C'))).toBe(40000);
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('never allows allocation beyond the cheque amount', () => {
    let data = emptyData();
    data.settings = { ...data.settings, allowPartialAllocation: true };
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const id = data.cheques[0].id;
    data = apply(data, buildChequeTransfer(data, { chequeId: id, toPartyId: 'B', amount: 60000, date: D }));
    const over = buildChequeTransfer(data, { chequeId: id, toPartyId: 'C', amount: 50000, date: D });
    expect('error' in over).toBe(true);
  });

  it('refuses to transfer a cheque back to its originating party', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const res = buildChequeTransfer(data, {
      chequeId: data.cheques[0].id, toPartyId: 'A', amount: 100000, date: D,
    });
    expect('error' in res).toBe(true);
  });
});

// --- clearing & bouncing ---------------------------------------------------

describe('clearing', () => {
  it('a received cheque clearing debits the bank', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const id = data.cheques[0].id;
    data = apply(data, buildChequeDeposit(data, { chequeId: id, bankAccountId: 'ACC1', date: D }));
    data = apply(data, buildChequeClear(data, { chequeId: id, date: '2026-08-02' }));

    expect(bankBalances(data).get('ACC1')).toBe(100000);
    expect(data.cheques[0].status).toBe('cleared');
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('an issued cheque clearing credits the bank', () => {
    let data = emptyData({
      bankAccounts: [
        { id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 500000, active: true, createdAt: 1, updatedAt: 1 },
      ],
    });
    data = apply(data, buildPdcIssued(data, {
      partyId: 'B', bankAccountId: 'ACC1', chequeNumber: '5001',
      chequeDate: '2026-08-01', amount: 40000, date: D,
    }));
    const id = data.cheques[0].id;
    // Issued cheques must be presented before they can clear.
    const presented = { ...data.cheques[0], status: 'presented' as const };
    data = { ...data, cheques: [presented] };
    data = apply(data, buildChequeClear(data, { chequeId: id, date: '2026-08-02' }));

    expect(bankBalances(data).get('ACC1')).toBe(460000);
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('refuses to clear a cheque that was endorsed away', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const id = data.cheques[0].id;
    data = apply(data, buildChequeTransfer(data, { chequeId: id, toPartyId: 'B', amount: 100000, date: D }));
    const res = buildChequeClear(data, { chequeId: id, bankAccountId: 'ACC1', date: D });
    expect('error' in res).toBe(true);
  });
});

describe('bouncing (spec §19)', () => {
  it('restores the original receivable and requires a reason', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    expect(accountBalance(data, partyAcc('A'))).toBe(-100000);

    const noReason = buildChequeBounce(data, { chequeId: data.cheques[0].id, date: D, reason: '' });
    expect('error' in noReason).toBe(true);

    data = apply(data, buildChequeBounce(data, {
      chequeId: data.cheques[0].id, date: D, reason: 'Insufficient funds',
    }));
    // The debt is back where it started.
    expect(accountBalance(data, partyAcc('A'))).toBe(0);
    expect(data.cheques[0].status).toBe('bounced');
    expect(data.cheques[0].bounceReason).toBe('Insufficient funds');
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('charges the bounce back to the endorsee when the cheque was transferred', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const id = data.cheques[0].id;
    data = apply(data, buildChequeTransfer(data, { chequeId: id, toPartyId: 'B', amount: 100000, date: D }));
    // B's payable was settled by the endorsement.
    expect(accountBalance(data, partyAcc('B'))).toBe(100000);

    data = apply(data, buildChequeBounce(data, { chequeId: id, date: D, reason: 'Returned unpaid' }));
    // The exposure reverts to B, who took the cheque.
    expect(accountBalance(data, partyAcc('B'))).toBe(200000);
    expect(ledgerIsBalanced(data)).toBe(true);
  });
});

// --- status rules (spec §17) -----------------------------------------------

describe('status lifecycle guards', () => {
  const base: Cheque = {
    id: 'CH1', direction: 'received', chequeNumber: '1', bankId: 'HBL',
    chequeDate: D, date: D, amount: 100, partyId: 'A', status: 'pending',
    holder: { kind: 'business' }, allocatedAmount: 0, createdAt: 1, updatedAt: 1,
  };

  it('a cancelled cheque cannot be cleared', () => {
    expect(validateStatusChange({ ...base, status: 'cancelled' }, 'cleared')).toBeTruthy();
  });

  it('a cleared cheque cannot be edited without reversal', () => {
    expect(validateStatusChange({ ...base, status: 'cleared' }, 'bounced')).toBeTruthy();
  });

  it('a pending received cheque may be deposited or transferred', () => {
    expect(validateStatusChange(base, 'deposited')).toBeNull();
    expect(validateStatusChange(base, 'transferred')).toBeNull();
  });

  it('an issued cheque cannot jump straight from pending to cleared', () => {
    const issued: Cheque = { ...base, direction: 'issued', status: 'pending' };
    expect(validateStatusChange(issued, 'cleared')).toBeTruthy();
    expect(validateStatusChange(issued, 'presented')).toBeNull();
  });
});

// --- replacement -----------------------------------------------------------

describe('replacement cheques', () => {
  it('links both cheques and keeps the bounced one in history', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 100000, date: D,
    }));
    const origId = data.cheques[0].id;
    data = apply(data, buildChequeBounce(data, { chequeId: origId, date: D, reason: 'NSF' }));
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1002',
      chequeDate: '2026-09-01', amount: 100000, date: D,
    }));
    const newId = data.cheques.find((c) => c.chequeNumber === '1002')!.id;

    const res = linkReplacement(data, {
      originalChequeId: origId, replacementChequeId: newId, date: D,
    });
    if ('error' in res) throw new Error(res.error);
    expect(res.original.status).toBe('replaced');
    expect(res.original.replacedByChequeId).toBe(newId);
    expect(res.replacement.replacesChequeId).toBe(origId);
    // The bounced cheque still exists.
    expect(data.cheques.some((c) => c.id === origId)).toBe(true);
  });

  it('refuses to replace a cheque that is not bounced or returned', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 1000, date: D,
    }));
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1002',
      chequeDate: '2026-08-01', amount: 1000, date: D,
    }));
    const res = linkReplacement(data, {
      originalChequeId: data.cheques[0].id,
      replacementChequeId: data.cheques[1].id,
      date: D,
    });
    expect('error' in res).toBe(true);
  });
});

// --- reversal (spec §26) ---------------------------------------------------

describe('reversal', () => {
  it('nets the original posting to zero while both remain visible', () => {
    let data = emptyData();
    data = apply(data, buildCashReceived(data, { partyId: 'A', amount: 5000, date: D }));
    expect(cashBalance(data)).toBe(5000);

    const txnId = data.transactions[0].id;
    const rev = buildReversal(data, txnId, D);
    if ('error' in rev) throw new Error(rev.error);
    data = { ...data, transactions: [...data.transactions, rev.txn], ledger: [...data.ledger, ...rev.lines] };

    expect(cashBalance(data)).toBe(0);
    expect(accountBalance(data, partyAcc('A'))).toBe(0);
    expect(ledgerIsBalanced(data)).toBe(true);
    // Both records survive (spec §26: original stays in history).
    expect(data.transactions).toHaveLength(2);
  });

  it('reverses BOTH sides of a party transfer together', () => {
    let data = emptyData();
    data = apply(data, buildPartyTransfer(data, {
      fromPartyId: 'A', toPartyId: 'B', amount: 25000, date: D,
    }));
    const rev = buildReversal(data, data.transactions[0].id, D);
    if ('error' in rev) throw new Error(rev.error);
    data = { ...data, transactions: [...data.transactions, rev.txn], ledger: [...data.ledger, ...rev.lines] };

    expect(accountBalance(data, partyAcc('A'))).toBe(0);
    expect(accountBalance(data, partyAcc('B'))).toBe(0);
    expect(ledgerIsBalanced(data)).toBe(true);
  });

  it('refuses to reverse the same transaction twice', () => {
    let data = emptyData();
    data = apply(data, buildCashReceived(data, { partyId: 'A', amount: 100, date: D }));
    const marked: PdcTransaction = { ...data.transactions[0], reversed: true };
    data = { ...data, transactions: [marked] };
    expect('error' in buildReversal(data, marked.id, D)).toBe(true);
  });
});

// --- validation (spec §28) -------------------------------------------------

describe('duplicate cheque detection', () => {
  it('flags the same cheque number on the same bank', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 1000, date: D,
    }));
    expect(isDuplicateCheque(data, { chequeNumber: '1001', bankId: 'HBL', direction: 'received' })).toBe(true);
    expect(isDuplicateCheque(data, { chequeNumber: '1002', bankId: 'HBL', direction: 'received' })).toBe(false);
  });

  it('ignores the cheque being edited', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 1000, date: D,
    }));
    const id = data.cheques[0].id;
    expect(isDuplicateCheque(data, { chequeNumber: '1001', bankId: 'HBL', direction: 'received' }, id)).toBe(false);
  });
});

// --- references & summary ---------------------------------------------------

describe('reference numbers', () => {
  it('increments per type and does not collide across types', () => {
    let data = emptyData();
    expect(nextReference(data, 'PDC Received')).toBe('PDCR-000001');
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1001',
      chequeDate: '2026-08-01', amount: 1000, date: D,
    }));
    expect(nextReference(data, 'PDC Received')).toBe('PDCR-000002');
    expect(nextReference(data, 'Cash Received')).toBe('CRV-000001');
  });
});

describe('summary totals reconcile with the ledger (spec §31.9)', () => {
  it('receivable and payable match the party balances', () => {
    let data = emptyData();
    data = apply(data, buildDebitAdjustment(data, { partyId: 'A', amount: 10000, date: D }));
    data = apply(data, buildCreditAdjustment(data, { partyId: 'B', amount: 4000, date: D }));

    const s = computeSummary(data, '2026-07-27');
    const balances = partyBalances(data);
    let recv = 0, pay = 0;
    for (const v of balances.values()) { if (v > 0) recv += v; else pay += -v; }

    expect(s.totalReceivable).toBe(recv);
    expect(s.totalPayable).toBe(pay);
  });

  it('counts due-today and overdue cheques correctly', () => {
    let data = emptyData();
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1', chequeDate: '2026-07-27', amount: 1000, date: D,
    }));
    data = apply(data, buildPdcReceived(data, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '2', chequeDate: '2026-07-01', amount: 500, date: D,
    }));
    const s = computeSummary(data, '2026-07-27');
    expect(s.dueToday).toBe(1000);
    expect(s.overdue).toBe(500);
  });
});
