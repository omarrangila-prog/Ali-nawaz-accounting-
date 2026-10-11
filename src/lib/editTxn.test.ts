/**
 * Editing a posted transaction IN PLACE.
 *
 * The entry keeps its id and reference and simply holds the right figures
 * afterwards. No reversing entry is created, so the register shows ONE row and
 * the totals count the amount once — which is what makes an edit feel like a
 * correction rather than a second transaction.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  buildSale, buildCashReceived,
  ledgerIsBalanced, accountBalance, partyAcc, cashBalance, bankBalances,
  computeProfit, relinkCheque, type Posting,
} from './pdcEngine';
import { buildPartyLedger, buildRegister } from './pdcRegister';
import { buildChequeTransfer } from './chequeWorkflow';

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

/**
 * The store's edit, in the same shape: the corrected posting is re-pointed at
 * the ORIGINAL entry, its old ledger lines are dropped and the new ones written
 * under that same id. Nothing new is appended to history.
 */
function edit(d: PdcDataSet, txnId: string, corrected: Posting): PdcDataSet {
  const original = d.transactions.find((t) => t.id === txnId)!;
  const oldChequeId = original.chequeId;

  const txn = {
    ...corrected.txn,
    id: original.id,
    reference: original.reference,
    createdAt: original.createdAt,
  };
  let cheque = corrected.cheque;
  if (cheque && oldChequeId) cheque = { ...cheque, id: oldChequeId };
  if (cheque) txn.chequeId = cheque.id;
  else delete txn.chequeId;

  const lines = relinkCheque(corrected.lines, txn.id, corrected.cheque?.id, cheque?.id);

  return {
    ...d,
    transactions: d.transactions.map((t) => (t.id === txnId ? txn : t)),
    ledger: [...d.ledger.filter((l) => l.txnId !== txnId), ...lines],
    cheques: cheque
      ? [...d.cheques.filter((c) => c.id !== cheque!.id), cheque]
      : d.cheques.filter((c) => c.id !== oldChequeId),
  };
}

const bal = (d: PdcDataSet, id: string) => accountBalance(d, partyAcc(id));

describe('editing an amount', () => {
  it('leaves the balance as if only the corrected figure was posted', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    expect(bal(d, 'A')).toBe(100_000);

    // The amount was mistyped: it should have been 10,000.
    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    expect(bal(d, 'A')).toBe(10_000);
    expect(computeProfit(d).sales).toBe(10_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('leaves ONE entry, not three — no reversal is created', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    const ref = d.transactions[0].reference;

    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    expect(d.transactions).toHaveLength(1);
    expect(d.transactions.some((t) => t.type === 'Reversal')).toBe(false);
    // Same entry: same id, same reference, now holding the right figure.
    expect(d.transactions[0].id).toBe(id);
    expect(d.transactions[0].reference).toBe(ref);
    expect(d.transactions[0].amount).toBe(10_000);
    expect(d.transactions[0].reversed).toBeFalsy();
  });

  it('replaces the old ledger lines rather than adding to them', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    const before = d.ledger.length;

    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    // Same number of lines, all still under the original entry.
    expect(d.ledger).toHaveLength(before);
    expect(d.ledger.every((l) => l.txnId === id)).toBe(true);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('editing the party', () => {
  it('moves the entry off the wrong party and onto the right one', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;

    // It was Bilal's sale, not Ahmed's.
    d = edit(d, id, buildSale(d, { partyId: 'B', amount: 50_000, date: '2026-08-01', settlement: 'credit' }));

    expect(bal(d, 'A')).toBe(0);
    expect(bal(d, 'B')).toBe(50_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('editing the details that only describe an entry', () => {
  it('changes quantity, rate, item and description without disturbing balances', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit',
      quantity: 100, rate: 500, itemName: 'Sugar', description: 'wrong note',
    }));
    const id = d.transactions[0].id;

    d = edit(d, id, buildSale(d, {
      partyId: 'A', amount: 50_000, date: '2026-08-01', settlement: 'credit',
      quantity: 250, rate: 200, itemName: 'Rice', description: 'Rizwan order',
    }));

    const latest = d.transactions[d.transactions.length - 1];
    expect(latest.quantity).toBe(250);
    expect(latest.rate).toBe(200);
    expect(latest.itemName).toBe('Rice');
    expect(latest.description).toBe('Rizwan order');
    // The figure never changed, so neither did the balance.
    expect(bal(d, 'A')).toBe(50_000);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('editing how a payment was made', () => {
  it('switches a cash receipt to a bank receipt', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02', paymentMethod: 'cash',
    }));
    const id = d.transactions[1].id;
    expect(cashBalance(d)).toBe(60_000);

    // It actually went into the bank.
    d = edit(d, id, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'bank', bankAccountId: 'ACC1',
    }));

    expect(cashBalance(d)).toBe(0);
    expect(bankBalances(d).get('ACC1')).toBe(60_000);
    expect(bal(d, 'A')).toBe(0);             // still settled
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('switches a cash receipt to a cheque, which stays pending', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 60_000, date: '2026-08-01', settlement: 'credit' }));
    d = apply(d, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02', paymentMethod: 'cash',
    }));
    const id = d.transactions[1].id;

    d = edit(d, id, buildCashReceived(d, {
      partyId: 'A', amount: 60_000, date: '2026-08-02',
      paymentMethod: 'cheque',
      cheque: { chequeNumber: 'CH-1', bankId: 'HABIB', chequeDate: '2026-09-01' },
    }));

    // The cash is gone; a pending cheque holds the value instead.
    expect(cashBalance(d)).toBe(0);
    expect(d.cheques).toHaveLength(1);
    expect(d.cheques[0].status).toBe('pending');
    expect(bal(d, 'A')).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});

describe('the statement after an edit', () => {
  it('shows the correction and ends on the corrected balance', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;
    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit' }));

    const led = buildPartyLedger(d, 'A');
    expect(led.balance).toBe(10_000);
    expect(led.balance).toBe(bal(d, 'A'));
    // ONE line on the statement, showing the corrected figure.
    expect(led.rows).toHaveLength(1);
    expect(led.rows[0].entry.debit).toBe(10_000);
  });
});

describe('the register after an edit', () => {
  it('shows one row, and the totals count the amount ONCE', () => {
    let d = seed();
    d = apply(d, buildSale(d, {
      partyId: 'A', amount: 100_000, date: '2026-08-01', settlement: 'credit',
      quantity: 100, rate: 1_000,
    }));
    const id = d.transactions[0].id;

    d = edit(d, id, buildSale(d, {
      partyId: 'A', amount: 10_000, date: '2026-08-01', settlement: 'credit',
      quantity: 10, rate: 1_000,
    }));

    const reg = buildRegister(d);
    expect(reg).toHaveLength(1);

    // The totals the Cash Book shows: the corrected figures, counted once —
    // NOT the original plus a reversal plus the correction.
    const live = reg.filter((r) => !r.txn.reversed);
    const amount = live.reduce((s, r) => s + r.txn.amount, 0);
    const qty = live.reduce((s, r) => s + (r.txn.quantity ?? 0), 0);
    expect(amount).toBe(10_000);
    expect(qty).toBe(10);
  });

  it('raising an amount does not stack on top of the old one', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 5_000, date: '2026-08-01', settlement: 'credit' }));
    const id = d.transactions[0].id;

    d = edit(d, id, buildSale(d, { partyId: 'A', amount: 8_000, date: '2026-08-01', settlement: 'credit' }));

    // 8,000 — not 5,000 + 8,000, and not 5,000 + 3,000.
    expect(bal(d, 'A')).toBe(8_000);
    expect(buildRegister(d)).toHaveLength(1);
    expect(computeProfit(d).sales).toBe(8_000);
  });
});

describe('editing a cheque entry', () => {
  /** Every cheque custody account in the books, with its balance. */
  function custody(d: PdcDataSet): Map<string, number> {
    const out = new Map<string, number>();
    for (const l of d.ledger) {
      if (!/^PDCI?:/.test(l.account.id)) continue;
      out.set(l.account.id, (out.get(l.account.id) ?? 0) + l.debit - l.credit);
    }
    return out;
  }

  /** A 900,000 cheque from Ahmed, then the entry edited (date corrected). */
  function received(): { d: PdcDataSet; chequeId: string } {
    let d = seed();
    const input = {
      partyId: 'A', amount: 900_000, date: '2026-09-01', paymentMethod: 'cheque' as const,
      cheque: { chequeNumber: '94473746', bankId: 'HABIB', chequeDate: '2026-09-15' },
    };
    d = apply(d, buildCashReceived(d, input));
    const chequeId = d.cheques[0].id;
    d = edit(d, d.transactions[0].id, buildCashReceived(d, { ...input, date: '2026-09-02' }));
    return { d, chequeId };
  }

  it('keeps the money in the cheque it belongs to', () => {
    const { d, chequeId } = received();
    // One custody account, owned by the cheque, holding the full amount — not a
    // second account under an id no cheque has.
    expect([...custody(d)]).toEqual([[`PDC:${chequeId}`, 900_000]]);
    expect(d.ledger.every((l) => !l.chequeId || l.chequeId === chequeId)).toBe(true);
  });

  it('so passing the cheque on afterwards empties that same account', () => {
    let { d, chequeId } = received();
    d = apply(d, buildChequeTransfer(d, {
      chequeId, toPartyId: 'B', amount: 900_000, date: '2026-09-05',
    }) as any);
    // Before the fix: +900,000 left in an ownerless account and −900,000 on the
    // cheque's own — the books balanced, but the trial balance did not.
    for (const v of custody(d).values()) expect(v).toBe(0);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
