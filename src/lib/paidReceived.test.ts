/**
 * Paid & Received, and cash that passes between two parties.
 *
 * The client records an entry only once the money has moved, so the working
 * view is Paid and Received — not what is owed. And money that came from one
 * party and went straight to another is ONE entry: it shows in the Cash
 * Ledger (in and out) and in BOTH parties' ledgers, and is never counted twice.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildCashReceived, buildCashPaid, cashBalance, ledgerIsBalanced, trialBalanceRows,
  type Posting,
} from './pdcEngine';
import { buildChequeToCash } from './chequeWorkflow';
import {
  EMPTY_FILTERS, applyFilters, buildCashLedger, buildPartyLedger, buildRegister, paidAndReceived, paymentsByParty,
  settledState,
} from './pdcRegister';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'N', name: 'Haji Naseer', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'P', name: 'Pak trading company', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
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
    movements: [...d.movements, ...p.movements],
  };
}

const ends = (r: { from: string; to: string }) => `${r.from} → ${r.to}`;

describe('cash from one party paid straight to another — ONE entry', () => {
  /** Pak trading paid 350,000 with money that came from Haji Naseer. */
  const viaPay = () => apply(seed(), buildCashPaid(seed(), {
    partyId: 'P', otherPartyId: 'N', amount: 350_000, date: '2026-09-05', paymentMethod: 'cash',
  }));
  /** The same thing, entered from the Receive side. */
  const viaReceive = () => apply(seed(), buildCashReceived(seed(), {
    partyId: 'N', otherPartyId: 'P', amount: 350_000, date: '2026-09-05', paymentMethod: 'cash',
  }));

  for (const [how, make] of [['entered as a Pay', viaPay], ['entered as a Receive', viaReceive]] as const) {
    describe(how, () => {
      it('is one entry, balanced, and leaves cash where it was', () => {
        const d = make();
        expect(d.transactions).toHaveLength(1);
        expect(ledgerIsBalanced(d)).toBe(true);
        expect(cashBalance(d)).toBe(0);
        const tb = trialBalanceRows(d);
        expect(tb.reduce((s, r) => s + r.debit, 0)).toBe(tb.reduce((s, r) => s + r.credit, 0));
      });

      it('shows on the Cash Ledger as cash in from Haji Naseer and out to Pak trading', () => {
        const rows = [...buildCashLedger(make()).rows].reverse();
        expect(rows.map(ends)).toEqual([
          'Haji Naseer → Cash in Hand',
          'Cash in Hand → Pak trading company',
        ]);
        expect(rows.map((r) => [r.entry.debit, r.entry.credit])).toEqual([[350_000, 0], [0, 350_000]]);
      });

      it("is on BOTH parties' ledgers, each with its own side", () => {
        const d = make();
        const n = buildPartyLedger(d, 'N').rows;
        const p = buildPartyLedger(d, 'P').rows;
        expect(n).toHaveLength(1);
        expect(p).toHaveLength(1);
        expect([n[0].entry.credit, ends(n[0])]).toEqual([350_000, 'Haji Naseer → Cash in Hand']);
        expect([p[0].entry.debit, ends(p[0])]).toEqual([350_000, 'Cash in Hand → Pak trading company']);
      });

      it('is Received from one and Paid to the other — each counted once', () => {
        const { received, paid } = paidAndReceived(make());
        expect(received.map((x) => [x.partyName, x.amount])).toEqual([['Haji Naseer', 350_000]]);
        expect(paid.map((x) => [x.partyName, x.amount])).toEqual([['Pak trading company', 350_000]]);
      });

      it('reads "Haji Naseer → Pak trading company" on the Cash Book, found under either party', () => {
        const d = make();
        const reg = buildRegister(d);
        expect(reg).toHaveLength(1);
        expect(`${reg[0].fromName} → ${reg[0].toName}`).toBe('Haji Naseer → Pak trading company');
        expect([reg[0].debit, reg[0].credit]).toEqual([350_000, 350_000]);
        expect(applyFilters(reg, { ...EMPTY_FILTERS, partyId: 'N' }, '2026-09-05')).toHaveLength(1);
        expect(applyFilters(reg, { ...EMPTY_FILTERS, partyId: 'P' }, '2026-09-05')).toHaveLength(1);
      });
    });
  }
});

describe('Paid & Received', () => {
  it('counts completed payments only — not sales, and not a cheque twice when it clears', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'N', amount: 900_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, { partyId: 'N', amount: 300_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'N', amount: 200_000, date: '2026-08-03', paymentMethod: 'cheque',
      cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-08-10' },
    }));
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: '2026-08-10' }));
    d = apply(d, buildCashPaid(d, { partyId: 'P', amount: 150_000, date: '2026-08-11', paymentMethod: 'cash' }));

    const by = paymentsByParty(d);
    expect(by.get('N')).toEqual({ received: 500_000, paid: 0, receivedCount: 2, paidCount: 0 });
    expect(by.get('P')).toEqual({ received: 0, paid: 150_000, receivedCount: 0, paidCount: 1 });
  });

  it('leaves out a payment that was reversed, or a cheque that bounced', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, { partyId: 'N', amount: 100_000, date: '2026-08-02', paymentMethod: 'cash' }));
    d = { ...d, transactions: d.transactions.map((t) => ({ ...t, reversed: true })) };
    d = apply(d, buildCashReceived(d, {
      partyId: 'N', amount: 200_000, date: '2026-08-03', paymentMethod: 'cheque',
      cheque: { chequeNumber: 'C1', bankId: 'HABIB', chequeDate: '2026-08-10' },
    }));
    d = { ...d, cheques: d.cheques.map((c) => ({ ...c, status: 'bounced' as const })) };
    expect(paidAndReceived(d).received).toHaveLength(0);
  });

  it('labels every payment Paid or Received — never "Need to Pay" — and trades not at all', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'N', amount: 900_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'P', amount: 50_000, date: '2026-08-04', paymentMethod: 'cheque',
      cheque: { chequeNumber: 'I1', bankId: 'HABIB', chequeDate: '2026-09-30' },
    }));
    d = apply(d, buildCashReceived(d, { partyId: 'N', amount: 10_000, date: '2026-08-05', paymentMethod: 'cash' }));
    const labels = buildRegister(d).map((r) => [r.txn.type, settledState(r)?.label ?? null]);
    expect(labels).toEqual([
      ['Cash Received', 'Received'],
      ['Cash Paid', 'Paid'],
      ['Sale', null],
    ]);
  });
});
