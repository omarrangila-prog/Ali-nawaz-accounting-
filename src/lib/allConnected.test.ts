/**
 * "Everything connected, everything at once."
 *
 * One entry must simultaneously update the register, both sides of the ledger,
 * the party balance, receivable/payable, the named-ledger roll-up, the summary
 * cards, the cheque list and the bank balance — all derived from one posting.
 *
 * These lock that in so a future change cannot quietly disconnect a screen.
 */
import { describe, it, expect } from 'vitest';
import type { PdcDataSet } from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  accountBalance, bankBalances, buildLedgerView, cashBalance, computeProfit,
  computeSummary, ledgerIsBalanced, partyAcc, partyBalances, totalFunds,
  buildSale, buildPdcReceived, buildExpense, type Posting,
} from './pdcEngine';
import { buildChequeDeposit, buildChequeClear } from './chequeWorkflow';
import { buildRegister, buildPartyLedger, buildBankLedger } from './pdcRegister';

function seed(): PdcDataSet {
  return {
    parties: [
      { id: 'A', name: 'Ahmed', openingBalance: 0, active: true, ledgerIds: ['L1'], createdAt: 1, updatedAt: 1 },
      { id: 'B', name: 'Bilal', openingBalance: 0, active: true, ledgerIds: ['L1'], createdAt: 1, updatedAt: 1 },
    ],
    ledgers: [{ id: 'L1', name: 'Najeeb', openingBalance: 0, active: true, createdAt: 1, updatedAt: 1 }],
    banks: [{ id: 'HBL', name: 'HBL', active: true, createdAt: 1, updatedAt: 1 }],
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

describe('one entry updates every view at once', () => {
  it('a credit sale reaches register, ledger, balance, roll-up and cards together', () => {
    const before = seed();
    const d = apply(before, buildSale(before, {
      partyId: 'A', amount: 77000, date: D, settlement: 'credit',
    }));

    // 1. Register
    expect(buildRegister(d)).toHaveLength(1);
    expect(buildRegister(d)[0].txn.type).toBe('Sale');
    // 2. Both ledger sides, sharing one transaction id
    const lines = d.ledger.filter((l) => l.txnId === d.transactions[0].id);
    expect(lines).toHaveLength(2);
    expect(ledgerIsBalanced(d)).toBe(true);
    // 3. Party balance
    expect(accountBalance(d, partyAcc('A'))).toBe(77000);
    // 4. Party sub-ledger agrees with that balance
    expect(buildPartyLedger(d, 'A').balance).toBe(77000);
    // 5. Named-ledger roll-up picks it up
    expect(buildLedgerView(d, 'L1')!.total).toBe(77000);
    // 6. Summary cards
    const s = computeSummary(d, '2026-07-27');
    expect(s.totalReceivable).toBe(77000);
    expect(s.totalSales).toBe(77000);
    expect(s.netProfit).toBe(computeProfit(d).netProfit);
    // 7. A credit sale must NOT move cash
    expect(cashBalance(d)).toBe(0);
    expect(s.totalFunds).toBe(totalFunds(d));
  });

  it('a cheque flows into the cheque list, party balance and cards at once', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 50000, date: D,
    }));

    expect(d.cheques).toHaveLength(1);                    // cheque list
    expect(d.movements).toHaveLength(1);                  // history started
    expect(accountBalance(d, partyAcc('A'))).toBe(-50000); // party settled
    const s = computeSummary(d, '2026-07-27');
    expect(s.pendingReceivedCheques).toBe(50000);         // card
    expect(s.totalCheques).toBe(50000);
    expect(bankBalances(d).get('ACC1')).toBe(0);          // not money yet
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('clearing a cheque moves bank, cards, bank ledger and register together', () => {
    let d = seed();
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C1',
      chequeDate: '2026-08-01', amount: 50000, date: D,
    }));
    const id = d.cheques[0].id;
    d = apply(d, buildChequeDeposit(d, { chequeId: id, bankAccountId: 'ACC1', date: D }));
    d = apply(d, buildChequeClear(d, { chequeId: id, date: '2026-08-02' }));

    expect(bankBalances(d).get('ACC1')).toBe(50000);      // bank
    expect(buildBankLedger(d, 'ACC1').balance).toBe(50000); // bank sub-ledger
    expect(computeSummary(d, '2026-08-03').bankBalance).toBe(50000); // card
    expect(buildRegister(d)[0].running).toBe(50000);      // register balance
    expect(d.cheques[0].status).toBe('cleared');          // cheque list
    expect(ledgerIsBalanced(d)).toBe(true);
  });

  it('every view stays reconciled across a mix of entries', () => {
    let d = seed();
    d = apply(d, buildSale(d, { partyId: 'A', amount: 120000, date: D, settlement: 'credit' }));
    d = apply(d, buildSale(d, { partyId: 'B', amount: 45000, date: D, settlement: 'cash' }));
    d = apply(d, buildExpense(d, { amount: 15000, date: D, category: 'Rent' }));
    d = apply(d, buildPdcReceived(d, {
      partyId: 'A', bankId: 'HBL', chequeNumber: 'C9',
      chequeDate: '2026-09-01', amount: 60000, date: D,
    }));

    const balances = partyBalances(d);
    // Each party's sub-ledger equals its computed balance.
    for (const p of d.parties) {
      expect(buildPartyLedger(d, p.id).balance).toBe(balances.get(p.id));
    }
    // Those balances roll up to exactly what the cards show.
    let recv = 0, pay = 0;
    for (const v of balances.values()) { if (v > 0) recv += v; else pay += -v; }
    const s = computeSummary(d, '2026-07-27');
    expect(s.totalReceivable).toBe(recv);
    expect(s.totalPayable).toBe(pay);
    // The named ledger totals its members.
    const view = buildLedgerView(d, 'L1')!;
    expect(view.partiesTotal).toBe(
      (balances.get('A') ?? 0) + (balances.get('B') ?? 0)
    );
    // Register closing balance equals real funds.
    expect(buildRegister(d)[0].running).toBe(totalFunds(d));
    // Profit engine and cards agree.
    expect(s.netProfit).toBe(computeProfit(d).netProfit);
    expect(ledgerIsBalanced(d)).toBe(true);
  });
});
