/**
 * From → To on every ledger line.
 *
 * A cheque line always said who it came from and where it went; a cash line
 * said nothing. Every line now names both ends — read off the posting itself —
 * so "Received from Ahmed into Cash in Hand" and "Paid from Cash in Hand to
 * Bilal" are written on the statement, on screen and on paper alike.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid, buildExpense, type Posting,
} from './pdcEngine';
import { buildChequeToCash, buildChequeTransfer } from './chequeWorkflow';
import { buildBankLedger, buildCashLedger, buildPartyLedger, buildRegister } from './pdcRegister';
import { ledgerHead, ledgerTable } from './pdcWorksheet';
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

const BANK = 'Habib Bank — Main';
/** Rows oldest-first, the way a statement reads. */
const chrono = <T,>(rows: T[]): T[] => [...rows].reverse();
const ends = (r: { from: string; to: string }) => `${r.from} → ${r.to}`;

describe('cash received', () => {
  const d = apply(seed(), buildCashReceived(seed(), {
    partyId: 'A', amount: 40_000, date: '2026-08-02', paymentMethod: 'cash',
  }));

  it('reads "Ahmed → Cash in Hand" on the party ledger', () => {
    expect(ends(buildPartyLedger(d, 'A').rows[0])).toBe('Ahmed → Cash in Hand');
  });
  it('reads the same on the Cash Account', () => {
    expect(ends(buildCashLedger(d).rows[0])).toBe('Ahmed → Cash in Hand');
  });
  it('reads the same on the Cash Book', () => {
    const r = buildRegister(d)[0];
    expect(`${r.fromName} → ${r.toName}`).toBe('Ahmed → Cash in Hand');
  });
});

describe('cash paid', () => {
  const d = apply(seed(), buildCashPaid(seed(), {
    partyId: 'B', amount: 15_000, date: '2026-08-03', paymentMethod: 'cash',
  }));

  it('reads "Cash in Hand → Bilal" everywhere', () => {
    expect(ends(buildPartyLedger(d, 'B').rows[0])).toBe('Cash in Hand → Bilal');
    expect(ends(buildCashLedger(d).rows[0])).toBe('Cash in Hand → Bilal');
    const r = buildRegister(d)[0];
    expect(`${r.fromName} → ${r.toName}`).toBe('Cash in Hand → Bilal');
  });
});

describe('through a bank', () => {
  it('names the bank account as the other end', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 10_000, date: '2026-08-02', paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'B', amount: 4_000, date: '2026-08-03', paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));
    expect(ends(buildPartyLedger(d, 'A').rows[0])).toBe(`Ahmed → ${BANK}`);
    expect(ends(buildPartyLedger(d, 'B').rows[0])).toBe(`${BANK} → Bilal`);
    expect(chrono(buildBankLedger(d, 'ACC1').rows).map(ends)).toEqual([
      `Ahmed → ${BANK}`,
      `${BANK} → Bilal`,
    ]);
  });
});

describe('cheques', () => {
  function withCheque(): PdcDataSet {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 200_000, date: '2026-08-02', paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-500', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));
    return d;
  }

  it('a received cheque reads "Ahmed → Cheque in Hand"', () => {
    expect(ends(buildPartyLedger(withCheque(), 'A').rows[0])).toBe('Ahmed → Cheque in Hand');
  });

  it('taking it as cash reads "Ahmed (cheque) → Cash in Hand"', () => {
    let d = withCheque();
    d = apply(d, buildChequeToCash(d, { chequeId: d.cheques[0].id, date: '2026-09-01' }));
    expect(ends(buildCashLedger(d).rows[0])).toBe('Ahmed (cheque) → Cash in Hand');
  });

  it('passing it on reads "Ahmed (cheque) → Bilal"', () => {
    let d = withCheque();
    d = apply(d, buildChequeTransfer(d, {
      chequeId: d.cheques[0].id, toPartyId: 'B', amount: 200_000, date: '2026-08-05',
    }));
    expect(ends(buildPartyLedger(d, 'B').rows[0])).toBe('Ahmed (cheque) → Bilal');
  });
});

describe('trade and expenses', () => {
  it('a sale reads "Sales → Ahmed", a purchase "Bilal → Purchases"', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 5_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildPurchase(d, { partyId: 'B', amount: 3_000, date: '2026-08-01', settlement: 'credit' }));
    expect(ends(buildPartyLedger(d, 'A').rows[0])).toBe('Sales → Ahmed');
    expect(ends(buildPartyLedger(d, 'B').rows[0])).toBe('Bilal → Purchases');
  });

  it('an expense names what the cash went on', () => {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 9_000, date: '2026-08-01', paymentMethod: 'cash',
    }));
    d = apply(d, buildExpense(d, { amount: 1_200, date: '2026-08-02', category: 'Fuel' }));
    expect(ends(buildCashLedger(d).rows[0])).toBe('Cash in Hand → Fuel');
  });
});

describe('printed ledgers carry From and To', () => {
  function sample(): PdcDataSet {
    let d = seed();
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 40_000, date: '2026-07-20', paymentMethod: 'cash',
    }));
    d = apply(d, buildCashPaid(d, {
      partyId: 'A', amount: 15_000, date: '2026-08-03', paymentMethod: 'cash',
    }));
    return d;
  }

  it('in the same place as the screen', () => {
    const head = ledgerHead('Debit (-)', 'Credit (+)');
    expect(head.slice(0, 8)).toEqual(['Date', 'Qty', 'Rate', 'Method', 'From', 'To', 'Cheque #', 'Tafseel']);

    const d = sample();
    const t = ledgerTable(d, chrono(buildPartyLedger(d, 'A').rows), 0);
    const from = head.indexOf('From');
    const to = head.indexOf('To');
    // Row 0 is the opening balance; the movements follow it.
    expect([t.rows[1][from], t.rows[1][to]]).toEqual(['Ahmed', 'Cash in Hand']);
    expect([t.rows[2][from], t.rows[2][to]]).toEqual(['Cash in Hand', 'Ahmed']);
    expect(t.closing).toBe(-25_000);
  });

  it('on the Reports page, starting a date range from what was brought forward', () => {
    const d = sample();
    // The report is a finished PDF; its page text says what was printed.
    const text = buildPdcReport(d, 'cash-ledger', { from: '2026-08-01' }).output();
    for (const h of ['From', 'To', 'Qty', 'Rate', 'Method', 'Tafseel']) expect(text).toContain(`(${h})`);
    // The July receipt is carried in as one figure, not dropped, so the page
    // still ends on the true cash in hand.
    expect(text).toContain('(Brought Forward)');
    expect(text).toContain('(Cash in Hand)');
    expect(text).toContain('(25,000 \\(+\\))');
  });
});
