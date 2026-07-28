/**
 * Structural guarantee: ONE transaction and ledger system.
 *
 * These tests don't check a feature — they check the architecture. Every
 * screen and report must derive its numbers from the same ledger, so no
 * disconnected calculation can creep back in.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  bankBalances, buildBankTransfer, buildCashPaid, buildCashReceived,
  buildCreditAdjustment, buildDebitAdjustment, buildExpense, buildIncome,
  buildPartyTransfer, buildPdcIssued, buildPdcReceived, buildPurchase, buildSale,
  cashBalance, computeProfit, computeSummary, ledgerIsBalanced, partyBalances,
  totalFunds, type Posting,
} from './pdcEngine';
import { buildChequeClear, buildChequeDeposit, buildChequeTransfer } from './chequeWorkflow';
import { buildBankLedger, buildPartyLedger, buildRegister, fundsDelta } from './pdcRegister';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed Traders', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Ali Enterprises', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'C', name: 'Nawaz Brothers', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 },
    ],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
    bankAccounts: [
      { id: 'ACC1', bankId: 'HBL', title: 'Main', openingBalance: 100000, active: true, createdAt: 1, updatedAt: 1 },
      { id: 'ACC2', bankId: 'HBL', title: 'Second', openingBalance: 50000, active: true, createdAt: 1, updatedAt: 1 },
    ],
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

/** Every kind of entry the software supports, in one dataset. */
function everything(): PdcDataSet {
  let d = seed();
  const D = '2026-07-01';
  d = apply(d, buildSale(d, { partyId: 'A', amount: 120000, date: D, settlement: 'credit' }));
  d = apply(d, buildSale(d, { partyId: 'B', amount: 45000, date: D, settlement: 'cash' }));
  d = apply(d, buildPurchase(d, { partyId: 'C', amount: 70000, date: D, settlement: 'credit' }));
  d = apply(d, buildPurchase(d, { partyId: 'A', amount: 20000, date: D, settlement: 'cash' }));
  d = apply(d, buildExpense(d, { amount: 15000, date: D, category: 'Rent' }));
  d = apply(d, buildIncome(d, { amount: 6000, date: D, category: 'Commission' }));
  d = apply(d, buildCashReceived(d, { partyId: 'A', amount: 30000, date: D }));
  d = apply(d, buildCashPaid(d, { partyId: 'C', amount: 10000, date: D }));
  d = apply(d, buildDebitAdjustment(d, { partyId: 'B', amount: 5000, date: D }));
  d = apply(d, buildCreditAdjustment(d, { partyId: 'C', amount: 8000, date: D }));
  d = apply(d, buildPartyTransfer(d, { fromPartyId: 'A', toPartyId: 'B', amount: 12000, date: D }));
  d = apply(d, buildBankTransfer(d, { fromBankAccountId: 'ACC1', toBankAccountId: 'ACC2', amount: 25000, date: D }));
  d = apply(d, buildPdcReceived(d, { partyId: 'A', bankId: 'HBL', chequeNumber: 'C1', chequeDate: '2026-08-01', amount: 90000, date: D }));
  d = apply(d, buildPdcIssued(d, { partyId: 'C', bankAccountId: 'ACC1', chequeNumber: 'C2', chequeDate: '2026-08-05', amount: 40000, date: D }));
  const c1 = d.cheques.find((c) => c.chequeNumber === 'C1')!;
  d = apply(d, buildChequeTransfer(d, { chequeId: c1.id, toPartyId: 'B', amount: 90000, date: D }));
  d = apply(d, buildPdcReceived(d, { partyId: 'C', bankId: 'HBL', chequeNumber: 'C3', chequeDate: '2026-08-09', amount: 33000, date: D }));
  const c3 = d.cheques.find((c) => c.chequeNumber === 'C3')!;
  d = apply(d, buildChequeDeposit(d, { chequeId: c3.id, bankAccountId: 'ACC1', date: D }));
  d = apply(d, buildChequeClear(d, { chequeId: c3.id, date: '2026-08-10' }));
  return d;
}

describe('one unified transaction + ledger system', () => {
  it('EVERY posting in the system is balanced', () => {
    expect(ledgerIsBalanced(everything())).toBe(true);
  });

  it('every ledger line belongs to a real transaction (no orphans)', () => {
    const d = everything();
    const ids = new Set(d.transactions.map((t) => t.id));
    for (const l of d.ledger) expect(ids.has(l.txnId)).toBe(true);
  });

  it('every transaction appears in the Cashbook register — nothing is hidden', () => {
    const d = everything();
    const shown = new Set(buildRegister(d).map((r) => r.txn.id));
    for (const t of d.transactions) expect(shown.has(t.id)).toBe(true);
    expect(shown.size).toBe(d.transactions.length);
  });

  it('every cheque movement points at a cheque that exists', () => {
    const d = everything();
    const ids = new Set(d.cheques.map((c) => c.id));
    for (const m of d.movements) expect(ids.has(m.chequeId)).toBe(true);
  });

  it('party sub-ledger balances match the summary receivable/payable totals', () => {
    const d = everything();
    const balances = partyBalances(d);

    // Each party's ledger, replayed independently, must equal its balance.
    for (const p of d.parties) {
      expect(buildPartyLedger(d, p.id).balance).toBe(balances.get(p.id));
    }

    // And those balances must roll up to exactly what the Cashbook cards show.
    let recv = 0, pay = 0;
    for (const v of balances.values()) { if (v > 0) recv += v; else pay += -v; }
    const s = computeSummary(d, '2026-07-27');
    expect(s.totalReceivable).toBe(recv);
    expect(s.totalPayable).toBe(pay);
  });

  it('bank sub-ledger balances match the summary bank total', () => {
    const d = everything();
    const banks = bankBalances(d);
    for (const a of d.bankAccounts) {
      expect(buildBankLedger(d, a.id).balance).toBe(banks.get(a.id));
    }
    const total = [...banks.values()].reduce((s, v) => s + v, 0);
    expect(computeSummary(d, '2026-07-27').bankBalance).toBe(total);
  });

  it('register running balance ends exactly at total funds (cash + banks)', () => {
    const d = everything();
    const reg = buildRegister(d);          // newest first
    expect(reg[0].running).toBe(totalFunds(d));
    // And total funds is cash + every bank account, nothing else.
    const banks = [...bankBalances(d).values()].reduce((s, v) => s + v, 0);
    expect(totalFunds(d)).toBe(cashBalance(d) + banks);
  });

  it('summary cards, profit engine and register all agree', () => {
    const d = everything();
    const s = computeSummary(d, '2026-07-27');
    const pl = computeProfit(d);
    expect(s.netProfit).toBe(pl.netProfit);
    expect(s.totalSales).toBe(pl.sales);
    expect(s.totalPurchases).toBe(pl.purchases);
    expect(s.totalExpenses).toBe(pl.expenses);
    expect(s.cashBalance).toBe(cashBalance(d));
    expect(s.totalFunds).toBe(totalFunds(d));
  });

  it('the sum of every row\'s funds effect equals the closing balance', () => {
    const d = everything();
    const summed = d.transactions.reduce((acc, t) => acc + fundsDelta(d, t), 0);
    const opening = d.bankAccounts.reduce((s, a) => s + a.openingBalance, 0);
    expect(Math.round(opening + summed)).toBe(Math.round(totalFunds(d)));
  });

  it('no cheque is ever duplicated, whatever happens to it', () => {
    const d = everything();
    const key = (c: { chequeNumber: string; bankId: string; direction: string }) =>
      `${c.direction}|${c.bankId}|${c.chequeNumber}`;
    const seen = new Set(d.cheques.map(key));
    expect(seen.size).toBe(d.cheques.length);
  });
});
