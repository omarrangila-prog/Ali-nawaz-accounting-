/**
 * Delete a cheque entered in error, and everything it created.
 *
 * Removes the same records the app's own Delete removes: the transaction, its
 * ledger lines, the cheque, and the cheque's movement history. Nothing is left
 * behind to keep the books balanced around a half-deleted entry.
 *
 * This DOES change the party's balance, and it should: deleting a receipt says
 * the money never arrived, so whatever it settled becomes owing again.
 *
 *   node tools/delete-cheque-entry.mjs --dry      preview, writes nothing
 *   node tools/delete-cheque-entry.mjs --yes      delete
 *   node tools/delete-cheque-entry.mjs --restore  put it all back
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';

/** Cheque numbers entered in error. */
const NUMBERS = ['12165220'];
const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const BACKUP = HERE('./deleted-cheques-backup.json');

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
const arg = (f) => process.argv.includes(f);

const partyBalance = (ledger, parties, pid) => {
  const p = parties.find((x) => x.id === pid);
  return ledger.reduce((s, l) =>
    l.account?.kind === 'party' && l.account?.id === pid ? s + (l.debit || 0) - (l.credit || 0) : s,
    p?.openingBalance || 0);
};
const cashOf = (ledger) => ledger.reduce((s, l) =>
  l.account?.kind === 'cash' && l.account?.id === 'CASH' ? s + (l.debit || 0) - (l.credit || 0) : s, 0);

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const x of b.cheques) await setDoc(doc(db, ...P, 'pdcCheques', x.id), x);
  for (const x of b.transactions) await setDoc(doc(db, ...P, 'pdcTransactions', x.id), x);
  for (const x of b.ledgerLines) await setDoc(doc(db, ...P, 'pdcLedger', x.id), x);
  for (const x of b.movements) await setDoc(doc(db, ...P, 'pdcMovements', x.id), x);
  console.log(`restored ${b.cheques.length} cheque(s), ${b.transactions.length} transaction(s), ` +
              `${b.ledgerLines.length} ledger line(s), ${b.movements.length} movement(s)`);
}

async function run(dry) {
  const [cheques, txns, ledger, movements, parties] = await Promise.all(
    ['pdcCheques', 'pdcTransactions', 'pdcLedger', 'pdcMovements', 'pdcParties'].map(load));
  const pName = new Map(parties.map((p) => [p.id, p.name]));

  const hitCheques = [], hitTxns = [], hitLines = [], hitMoves = [];
  for (const num of NUMBERS) {
    const c = cheques.find((x) => String(x.chequeNumber).trim() === num);
    if (!c) { console.log(`#${num}: NOT FOUND — skipped`); continue; }
    // A cheque handed on or already banked has a life beyond this entry;
    // deleting it would contradict records that depend on it.
    if (!['pending', 'cancelled'].includes(c.status)) {
      console.log(`#${num}: status is ${c.status} — reverse that first, not deleted`);
      continue;
    }
    const ts = txns.filter((t) => t.chequeId === c.id);
    hitCheques.push(c);
    hitTxns.push(...ts);
    hitLines.push(...ledger.filter((l) => ts.some((t) => t.id === l.txnId)));
    hitMoves.push(...movements.filter((m) => m.chequeId === c.id));

    const bal = partyBalance(ledger, parties, c.partyId);
    console.log(`#${num}  ${fmt(c.amount)}  ${pName.get(c.partyId) || ''}  ${c.status}`);
    console.log(`   removes: ${ts.length} transaction(s) (${ts.map((t) => t.reference).join(', ')}), ` +
                `${hitLines.length} ledger line(s), ${hitMoves.length} movement(s)`);
    console.log(`   ${pName.get(c.partyId)} balance: ${fmt(bal)} -> ${fmt(bal + c.amount)}  (the money never arrived, so it is owing again)`);
  }
  if (hitCheques.length === 0) { console.log('\nnothing to do.'); return; }
  console.log(`\ncash in hand stays ${fmt(cashOf(ledger))} — a pending cheque never touched cash`);

  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  if (!existsSync(BACKUP)) {
    writeFileSync(BACKUP, JSON.stringify({
      takenAt: new Date().toISOString(),
      cheques: hitCheques, transactions: hitTxns, ledgerLines: hitLines, movements: hitMoves,
    }, null, 2));
    console.log('backup written to deleted-cheques-backup.json');
  }

  // Lines first, then the transaction: at no point is a visible entry left
  // without its money effect.
  for (const l of hitLines) await deleteDoc(doc(db, ...P, 'pdcLedger', l.id));
  for (const t of hitTxns) await deleteDoc(doc(db, ...P, 'pdcTransactions', t.id));
  for (const m of hitMoves) await deleteDoc(doc(db, ...P, 'pdcMovements', m.id));
  for (const c of hitCheques) await deleteDoc(doc(db, ...P, 'pdcCheques', c.id));

  const after = await load('pdcLedger');
  for (const c of hitCheques)
    console.log(`\n#${c.chequeNumber} deleted. ${pName.get(c.partyId)} balance is now ` +
                `${fmt(partyBalance(after, parties, c.partyId))}`);
}

if (arg('--restore')) await restore();
else await run(!arg('--yes'));
process.exit(0);
