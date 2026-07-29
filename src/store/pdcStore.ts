/**
 * Ali Nawaz PDC — data store
 *
 * Owns the PDC collections and turns engine postings into writes. Everything
 * financial goes through `commit()`, which:
 *   • re-asserts the posting is balanced before anything is written
 *   • writes the ledger lines FIRST, then the header transaction, so a partial
 *     failure can never leave a visible transaction with no ledger effect
 *   • guards against double-submit (spec §28: "saving while Firestore is still
 *     processing the previous request")
 */

import { create } from 'zustand';
import type {
  Bank,
  BankAccount,
  Cheque,
  ChequeMovement,
  PdcAuditLog,
  PdcDataSet,
  PdcLedgerEntry,
  PdcParty,
  NamedLedger,
  PdcSettings,
  PdcTransaction,
  ChequeAllocation,
  AuditAction,
} from '@/types/pdc';
import { DEFAULT_PDC_SETTINGS } from '@/types/pdc';
import {
  subscribeCollection,
  upsertDoc,
  removeDoc,
  type CollectionName,
} from '@/firebase/dataAccess';
import {
  assertBalanced,
  partyDeleteImpact,
  partyDeleteTxnIds,
  ledgerDeleteImpact,
  type Posting,
} from '@/lib/pdcEngine';
import type { PdcBackup } from '@/lib/pdcBackup';
import { buildReversal } from '@/lib/chequeWorkflow';
import { uid, now, todayISO } from '@/lib/utils';
import { toast } from './toast';

interface PdcStore {
  uidRef: string | null;
  ready: boolean;
  /** True while a commit is in flight — blocks duplicate saves. */
  saving: boolean;

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

  bind: (workspace: string) => void;
  unbind: () => void;
  dataset: () => PdcDataSet;

  /** Write a balanced posting atomically-as-possible. Returns success. */
  commit: (posting: Posting, opts?: { action?: AuditAction; reason?: string }) => Promise<boolean>;
  /** Reverse a posted transaction (spec §26). */
  reverse: (txnId: string, reason?: string) => Promise<boolean>;
  /**
   * Permanently remove a transaction and everything it created: its ledger
   * lines, and — for a cheque entry — the cheque and its movement history.
   * Unlike reverse(), nothing is left behind. Used for entries typed by
   * mistake, where a correcting entry would just be noise.
   */
  deleteTransaction: (txnId: string, reason?: string) => Promise<boolean>;

  // masters
  saveParty: (p: Partial<PdcParty> & { name: string; id?: string }) => Promise<PdcParty | null>;
  saveLedger: (l: Partial<NamedLedger> & { name: string; id?: string }) => Promise<NamedLedger | null>;
  deleteLedger: (id: string) => Promise<boolean>;
  setPartyLedgers: (partyId: string, ledgerIds: string[]) => Promise<void>;
  deleteParty: (id: string) => Promise<boolean>;
  saveBank: (b: Partial<Bank> & { name: string; id?: string }) => Promise<Bank | null>;
  saveBankAccount: (a: Partial<BankAccount> & { bankId: string; title: string; id?: string }) => Promise<BankAccount | null>;
  saveCheque: (c: Cheque) => Promise<void>;
  updateSettings: (patch: Partial<PdcSettings>) => Promise<void>;
  logAudit: (entry: Omit<PdcAuditLog, 'id' | 'at' | 'date' | 'user'>) => Promise<void>;

  /**
   * Correct a posted transaction: reverse the original, then post the
   * corrected version. Both stay in history and the audit trail records the
   * change, so books are never silently rewritten.
   */
  editTransaction: (txnId: string, corrected: Posting, reason?: string) => Promise<boolean>;
  /** Edit a cheque's own details (number, dates, drawer…) with an audit entry. */
  updateChequeDetails: (chequeId: string, patch: Partial<Cheque>, reason?: string) => Promise<boolean>;
  /** Replace every record from a backup file. Destructive — asks nothing. */
  restoreBackup: (backup: PdcBackup) => Promise<{ ok: boolean; written: number }>;
}

const COLLECTIONS: Record<string, CollectionName> = {
  parties: 'pdcParties',
  ledgers: 'pdcLedgers',
  banks: 'pdcBanks',
  bankAccounts: 'pdcBankAccounts',
  cheques: 'pdcCheques',
  transactions: 'pdcTransactions',
  ledger: 'pdcLedger',
  movements: 'pdcMovements',
  allocations: 'pdcAllocations',
  audit: 'pdcAudit',
};

let unsubs: Array<() => void> = [];

export const usePdc = create<PdcStore>((set, get) => ({
  uidRef: null,
  ready: false,
  saving: false,

  parties: [],
  ledgers: [],
  banks: [],
  bankAccounts: [],
  cheques: [],
  transactions: [],
  ledger: [],
  movements: [],
  allocations: [],
  audit: [],
  settings: { ...DEFAULT_PDC_SETTINGS, updatedAt: now() },

  bind(workspace) {
    get().unbind();
    set({ uidRef: workspace, ready: false });

    for (const [key, coll] of Object.entries(COLLECTIONS)) {
      unsubs.push(
        subscribeCollection<any>(workspace, coll, (rows) => {
          set({ [key]: rows } as any);
        })
      );
    }
    // Settings is a singleton document in its own collection.
    unsubs.push(
      subscribeCollection<PdcSettings>(workspace, 'pdcSettings', (rows) => {
        const s = rows.find((r) => r.id === 'pdcSettings');
        set({ settings: s ?? { ...DEFAULT_PDC_SETTINGS, updatedAt: now() }, ready: true });
      })
    );
  },

  unbind() {
    unsubs.forEach((u) => u());
    unsubs = [];
    set({ uidRef: null, ready: false });
  },

  dataset() {
    const s = get();
    return {
      parties: s.parties,
      ledgers: s.ledgers,
      banks: s.banks,
      bankAccounts: s.bankAccounts,
      cheques: s.cheques,
      transactions: s.transactions,
      ledger: s.ledger,
      movements: s.movements,
      allocations: s.allocations,
      audit: s.audit,
      settings: s.settings,
    };
  },

  async commit(posting, opts = {}) {
    const s = get();
    const workspace = s.uidRef;
    if (!workspace) {
      toast.error('Not connected — cannot save.');
      return false;
    }
    // Spec §28: never let a double-click or held Enter post twice.
    if (s.saving) return false;

    try {
      // Belt and braces: the builders already assert, but a posting could have
      // been assembled by hand. Never write an unbalanced set of lines.
      if (posting.lines.length > 0) assertBalanced(posting.lines);
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }

    set({ saving: true });
    try {
      // Ledger lines first: if the run dies midway, the register won't show a
      // transaction whose money effect never landed.
      for (const line of posting.lines) {
        await upsertDoc(workspace, 'pdcLedger', line);
      }
      if (posting.cheque) {
        await upsertDoc(workspace, 'pdcCheques', posting.cheque);
      }
      for (const m of posting.movements) {
        await upsertDoc(workspace, 'pdcMovements', m);
      }
      await upsertDoc(workspace, 'pdcTransactions', posting.txn);

      await get().logAudit({
        action: opts.action ?? 'create',
        entity: 'transaction',
        entityId: posting.txn.id,
        txnId: posting.txn.id,
        after: { reference: posting.txn.reference, type: posting.txn.type, amount: posting.txn.amount },
        reason: opts.reason,
        description: `${posting.txn.type} ${posting.txn.reference}`,
      });
      return true;
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
      return false;
    } finally {
      set({ saving: false });
    }
  },

  async reverse(txnId, reason) {
    const s = get();
    const workspace = s.uidRef;
    if (!workspace) return false;
    if (s.saving) return false;

    const res = buildReversal(s.dataset(), txnId, todayISO(), reason);
    if ('error' in res) {
      toast.error(res.error);
      return false;
    }
    const original = s.transactions.find((t) => t.id === txnId);
    const ok = await get().commit(
      { txn: res.txn, lines: res.lines, movements: [] },
      { action: 'reverse', reason }
    );
    if (ok && original) {
      // Mark the original so it can't be reversed twice and shows as reversed.
      await upsertDoc(workspace, 'pdcTransactions', {
        ...original,
        reversed: true,
        reversedByTxnId: res.txn.id,
        updatedAt: now(),
      });
      toast.success(`Reversed ${original.reference}`);
    }
    return ok;
  },

  async saveParty(p) {
    const workspace = get().uidRef;
    if (!workspace) return null;
    const name = p.name.trim();
    if (!name) {
      toast.error('Party name is required.');
      return null;
    }
    const existing = p.id ? get().parties.find((x) => x.id === p.id) : undefined;
    // Names must stay unique so the searchable dropdown is unambiguous.
    const clash = get().parties.find(
      (x) => x.id !== p.id && x.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      toast.error(`A party named "${name}" already exists.`);
      return null;
    }
    const rec: PdcParty = {
      id: p.id ?? uid(),
      name,
      // Keep existing ledger assignments unless explicitly changed.
      ledgerIds: p.ledgerIds ?? existing?.ledgerIds ?? [],
      phone: p.phone,
      address: p.address,
      cnic: p.cnic,
      openingBalance: p.openingBalance ?? existing?.openingBalance ?? 0,
      creditLimit: p.creditLimit,
      paymentTerms: p.paymentTerms,
      notes: p.notes,
      active: p.active ?? existing?.active ?? true,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await upsertDoc(workspace, 'pdcParties', rec);
    // Renaming must not touch transactions — they reference party IDs (§20/§31.8).
    if (existing && existing.name !== rec.name) {
      await get().logAudit({
        action: 'party-rename',
        entity: 'party',
        entityId: rec.id,
        before: { name: existing.name },
        after: { name: rec.name },
        description: `Renamed ${existing.name} → ${rec.name}`,
      });
    }
    return rec;
  },

  /**
   * Delete a party and EVERYTHING attached to it: its transactions, their
   * ledger lines, and any cheques it drew along with their history.
   *
   * This is a genuine erase, not a deactivation — the confirm dialog states
   * the counts first so the scale of it is never a surprise.
   */
  async deleteParty(id) {
    const s = get();
    const workspace = s.uidRef;
    if (!workspace) return false;
    if (s.saving) return false;

    const party = s.parties.find((p) => p.id === id);
    if (!party) return false;

    const data = s.dataset();
    const impact = partyDeleteImpact(data, id);
    const txnIds = new Set(partyDeleteTxnIds(data, id));
    const chequeIds = new Set(s.cheques.filter((c) => c.partyId === id).map((c) => c.id));

    set({ saving: true });
    try {
      // Record what is about to go before it goes.
      await get().logAudit({
        action: 'delete',
        entity: 'party',
        entityId: id,
        before: { name: party.name, ...impact },
        description:
          `Deleted party ${party.name} with ${impact.transactions} transaction(s), ` +
          `${impact.cheques} cheque(s)`,
      });

      // Transactions first so nothing is briefly visible without its effect.
      for (const txnId of txnIds) {
        await removeDoc(workspace, 'pdcTransactions', txnId);
      }
      for (const line of s.ledger.filter((l) => txnIds.has(l.txnId))) {
        await removeDoc(workspace, 'pdcLedger', line.id);
      }
      for (const m of s.movements.filter((mv) => chequeIds.has(mv.chequeId))) {
        await removeDoc(workspace, 'pdcMovements', m.id);
      }
      for (const cid of chequeIds) {
        await removeDoc(workspace, 'pdcCheques', cid);
      }
      for (const a of s.allocations.filter((al) => chequeIds.has(al.chequeId) || al.partyId === id)) {
        await removeDoc(workspace, 'pdcAllocations', a.id);
      }
      await removeDoc(workspace, 'pdcParties', id);

      toast.success(
        impact.clean
          ? `Deleted ${party.name}`
          : `Deleted ${party.name} and ${impact.transactions} transaction(s)`
      );
      return true;
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
      return false;
    } finally {
      set({ saving: false });
    }
  },

  async saveLedger(l) {
    const workspace = get().uidRef;
    if (!workspace) return null;
    const name = l.name.trim();
    if (!name) {
      toast.error('Ledger name is required.');
      return null;
    }
    const existing = l.id ? get().ledgers.find((x) => x.id === l.id) : undefined;
    const clash = get().ledgers.find(
      (x) => x.id !== l.id && x.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (clash) {
      toast.error(`A ledger named "${name}" already exists.`);
      return null;
    }
    const rec: NamedLedger = {
      id: l.id ?? uid(),
      name,
      description: l.description,
      openingBalance: l.openingBalance ?? existing?.openingBalance ?? 0,
      active: l.active ?? existing?.active ?? true,
      notes: l.notes,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await upsertDoc(workspace, 'pdcLedgers', rec);
    if (existing && existing.name !== rec.name) {
      await get().logAudit({
        action: 'edit',
        entity: 'ledger',
        entityId: rec.id,
        before: { name: existing.name },
        after: { name: rec.name },
        description: `Renamed ledger ${existing.name} → ${rec.name}`,
      });
    }
    return rec;
  },

  /**
   * Delete a named ledger and any entries posted DIRECTLY to it.
   *
   * Its parties are only unlinked, never deleted — they are real trading
   * relationships that exist independently of how you grouped them, and they
   * may well belong to another ledger too.
   */
  async deleteLedger(id) {
    const s = get();
    const workspace = s.uidRef;
    if (!workspace) return false;
    if (s.saving) return false;

    const ledger = s.ledgers.find((x) => x.id === id);
    if (!ledger) return false;

    const impact = ledgerDeleteImpact(s.dataset(), id);
    const txnIds = new Set(
      s.ledger.filter((e) => e.account.kind === 'ledger' && e.account.id === id).map((e) => e.txnId)
    );

    set({ saving: true });
    try {
      await get().logAudit({
        action: 'delete',
        entity: 'ledger',
        entityId: id,
        before: { name: ledger.name, ...impact },
        description: `Deleted ledger ${ledger.name} with ${impact.transactions} own entry(ies)`,
      });

      for (const txnId of txnIds) {
        await removeDoc(workspace, 'pdcTransactions', txnId);
      }
      for (const line of s.ledger.filter((l) => txnIds.has(l.txnId))) {
        await removeDoc(workspace, 'pdcLedger', line.id);
      }
      // Unlink the parties — they keep their own balances and history.
      for (const p of s.parties) {
        if ((p.ledgerIds ?? []).includes(id)) {
          await upsertDoc(workspace, 'pdcParties', {
            ...p,
            ledgerIds: (p.ledgerIds ?? []).filter((x) => x !== id),
            updatedAt: now(),
          });
        }
      }
      await removeDoc(workspace, 'pdcLedgers', id);
      toast.success(`Deleted ${ledger.name}`);
      return true;
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
      return false;
    } finally {
      set({ saving: false });
    }
  },

  async setPartyLedgers(partyId, ledgerIds) {
    const workspace = get().uidRef;
    if (!workspace) return;
    const party = get().parties.find((p) => p.id === partyId);
    if (!party) return;
    await upsertDoc(workspace, 'pdcParties', { ...party, ledgerIds, updatedAt: now() });
    await get().logAudit({
      action: 'edit',
      entity: 'party',
      entityId: partyId,
      before: { ledgerIds: party.ledgerIds ?? [] },
      after: { ledgerIds },
      description: `Ledger assignment changed for ${party.name}`,
    });
  },

  async saveBank(b) {
    const workspace = get().uidRef;
    if (!workspace) return null;
    const name = b.name.trim();
    if (!name) { toast.error('Bank name is required.'); return null; }
    const existing = b.id ? get().banks.find((x) => x.id === b.id) : undefined;
    const rec: Bank = {
      id: b.id ?? uid(),
      name,
      active: b.active ?? existing?.active ?? true,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await upsertDoc(workspace, 'pdcBanks', rec);
    return rec;
  },

  async saveBankAccount(a) {
    const workspace = get().uidRef;
    if (!workspace) return null;
    const title = a.title.trim();
    if (!title) { toast.error('Account title is required.'); return null; }
    const existing = a.id ? get().bankAccounts.find((x) => x.id === a.id) : undefined;
    const rec: BankAccount = {
      id: a.id ?? uid(),
      bankId: a.bankId,
      title,
      accountNumber: a.accountNumber,
      iban: a.iban,
      branch: a.branch,
      openingBalance: a.openingBalance ?? existing?.openingBalance ?? 0,
      active: a.active ?? existing?.active ?? true,
      notes: a.notes,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await upsertDoc(workspace, 'pdcBankAccounts', rec);
    return rec;
  },

  async saveCheque(c) {
    const workspace = get().uidRef;
    if (!workspace) return;
    await upsertDoc(workspace, 'pdcCheques', { ...c, updatedAt: now() });
  },

  async updateSettings(patch) {
    const workspace = get().uidRef;
    if (!workspace) return;
    const next: PdcSettings = { ...get().settings, ...patch, id: 'pdcSettings', updatedAt: now() };
    await upsertDoc(workspace, 'pdcSettings', next);
    set({ settings: next });
  },

  async deleteTransaction(txnId, reason) {
    const s = get();
    const workspace = s.uidRef;
    if (!workspace) {
      toast.error('Not connected — cannot delete.');
      return false;
    }
    if (s.saving) return false;

    const txn = s.transactions.find((t) => t.id === txnId);
    if (!txn) {
      toast.error('Transaction not found.');
      return false;
    }

    // A cheque that has moved on — endorsed, cleared, bounced — has later
    // entries depending on it. Deleting the entry that created it would leave
    // those orphaned, so that case must be reversed instead.
    const cheque = txn.chequeId ? s.cheques.find((c) => c.id === txn.chequeId) : undefined;
    // Only entries that came AFTER this one depend on it. Deleting the most
    // recent entry on a cheque is always safe; deleting an earlier one would
    // orphan everything that followed.
    const dependents = cheque
      ? s.transactions.filter(
          (t) =>
            t.chequeId === cheque.id &&
            t.id !== txnId &&
            (t.date > txn.date || (t.date === txn.date && t.createdAt > txn.createdAt))
        )
      : [];
    if (dependents.length > 0) {
      toast.error(
        `Cheque ${cheque!.chequeNumber} has ${dependents.length} later entr${dependents.length === 1 ? 'y' : 'ies'} against it. Delete the most recent one first, or reverse this entry instead.`
      );
      return false;
    }
    // Deleting the entry that CREATED the cheque removes the cheque itself.
    // A later entry (endorsement, clearing) only removes that entry.
    const isCreatingEntry =
      !!cheque && (txn.type === 'PDC Received' || txn.type === 'PDC Issued');

    set({ saving: true });
    try {
      // Record what is about to disappear BEFORE deleting, so the audit trail
      // still explains it afterwards.
      await get().logAudit({
        action: 'delete',
        entity: 'transaction',
        entityId: txnId,
        txnId,
        before: {
          reference: txn.reference,
          type: txn.type,
          amount: txn.amount,
          date: txn.date,
          chequeNumber: cheque?.chequeNumber,
        },
        reason,
        description: `Deleted ${txn.type} ${txn.reference}`,
      });

      // Header first: the row vanishes from the register immediately, so a
      // failure part-way through can never show an entry whose money effect
      // has already gone.
      await removeDoc(workspace, 'pdcTransactions', txnId);
      for (const line of s.ledger.filter((l) => l.txnId === txnId)) {
        await removeDoc(workspace, 'pdcLedger', line.id);
      }
      if (cheque && isCreatingEntry) {
        // This entry brought the cheque into existence — remove it and its
        // whole history.
        for (const m of s.movements.filter((mv) => mv.chequeId === cheque.id)) {
          await removeDoc(workspace, 'pdcMovements', m.id);
        }
        await removeDoc(workspace, 'pdcCheques', cheque.id);
      } else if (cheque) {
        // A later action on an existing cheque: drop just this action's
        // movement rows, and roll the cheque back to how it was before.
        for (const m of s.movements.filter((mv) => mv.txnId === txnId)) {
          await removeDoc(workspace, 'pdcMovements', m.id);
        }
        const undone = s.movements.find((mv) => mv.txnId === txnId);
        if (undone?.fromStatus) {
          await upsertDoc(workspace, 'pdcCheques', {
            ...cheque,
            status: undone.fromStatus,
            holder: undone.fromHolder ?? cheque.holder,
            updatedAt: now(),
          });
        }
      }
      toast.success(`Deleted ${txn.reference}`);
      return true;
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
      return false;
    } finally {
      set({ saving: false });
    }
  },

  async editTransaction(txnId, corrected, reason) {
    const s = get();
    if (!s.uidRef || s.saving) return false;
    const original = s.transactions.find((t) => t.id === txnId);
    if (!original) {
      toast.error('Transaction not found.');
      return false;
    }
    if (original.reversed) {
      toast.error('That entry was already reversed — edit the correcting entry instead.');
      return false;
    }

    // Reverse first. If this fails nothing else is written, so the books are
    // never left holding both the wrong figure and the corrected one.
    const undone = await get().reverse(txnId, reason || `Edited: ${original.reference}`);
    if (!undone) return false;

    const posted = await get().commit(corrected, {
      action: 'edit',
      reason: reason || `Correction of ${original.reference}`,
    });
    if (!posted) {
      toast.error('Reversal saved but the correction failed — re-enter it to finish.');
      return false;
    }

    await get().logAudit({
      action: 'edit',
      entity: 'transaction',
      entityId: txnId,
      txnId: corrected.txn.id,
      before: { reference: original.reference, type: original.type, amount: original.amount },
      after: { reference: corrected.txn.reference, type: corrected.txn.type, amount: corrected.txn.amount },
      reason,
      description: `${original.reference} corrected → ${corrected.txn.reference}`,
    });
    toast.success(`Corrected ${original.reference}`);
    return true;
  },

  async updateChequeDetails(chequeId, patch, reason) {
    const workspace = get().uidRef;
    if (!workspace) return false;
    const cheque = get().cheques.find((c) => c.id === chequeId);
    if (!cheque) {
      toast.error('Cheque not found.');
      return false;
    }
    // Changing the amount of a cleared cheque would break the posting that
    // already moved the money — that needs a reversal, not an edit.
    if (patch.amount !== undefined && patch.amount !== cheque.amount && cheque.status === 'cleared') {
      toast.error('This cheque has cleared. Reverse the clearing entry before changing its amount.');
      return false;
    }
    const next: Cheque = { ...cheque, ...patch, id: cheque.id, updatedAt: now() };
    await upsertDoc(workspace, 'pdcCheques', next);
    await get().logAudit({
      action: 'edit',
      entity: 'cheque',
      entityId: chequeId,
      before: { chequeNumber: cheque.chequeNumber, amount: cheque.amount, chequeDate: cheque.chequeDate },
      after: { chequeNumber: next.chequeNumber, amount: next.amount, chequeDate: next.chequeDate },
      reason,
      description: `Cheque ${cheque.chequeNumber} details edited`,
    });
    toast.success('Cheque updated');
    return true;
  },

  async restoreBackup(backup) {
    const workspace = get().uidRef;
    if (!workspace) return { ok: false, written: 0 };

    const d = backup.data;
    const plan: Array<[CollectionName, any[]]> = [
      ['pdcParties', d.parties ?? []],
      ['pdcLedgers', d.ledgers ?? []],
      ['pdcBanks', d.banks ?? []],
      ['pdcBankAccounts', d.bankAccounts ?? []],
      ['pdcCheques', d.cheques ?? []],
      ['pdcLedger', d.ledger ?? []],
      ['pdcMovements', d.movements ?? []],
      ['pdcAllocations', d.allocations ?? []],
      ['pdcAudit', d.audit ?? []],
      // Transactions last: a header is only visible once its ledger lines exist.
      ['pdcTransactions', d.transactions ?? []],
    ];

    set({ saving: true });
    let written = 0;
    try {
      for (const [coll, rows] of plan) {
        for (const row of rows) {
          if (!row?.id) continue;
          await upsertDoc(workspace, coll, row);
          written++;
        }
      }
      if (d.settings) {
        await upsertDoc(workspace, 'pdcSettings', { ...d.settings, id: 'pdcSettings' });
      }
      await get().logAudit({
        action: 'edit',
        entity: 'backup',
        entityId: 'restore',
        description: `Restored backup taken ${backup.takenAt} (${written} records)`,
      });
      return { ok: true, written };
    } catch (e) {
      toast.error(`Restore failed after ${written} records: ${(e as Error).message}`);
      return { ok: false, written };
    } finally {
      set({ saving: false });
    }
  },

  async logAudit(entry) {
    const workspace = get().uidRef;
    if (!workspace) return;
    const rec: PdcAuditLog = {
      id: uid(),
      at: now(),
      date: todayISO(),
      user: get().settings.businessName || 'user',
      ...entry,
    };
    await upsertDoc(workspace, 'pdcAudit', rec);
  },
}));
