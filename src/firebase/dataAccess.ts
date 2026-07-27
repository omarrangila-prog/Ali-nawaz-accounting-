/**
 * Unified collection API. Every business collection lives under
 * users/{uid}/{collection}. This module hides whether we're talking to real
 * Firestore or the localStorage mock so the services layer stays simple.
 */
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
  getDocs,
  writeBatch,
} from 'firebase/firestore';
import { db, USE_MOCK } from './config';
import { mockDb } from './mock';

export type CollectionName =
  | 'parties'
  | 'bondTypes'
  | 'purchases'
  | 'sales'
  | 'cashTransactions'
  | 'ledgerEntries'
  | 'monthlyClosings'
  | 'settings'
  | 'fileAccounts'
  | 'expenseCategories'
  | 'expenses'
  | 'stockAdjustments'
  | 'partyAdjustments'
  | 'openingBalances'
  // --- Ali Nawaz PDC module. Deliberately separate collections so the cheque /
  // double-entry ledger data never mixes with the bond-trading records above.
  | 'pdcParties'
  | 'pdcBanks'
  | 'pdcBankAccounts'
  | 'pdcCheques'
  | 'pdcTransactions'
  | 'pdcLedger'
  | 'pdcMovements'
  | 'pdcAllocations'
  | 'pdcAudit'
  | 'pdcSettings';

function path(uid: string, name: CollectionName) {
  return collection(db!, 'users', uid, name);
}

/**
 * Firestore rejects fields whose value is `undefined` (e.g. an optional `note`
 * or `phone` left blank). Recursively drop those keys before writing.
 */
function stripUndefined<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(stripUndefined) as any;
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = v && typeof v === 'object' ? stripUndefined(v) : v;
    }
    return out;
  }
  return obj;
}

export function subscribeCollection<T>(
  uid: string,
  name: CollectionName,
  cb: (rows: T[]) => void
): () => void {
  if (USE_MOCK) {
    return mockDb.subscribe(uid, name, (docs) => cb(docs as T[]));
  }
  return onSnapshot(path(uid, name), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as T[]);
  });
}

export async function upsertDoc<T extends { id: string }>(
  uid: string,
  name: CollectionName,
  data: T
): Promise<void> {
  if (USE_MOCK) {
    mockDb.set(uid, name, data as any);
    return;
  }
  await setDoc(doc(db!, 'users', uid, name, data.id), stripUndefined(data) as any, { merge: true });
}

export async function removeDoc(
  uid: string,
  name: CollectionName,
  id: string
): Promise<void> {
  if (USE_MOCK) {
    mockDb.remove(uid, name, id);
    return;
  }
  await deleteDoc(doc(db!, 'users', uid, name, id));
}

export async function listOnce<T>(uid: string, name: CollectionName): Promise<T[]> {
  if (USE_MOCK) return mockDb.list(uid, name) as T[];
  const snap = await getDocs(path(uid, name));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as T[];
}

/** Bulk import used by Excel migration. */
export async function bulkUpsert<T extends { id: string }>(
  uid: string,
  name: CollectionName,
  rows: T[]
): Promise<void> {
  if (USE_MOCK) {
    rows.forEach((r) => mockDb.set(uid, name, r as any));
    return;
  }
  // Firestore batches cap at 500 ops.
  for (let i = 0; i < rows.length; i += 450) {
    const batch = writeBatch(db!);
    rows.slice(i, i + 450).forEach((r) => {
      batch.set(doc(db!, 'users', uid, name, r.id), stripUndefined(r) as any, { merge: true });
    });
    await batch.commit();
  }
}
