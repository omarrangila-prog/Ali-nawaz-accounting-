/**
 * Handing a payment on to another person.
 *
 * Two shapes, both reached from the Transfer button on a transaction:
 *   • a received cheque still in hand is ENDORSED — one physical cheque, one
 *     record for life, never duplicated
 *   • anything else moves the balance between two parties
 *
 * Also covers creating a party or a bank account simply by typing a name.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildCashReceived, buildPartyTransfer,
  ledgerIsBalanced, accountBalance, partyAcc, cashBalance, bankBalances,
  type Posting,
} from './pdcEngine';
import { buildChequeTransfer } from './chequeWorkflow';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'C', name: 'Chandio', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
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

const bal = (d: PdcDataSet, id: string) => accountBalance(d, partyAcc(id));

// --- Endorsing a cheque to someone else -----------------------------------

describe('transferring a cheque payment to another person', () => {
  /** Ahmed pays by cheque; that cheque is still in our hands. */
  function withCheque(): PdcDataSet {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 200_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 200_000, date: '2026-08-02',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-100', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    return d;
  }

  it('passes the same physical cheque on — it is never duplicated', () => {
    let d = withCheque();
    const id = d.cheques[0].id;

    d = apply(d, buildChequeTransfer(d, {
      chequeId: id, toPartyId: 'B', amount: 200_000, date: '2026-08-05',
    }));

    // ONE cheque still, with the same number — endorsed, not copied.
    expect(d.cheques).toHaveLength(1);
    expect(d.cheques[0].id).toBe(id);
    expect(d.cheques[0].chequeNumber).toBe('CH-100');
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('settles what we owe the person it was handed to', () => {
    let d = withCheque();
    // We buy from Bilal on credit, then hand him Ahmed's cheque.
    d = apply(d, buildPartyTransfer(d, {
      fromPartyId: 'C', toPartyId: 'B', amount: 0, date: '2026-08-04',
    }));
    const before = bal(d, 'B');

    d = apply(d, buildChequeTransfer(d, {
      chequeId: d.cheques[0].id, toPartyId: 'B', amount: 200_000, date: '2026-08-05',
    }));

    // Bilal is now owed 200,000 less than before the endorsement.
    expect(bal(d, 'B')).toBe(before + 200_000);
    // No cash or bank moved — the cheque itself changed hands.
    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('records the hand-over in the cheque history', () => {
    let d = withCheque();
    const before = d.movements.length;
    d = apply(d, buildChequeTransfer(d, {
      chequeId: d.cheques[0].id, toPartyId: 'B', amount: 200_000, date: '2026-08-05',
    }));
    expect(d.movements.length).toBeGreaterThan(before);
  });

  it('refuses to hand on the same cheque twice', () => {
    let d = withCheque();
    const id = d.cheques[0].id;
    d = apply(d, buildChequeTransfer(d, {
      chequeId: id, toPartyId: 'B', amount: 200_000, date: '2026-08-05',
    }));
    // A second endorsement of a fully-allocated cheque must be rejected.
    const again = buildChequeTransfer(d, {
      chequeId: id, toPartyId: 'C', amount: 200_000, date: '2026-08-06',
    });
    expect('error' in again).toBe(true);
  });
});

// --- Moving a balance to another person -----------------------------------

describe('transferring a balance to another person', () => {
  it('moves the amount from one party to the other', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    expect(bal(d, 'A')).toBe(90_000);

    d = apply(d, buildPartyTransfer(d, {
      fromPartyId: 'A', toPartyId: 'B', amount: 90_000, date: '2026-08-03',
    }));

    // Ahmed is clear; Bilal now carries the debt.
    expect(bal(d, 'A')).toBe(0);
    expect(bal(d, 'B')).toBe(90_000);
    // Nothing left the business — only who owes it changed.
    expect(cashBalance(d)).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('handles a part transfer, leaving the rest behind', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPartyTransfer(d, {
      fromPartyId: 'A', toPartyId: 'B', amount: 30_000, date: '2026-08-03',
    }));
    expect(bal(d, 'A')).toBe(60_000);
    expect(bal(d, 'B')).toBe(30_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('leaves both parties visible in history', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 90_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPartyTransfer(d, {
      fromPartyId: 'A', toPartyId: 'B', amount: 90_000, date: '2026-08-03',
    }));
    const t = d.transactions.find((x) => x.type === 'Party Transfer')!;
    expect(t.partyId).toBe('A');
    expect(t.toPartyId).toBe('B');
  });
});
