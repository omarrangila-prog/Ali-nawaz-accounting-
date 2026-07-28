/**
 * Ali Nawaz — backup, export and restore.
 *
 * Two distinct jobs, deliberately kept separate:
 *
 *   • JSON backup  — a complete, exact copy of every record. Machine-readable
 *     and restorable. This is your safety net if Firebase is lost or something
 *     is deleted by mistake.
 *
 *   • Excel export — a readable workbook, one sheet per area, for looking at
 *     the books outside the app. NOT restorable: it is formatted for humans,
 *     so amounts are rounded for display and internal ids are omitted.
 */

import type {
  Bank, BankAccount, Cheque, ChequeAllocation, ChequeMovement, NamedLedger,
  PdcAuditLog, PdcDataSet, PdcLedgerEntry, PdcParty, PdcSettings, PdcTransaction,
} from '@/types/pdc';
import { exportWorkbook, type Sheet } from './exportExcel';
import {
  bankAccountLabel, bankBalances, buildAllLedgerViews, computeProfit,
  computeSummary, holderLabel, partyBalances, partyName, balanceLabel,
} from './pdcEngine';
import { buildRegister } from './pdcRegister';
import { formatDate, todayISO } from './utils';

/** Bumped whenever the shape changes, so a restore can refuse a newer file. */
export const BACKUP_VERSION = 1;

export interface PdcBackup {
  version: number;
  /** ISO timestamp the backup was taken. */
  takenAt: string;
  businessName: string;
  /** Row counts, so a restore can report what it is about to write. */
  counts: Record<string, number>;
  data: {
    parties: PdcParty[];
    ledgers: NamedLedger[];
    banks: Bank[];
    bankAccounts: BankAccount[];
    cheques: Cheque[];
    transactions: PdcTransaction[];
    ledger: PdcLedgerEntry[];
    movements: ChequeMovement[];
    allocations: ChequeAllocation[];
    audit: PdcAuditLog[];
    settings: PdcSettings;
  };
}

// ---------------------------------------------------------------------------
// JSON backup — exact, restorable
// ---------------------------------------------------------------------------

export function buildBackup(data: PdcDataSet): PdcBackup {
  return {
    version: BACKUP_VERSION,
    takenAt: new Date().toISOString(),
    businessName: data.settings.businessName || 'Ali Nawaz',
    counts: {
      parties: data.parties.length,
      ledgers: data.ledgers.length,
      banks: data.banks.length,
      bankAccounts: data.bankAccounts.length,
      cheques: data.cheques.length,
      transactions: data.transactions.length,
      ledgerEntries: data.ledger.length,
      movements: data.movements.length,
      allocations: data.allocations.length,
      audit: data.audit.length,
    },
    data: {
      parties: data.parties,
      ledgers: data.ledgers,
      banks: data.banks,
      bankAccounts: data.bankAccounts,
      cheques: data.cheques,
      transactions: data.transactions,
      ledger: data.ledger,
      movements: data.movements,
      allocations: data.allocations,
      audit: data.audit,
      settings: data.settings,
    },
  };
}

/** Trigger a download of the JSON backup. */
export function downloadBackup(data: PdcDataSet): string {
  const backup = buildBackup(data);
  const name = `ali-nawaz-backup-${todayISO()}.json`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}

/** Problems found while validating a backup file, before anything is written. */
export interface RestoreCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  backup?: PdcBackup;
}

/**
 * Validate a parsed backup file. Deliberately strict: a restore overwrites
 * live books, so anything questionable is reported before a single write.
 */
export function validateBackup(raw: unknown): RestoreCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['That file is not a valid backup.'], warnings };
  }
  const b = raw as Partial<PdcBackup>;

  if (typeof b.version !== 'number') errors.push('Missing backup version.');
  else if (b.version > BACKUP_VERSION) {
    errors.push(
      `This backup was made by a newer version of the app (v${b.version}). Update the app first.`
    );
  }
  if (!b.data || typeof b.data !== 'object') errors.push('Backup contains no data.');

  if (errors.length === 0 && b.data) {
    const d = b.data;
    const required = ['parties', 'cheques', 'transactions', 'ledger'] as const;
    for (const k of required) {
      if (!Array.isArray((d as any)[k])) errors.push(`Backup is missing "${k}".`);
    }

    if (errors.length === 0) {
      // Every ledger line must belong to a transaction in the same file.
      const txnIds = new Set(d.transactions.map((t) => t.id));
      const orphans = d.ledger.filter((l) => !txnIds.has(l.txnId)).length;
      if (orphans > 0) warnings.push(`${orphans} ledger line(s) reference a missing transaction.`);

      // Every posting must still balance.
      const byTxn = new Map<string, PdcLedgerEntry[]>();
      for (const l of d.ledger) {
        const list = byTxn.get(l.txnId);
        if (list) list.push(l);
        else byTxn.set(l.txnId, [l]);
      }
      let unbalanced = 0;
      for (const rows of byTxn.values()) {
        const dr = rows.reduce((s, r) => s + (r.debit || 0), 0);
        const cr = rows.reduce((s, r) => s + (r.credit || 0), 0);
        if (Math.abs(dr - cr) > 0.005) unbalanced++;
      }
      if (unbalanced > 0) warnings.push(`${unbalanced} posting(s) in this backup do not balance.`);

      if (d.transactions.length === 0) warnings.push('This backup contains no transactions.');
    }
  }

  return { ok: errors.length === 0, errors, warnings, backup: errors.length === 0 ? (b as PdcBackup) : undefined };
}

// ---------------------------------------------------------------------------
// Excel export — readable, one sheet per area
// ---------------------------------------------------------------------------

export function exportExcel(data: PdcDataSet): string {
  const cur = data.settings.currency;
  const today = todayISO();
  const money = (n: number) => Number((n ?? 0).toFixed(2));
  const sheets: Sheet[] = [];

  // --- Summary ---
  const s = computeSummary(data, today);
  const pl = computeProfit(data);
  sheets.push({
    name: 'Summary',
    rows: [
      [`${data.settings.businessName || 'Ali Nawaz'} — Accounts Summary`],
      [`Exported ${new Date().toLocaleString()}`],
      [],
      ['Figure', `Amount (${cur})`],
      ['Total Money (cash + banks)', money(s.totalFunds)],
      ['Cash in Hand', money(s.cashBalance)],
      ['In Bank', money(s.bankBalance)],
      ['Receivable', money(s.totalReceivable)],
      ['Payable', money(s.totalPayable)],
      [],
      ['Cheques to Receive', money(s.pendingReceivedCheques)],
      ['Cheques to Pay', money(s.pendingIssuedCheques)],
      ['Due Today', money(s.dueToday)],
      ['Overdue', money(s.overdue)],
      ['Bounced', money(s.bounced)],
      [],
      ['Sales', money(pl.sales)],
      ['Other Income', money(pl.otherIncome)],
      ['Purchases', money(pl.purchases)],
      ['Expenses', money(pl.expenses)],
      ['NET PROFIT', money(pl.netProfit)],
    ],
  });

  // --- Cash Book register ---
  const reg = buildRegister(data);
  sheets.push({
    name: 'Cash Book',
    rows: [
      ['Date', 'Reference', 'Type', 'Party', 'To Party', 'Cheque #', 'Description',
        'Debit', 'Credit', 'Balance', 'Status', 'Reversed'],
      ...reg.map((r) => [
        r.txn.date, r.txn.reference, r.txn.type, r.partyName, r.toPartyName,
        r.cheque?.chequeNumber ?? '', r.txn.description ?? '',
        money(r.debit), money(r.credit), money(r.running),
        r.status ?? '', r.txn.reversed ? 'YES' : '',
      ]),
    ],
  });

  // --- Cheques ---
  sheets.push({
    name: 'Cheques',
    rows: [
      ['Direction', 'Cheque #', 'Party', 'Bank', 'Entry Date', 'Cheque Date',
        'Amount', 'Status', 'Held By', 'Allocated', 'Bounce Reason'],
      ...data.cheques
        .slice()
        .sort((a, b) => a.chequeDate.localeCompare(b.chequeDate))
        .map((c) => [
          c.direction, c.chequeNumber, partyName(data, c.partyId),
          data.banks.find((b) => b.id === c.bankId)?.name ?? '',
          c.date, c.chequeDate, money(c.amount), c.status,
          holderLabel(data, c.holder), money(c.allocatedAmount || 0),
          c.bounceReason ?? '',
        ]),
    ],
  });

  // --- Parties, with balances ---
  const balances = partyBalances(data);
  sheets.push({
    name: 'Parties',
    rows: [
      ['Party', 'Opening', 'Balance', 'Status', 'Ledgers', 'Notes', 'Active'],
      ...data.parties
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => {
          const bal = balances.get(p.id) ?? 0;
          return [
            p.name, money(p.openingBalance), money(Math.abs(bal)), balanceLabel(bal),
            (p.ledgerIds ?? [])
              .map((id) => data.ledgers.find((l) => l.id === id)?.name)
              .filter(Boolean).join(', '),
            p.notes ?? '', p.active ? 'Yes' : 'No',
          ];
        }),
    ],
  });

  // --- Named ledgers ---
  const views = buildAllLedgerViews(data);
  const ledgerRows: (string | number)[][] = [
    ['Ledger', 'Party', 'Balance', 'Status', 'Shared With'],
  ];
  for (const v of views) {
    ledgerRows.push([v.ledger.name, '(own balance)', money(v.ownBalance), '', '']);
    for (const r of v.parties) {
      ledgerRows.push([
        v.ledger.name, r.party.name, money(r.balance),
        balanceLabel(r.balance), r.sharedWith.join(', '),
      ]);
    }
    ledgerRows.push([`${v.ledger.name} TOTAL`, '', money(v.total), '', '']);
    ledgerRows.push([]);
  }
  if (views.length > 0) sheets.push({ name: 'Ledgers', rows: ledgerRows });

  // --- Bank accounts ---
  const bankBals = bankBalances(data);
  sheets.push({
    name: 'Bank Accounts',
    rows: [
      ['Bank', 'Account', 'Account #', 'Branch', 'Opening', 'Balance'],
      ...data.bankAccounts.map((a) => [
        data.banks.find((b) => b.id === a.bankId)?.name ?? '',
        a.title, a.accountNumber ?? '', a.branch ?? '',
        money(a.openingBalance), money(bankBals.get(a.id) ?? 0),
      ]),
    ],
  });

  // --- Full double-entry ledger (the raw accounting record) ---
  const accountLabel = (l: PdcLedgerEntry) => {
    switch (l.account.kind) {
      case 'party': return partyName(data, l.account.id);
      case 'bank': return bankAccountLabel(data.banks, data.bankAccounts, l.account.id);
      case 'ledger': return data.ledgers.find((x) => x.id === l.account.id)?.name ?? l.account.id;
      case 'cash':
        if (l.account.id === 'CASH') return 'Cash in Hand';
        if (l.account.id === 'ADJ') return 'Adjustments';
        if (l.account.id.startsWith('NOM:')) return l.account.id.slice(4);
        if (l.account.id.startsWith('PDC:')) return 'Cheque in hand';
        if (l.account.id.startsWith('PDCI:')) return 'Cheque outstanding';
        return l.account.id;
    }
  };
  const refOf = new Map(data.transactions.map((t) => [t.id, t.reference]));
  sheets.push({
    name: 'Ledger Entries',
    rows: [
      ['Date', 'Reference', 'Type', 'Account', 'Main Ledger', 'Description', 'Debit', 'Credit'],
      ...data.ledger
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
        .map((l) => [
          l.date, refOf.get(l.txnId) ?? '', l.type, accountLabel(l), l.mainLedger,
          l.description, money(l.debit), money(l.credit),
        ]),
    ],
  });

  // --- Cheque movement history ---
  if (data.movements.length > 0) {
    const chNo = new Map(data.cheques.map((c) => [c.id, c.chequeNumber]));
    sheets.push({
      name: 'Cheque History',
      rows: [
        ['Date', 'Cheque #', 'Action', 'From Status', 'To Status', 'To Party', 'Reference'],
        ...data.movements
          .slice()
          .sort((a, b) => a.at - b.at)
          .map((m) => [
            m.date, chNo.get(m.chequeId) ?? '', m.action,
            m.fromStatus ?? '', m.toStatus ?? '',
            partyName(data, m.toPartyId), m.reference ?? '',
          ]),
      ],
    });
  }

  // --- Audit trail ---
  if (data.audit.length > 0) {
    sheets.push({
      name: 'Audit Trail',
      rows: [
        ['Date / Time', 'User', 'Action', 'Entity', 'Description', 'Reason'],
        ...data.audit
          .slice()
          .sort((a, b) => b.at - a.at)
          .map((a) => [
            new Date(a.at).toLocaleString(), a.user, a.action, a.entity,
            a.description ?? '', a.reason ?? '',
          ]),
      ],
    });
  }

  const name = `ali-nawaz-books-${today}.xlsx`;
  exportWorkbook(name, sheets);
  return name;
}

/** Human-readable summary of what a backup holds, for the restore dialog. */
export function describeBackup(b: PdcBackup): string {
  const c = b.counts ?? {};
  const bits = [
    `${c.transactions ?? 0} transactions`,
    `${c.cheques ?? 0} cheques`,
    `${c.parties ?? 0} parties`,
  ];
  return `${formatDate(b.takenAt.slice(0, 10))} · ${bits.join(' · ')}`;
}
