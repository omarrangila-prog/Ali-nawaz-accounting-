/**
 * Returning a cheque restores the debt, exactly like a bounce, but records a
 * distinct status so reports and history say which actually happened.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, ledgerIsBalanced, partyAcc, buildPdcReceived, buildPdcIssued,
  type Posting,
} from './pdcEngine';
import { buildChequeReturn, buildChequeTransfer, chequeTimeline } from './chequeWorkflow';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
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
const D = '2026-07-01';

describe('returning a cheque', () => {
  it('restores the original receivable and posts a balanced entry', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 90000, date: D,
    }));
    expect(accountBalance(d, partyAcc('A'))).toBe(-90000);   // debt settled

    d = apply(d, buildChequeReturn(d, {
      chequeId: d.cheques[0].id, date: '2026-07-10', reason: 'Party asked for it back',
    }));

    expect(accountBalance(d, partyAcc('A'))).toBe(0);        // debt restored
    expect(d.cheques[0].status).toBe('returned');
    expect(d.cheques[0].holder).toEqual({ kind: 'business' });
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('records it in the cheque history as Returned, not Bounced', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 50000, date: D,
    }));
    const id = d.cheques[0].id;
    d = apply(d, buildChequeReturn(d, { chequeId: id, date: '2026-07-10' }));

    const tl = chequeTimeline(d, id);
    expect(tl).toHaveLength(2);
    expect(tl[1].action).toBe('Returned');
    expect(tl[1].toStatus).toBe('returned');
    expect(d.transactions[1].type).toBe('Cheque Returned');
  });

  it('charges an endorsed cheque back to whoever holds it', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 90000, date: D,
    }));
    const id = d.cheques[0].id;
    d = apply(d, buildChequeTransfer(d, { chequeId: id, toPartyId: 'B', amount: 90000, date: D }));
    const bBefore = accountBalance(d, partyAcc('B'));

    d = apply(d, buildChequeReturn(d, { chequeId: id, date: '2026-07-10' }));
    // Exposure reverts to B, who took the cheque — same rule as a bounce.
    expect(accountBalance(d, partyAcc('B'))).toBe(bBefore + 90000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('an issued cheque returning restores what we owe', () => {
    let d = seed();
    d = apply(d, buildPdcIssued(d, {
      partyId: 'B', bankAccountId: 'ACC1', chequeNumber: '5001',
      chequeDate: '2026-08-01', amount: 40000, date: D,
    }));
    expect(accountBalance(d, partyAcc('B'))).toBe(40000);    // payable settled

    d = apply(d, buildChequeReturn(d, { chequeId: d.cheques[0].id, date: '2026-07-10' }));
    expect(accountBalance(d, partyAcc('B'))).toBe(0);        // we owe again
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('refuses to return a cheque that already cleared', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 10000, date: D,
    }));
    d = { ...d, cheques: [{ ...d.cheques[0], status: 'cleared' }] };
    const res = buildChequeReturn(d, { chequeId: d.cheques[0].id, date: D });
    expect('error' in res).toBe(true);
  });
});
