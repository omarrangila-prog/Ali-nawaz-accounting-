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
import { assertBalanced, type Posting } from '@/lib/pdcEngine';
import { buildReversal } from '@/lib/chequeWorkflow';
import { uid, now, todayISO } from '@/lib/utils';
import { toast } from './toast';

interface PdcStore {
  uidRef: string | null;
  ready: boolean;
  /** True while a commit is in flight — blocks duplicate saves. */
  saving: boolean;

  parties: PdcParty[];
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

  // masters
  saveParty: (p: Partial<PdcParty> & { name: string; id?: string }) => Promise<PdcParty | null>;
  deleteParty: (id: string) => Promise<boolean>;
  saveBank: (b: Partial<Bank> & { name: string; id?: string }) => Promise<Bank | null>;
  saveBankAccount: (a: Partial<BankAccount> & { bankId: string; title: string; id?: string }) => Promise<BankAccount | null>;
  saveCheque: (c: Cheque) => Promise<void>;
  updateSettings: (patch: Partial<PdcSettings>) => Promise<void>;
  logAudit: (entry: Omit<PdcAuditLog, 'id' | 'at' | 'date' | 'user'>) => Promise<void>;
}

const COLLECTIONS: Record<string, CollectionName> = {
  parties: 'pdcParties',
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

  async deleteParty(id) {
    const workspace = get().uidRef;
    if (!workspace) return false;
    // A party with any ledger history must never vanish — deactivate instead.
    const used = get().ledger.some((l) => l.account.kind === 'party' && l.account.id === id)
      || get().cheques.some((c) => c.partyId === id);
    if (used) {
      const p = get().parties.find((x) => x.id === id);
      if (p) {
        await upsertDoc(workspace, 'pdcParties', { ...p, active: false, updatedAt: now() });
        toast.info('Party has transactions — marked inactive instead of deleted.');
      }
      return false;
    }
    await removeDoc(workspace, 'pdcParties', id);
    return true;
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
