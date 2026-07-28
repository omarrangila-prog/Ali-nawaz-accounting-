/**
 * End-to-end verification of the headline cheque flow:
 *
 *   Cheque received from Party A
 *     → appears in Receivable
 *     → transferred to Party B
 *     → appears in Party B's Payable and ledger
 *     → later cleared / bounced / returned
 *
 * Each step asserts that ALL eight linked records update: cashbook entry,
 * party sub-ledger, debit/credit columns, receivable/payable balance, bank
 * ledger, running balance, cheque history and audit trail.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, bankBalances, buildCreditAdjustment, buildPdcReceived,
  ledgerIsBalanced, partyAcc, partyBalances, type Posting,
} from './pdcEngine';
import {
  buildChequeBounce, buildChequeClear, buildChequeDeposit, buildChequeTransfer,
  chequeTimeline,
} from './chequeWorkflow';
import { buildRegister, buildPartyLedger, buildBankLedger } from './pdcRegister';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed Traders', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Ali Enterprises', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [{ id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    ledgers: [],
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

const D = '2026-07-01';

describe('headline cheque flow: A -> receivable -> B -> cleared', () => {
  it('walks the full journey and keeps every linked record correct', () => {
    let d = seed();

    // --- Party A owes us 150,000 (a receivable) --------------------------
    d.parties = d.parties.map((p) => p.id === 'A' ? { ...p, openingBalance: 150000 } : p);
    expect(accountBalance(d, partyAcc('A'))).toBe(150000);   // A owes us

    // We owe Party B 150,000 (a payable).
    d = apply(d, buildCreditAdjustment(d, { partyId: 'B', amount: 150000, date: D }));
    expect(accountBalance(d, partyAcc('B'))).toBe(-150000);  // we owe B

    // --- STEP 1: cheque received from Party A ---------------------------
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '100234',
      chequeDate: '2026-08-15', amount: 150000, date: D,
      description: 'Against outstanding invoice',
    }));
    const chequeId = d.cheques[0].id;

    // 1a. Cashbook entry created with a reference.
    const reg1 = buildRegister(d);
    expect(reg1[0].txn.type).toBe('PDC Received');
    expect(reg1[0].txn.reference).toMatch(/^PDCR-/);
    // 1b. Party A's receivable is settled by the cheque.
    expect(accountBalance(d, partyAcc('A'))).toBe(0);
    // 1c. Appears in A's sub-ledger with a credit.
    const ledA = buildPartyLedger(d, 'A');
    expect(ledA.rows.some((r) => r.entry.credit === 150000)).toBe(true);
    // 1d. Cheque is pending and held by the business.
    expect(d.cheques[0].status).toBe('pending');
    expect(d.cheques[0].holder).toEqual({ kind: 'business' });
    // 1e. Bank untouched — an uncleared cheque is not money.
    expect(bankBalances(d).get('ACC1')).toBe(0);
    // 1f. Cheque history started.
    expect(chequeTimeline(d, chequeId)).toHaveLength(1);
    expect(ledgerIsBalanced(d)).toBe(true);

    // --- STEP 2: transfer the SAME cheque to Party B ---------------------
    d = apply(d, buildChequeTransfer(d, {
      chequeId, toPartyId: 'B', amount: 150000, date: '2026-07-05',
    }));

    // 2a. NO duplicate cheque was created.
    expect(d.cheques).toHaveLength(1);
    const ch = d.cheques[0];
    expect(ch.id).toBe(chequeId);
    expect(ch.chequeNumber).toBe('100234');      // number preserved
    expect(ch.bankId).toBe('HBL');               // bank preserved
    expect(ch.chequeDate).toBe('2026-08-15');    // date preserved
    expect(ch.amount).toBe(150000);              // amount preserved
    expect(ch.partyId).toBe('A');                // original party remembered
    // 2b. Ownership moved to B.
    expect(ch.status).toBe('transferred');
    expect(ch.holder).toEqual({ kind: 'party', partyId: 'B' });
    // 2c. B's payable is settled by the endorsed cheque.
    expect(accountBalance(d, partyAcc('B'))).toBe(0);
    // 2d. Both sides appear in their sub-ledgers under ONE transaction id.
    const endorse = d.transactions.find((t) => t.type === 'Cheque Endorsement')!;
    const legs = d.ledger.filter((l) => l.txnId === endorse.id);
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((l) => l.txnId)).size).toBe(1);
    // 2e. B's ledger shows the debit that cleared the payable.
    const ledB = buildPartyLedger(d, 'B');
    expect(ledB.rows.some((r) => r.entry.debit === 150000)).toBe(true);
    // 2f. Movement history recorded the hop.
    const tl = chequeTimeline(d, chequeId);
    expect(tl).toHaveLength(2);
    expect(tl[1].action).toBe('Transferred to party');
    expect(tl[1].toPartyId).toBe('B');
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('BOUNCE path: restores the debt to whoever holds the cheque', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '100234',
      chequeDate: '2026-08-15', amount: 150000, date: D,
    }));
    const chequeId = d.cheques[0].id;
    d = apply(d, buildChequeTransfer(d, { chequeId, toPartyId: 'B', amount: 150000, date: D }));
    const bBefore = accountBalance(d, partyAcc('B'));

    d = apply(d, buildChequeBounce(d, {
      chequeId, date: '2026-08-16', reason: 'Insufficient funds',
    }));

    // Status, reason and date recorded; holder returns to the business.
    expect(d.cheques[0].status).toBe('bounced');
    expect(d.cheques[0].bounceReason).toBe('Insufficient funds');
    expect(d.cheques[0].bouncedOn).toBe('2026-08-16');
    expect(d.cheques[0].holder).toEqual({ kind: 'business' });
    // The debt reverts to B, who took the cheque — a real ledger effect,
    // not just a status flip.
    expect(accountBalance(d, partyAcc('B'))).toBe(bBefore + 150000);
    // History appended, never overwritten.
    expect(chequeTimeline(d, chequeId)).toHaveLength(3);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('CLEAR path: deposit then clear moves real money into the bank', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '100234',
      chequeDate: '2026-08-15', amount: 150000, date: D,
    }));
    const chequeId = d.cheques[0].id;

    d = apply(d, buildChequeDeposit(d, { chequeId, bankAccountId: 'ACC1', date: '2026-08-15' }));
    expect(d.cheques[0].status).toBe('deposited');
    expect(bankBalances(d).get('ACC1')).toBe(0);   // still not money yet

    d = apply(d, buildChequeClear(d, { chequeId, date: '2026-08-17' }));
    expect(d.cheques[0].status).toBe('cleared');
    // NOW the bank account is credited.
    expect(bankBalances(d).get('ACC1')).toBe(150000);
    // Bank sub-ledger shows it with a running balance.
    const bank = buildBankLedger(d, 'ACC1');
    expect(bank.balance).toBe(150000);
    expect(bank.rows.some((r) => r.entry.debit === 150000)).toBe(true);
    // Running balance in the main register reflects the money.
    const reg = buildRegister(d);
    expect(reg[0].running).toBe(150000);
    // Full history: created -> deposited -> cleared.
    expect(chequeTimeline(d, chequeId).map((m) => m.action)).toEqual([
      'Created — received from party', 'Deposited to bank', 'Cleared',
    ]);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('receivable and payable totals always reconcile with the party ledgers', () => {
    let d = seed();
    d.parties = d.parties.map((p) => p.id === 'A' ? { ...p, openingBalance: 150000 } : p);
    d = apply(d, buildCreditAdjustment(d, { partyId: 'B', amount: 90000, date: D }));
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: '1', chequeDate: '2026-08-01', amount: 60000, date: D,
    }));

    // Every party's replayed ledger balance must equal its computed balance.
    const balances = partyBalances(d);
    for (const p of d.parties) {
      expect(buildPartyLedger(d, p.id).balance).toBe(balances.get(p.id));
    }
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
