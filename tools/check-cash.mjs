/**
 * Read-only check: is any money counted twice?
 *
 * Looks for the three ways cash can double without the books going out of
 * balance:
 *   1. a transaction carrying more ledger lines than its amount (old lines left
 *      behind when it was edited, or the same posting saved twice);
 *   2. two transactions that are the same entry saved twice;
 *   3. the same ledger line stored under two ids.
 *
 *   node tools/check-cash.mjs
 *
 * Writes nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const env = Object.fromEntries(
  readFileSync(HERE('../.env'), 'utf8').split('\n')
    .filter((l) => l.startsWith('VITE_FIREBASE'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })
);
const db = getFirestore(initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID, storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID, appId: env.VITE_FIREBASE_APP_ID,
}));
const P = ['users', WORKSPACE];
const load = async (c) => (await getDocs(collection(db, ...P, c))).docs.map((d) => ({ id: d.id, ...d.data() }));
const fmt = (n) => Math.round(n).toLocaleString();
const isCash = (l) => l.account?.kind === 'cash' && l.account?.id === 'CASH';

const [txns, ledger, parties, bankAccounts] = await Promise.all(
  ['pdcTransactions', 'pdcLedger', 'pdcParties', 'pdcBankAccounts'].map(load));
const pName = new Map(parties.map((p) => [p.id, p.name]));
const byTxn = new Map();
for (const l of ledger) {
  if (!byTxn.has(l.txnId)) byTxn.set(l.txnId, []);
  byTxn.get(l.txnId).push(l);
}

const cash = ledger.filter(isCash).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
console.log(`transactions ${txns.length}, ledger lines ${ledger.length}`);
console.log(`cash in hand ${fmt(cash)}`);
console.log(`bank opening balances ${fmt(bankAccounts.reduce((s, a) => s + (a.openingBalance || 0), 0))}`);

// 1. More posted than the entry is worth.
console.log('\n1. entries whose ledger lines add up to more than the entry:');
let n1 = 0;
for (const t of txns) {
  const lines = byTxn.get(t.id) ?? [];
  const debits = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cashMove = lines.filter(isCash).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  if (t.amount && debits > t.amount * 1.001 + 0.5) {
    n1++;
    console.log(`  ${t.date} ${t.reference} ${t.type} ${pName.get(t.partyId) ?? ''} amount ${fmt(t.amount)} ` +
      `but ${lines.length} lines debit ${fmt(debits)}; cash effect ${fmt(cashMove)}` +
      `${t.reversed ? ' [reversed]' : ''}${t.editedAt || t.updatedAt !== t.createdAt ? ' [edited]' : ''}`);
  }
}
if (!n1) console.log('  none');

// 2. The same entry saved twice.
console.log('\n2. entries that look saved twice (same type, party, amount, date):');
const seen = new Map();
let n2 = 0;
for (const t of [...txns].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
  if (t.type === 'Reversal') continue;
  const k = [t.type, t.partyId ?? '', t.amount, t.date, t.chequeId ?? ''].join('|');
  if (seen.has(k)) {
    const o = seen.get(k);
    const gap = Math.round(((t.createdAt ?? 0) - (o.createdAt ?? 0)) / 1000);
    n2++;
    console.log(`  ${t.date} ${t.type} ${pName.get(t.partyId) ?? ''} ${fmt(t.amount)}: ` +
      `${o.reference} and ${t.reference}, saved ${gap}s apart` +
      `${(t.description || '') === (o.description || '') ? ', same description' : ''}`);
  } else seen.set(k, t);
}
if (!n2) console.log('  none');

// 3. One ledger line stored twice.
console.log('\n3. ledger lines stored twice:');
const lineKey = new Map();
let n3 = 0;
for (const l of ledger) {
  const k = [l.txnId, l.account?.kind, l.account?.id, l.debit || 0, l.credit || 0, l.chequeId ?? ''].join('|');
  if (lineKey.has(k)) { n3++; console.log(`  txn ${l.txnId}: ${l.account?.kind}:${l.account?.id} ${fmt(l.debit || l.credit)} (${lineKey.get(k)} and ${l.id})`); }
  else lineKey.set(k, l.id);
}
if (!n3) console.log('  none');

// Where the cash comes from, by entry type.
console.log('\ncash by entry type:');
const byType = new Map();
const tById = new Map(txns.map((t) => [t.id, t]));
for (const l of ledger.filter(isCash)) {
  const ty = tById.get(l.txnId)?.type ?? '(no entry)';
  const cur = byType.get(ty) ?? { in: 0, out: 0, n: 0 };
  cur.in += l.debit || 0; cur.out += l.credit || 0; cur.n++;
  byType.set(ty, cur);
}
for (const [ty, v] of byType) console.log(`  ${ty.padEnd(20)} in ${fmt(v.in).padStart(14)}  out ${fmt(v.out).padStart(14)}  (${v.n} lines)`);
process.exit(0);
