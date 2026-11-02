/**
 * Remove cheques left behind by a deleted entry.
 *
 * Deleting a Receive or Pay entry that carried a cheque used to leave the
 * cheque record behind, still "pending". No entry refers to it and the books
 * hold nothing for it, yet it kept counting in Total Cheques and the cheque
 * lists. This removes exactly those: a cheque with NO entry pointing at it and
 * nothing in its cheque account. A cheque that any entry still uses is never
 * touched.
 *
 *   node tools/remove-leftover-cheques.mjs --dry      show what would go
 *   node tools/remove-leftover-cheques.mjs --yes      remove them
 *   node tools/remove-leftover-cheques.mjs --restore  put them back
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';

const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const BACKUP = HERE('./remove-leftover-cheques-backup.json');

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

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const x of b.cheques) await setDoc(doc(db, ...P, 'pdcCheques', x.id), x);
  for (const x of b.movements) await setDoc(doc(db, ...P, 'pdcMovements', x.id), x);
  console.log(`restored ${b.cheques.length} cheque(s) and ${b.movements.length} movement(s)`);
}

async function run(dry) {
  const [txns, ledger, cheques, movements, parties] = await Promise.all(
    ['pdcTransactions', 'pdcLedger', 'pdcCheques', 'pdcMovements', 'pdcParties'].map(load));
  const pName = new Map(parties.map((p) => [p.id, p.name]));
  const used = new Set(txns.map((t) => t.chequeId).filter(Boolean));
  const held = new Map();
  for (const l of ledger) {
    const m = /^PDCI?:(.+)$/.exec(l.account?.id ?? '');
    if (m) held.set(m[1], (held.get(m[1]) ?? 0) + (l.debit || 0) - (l.credit || 0));
  }
  const leftover = cheques.filter((c) => !used.has(c.id) && Math.abs(held.get(c.id) ?? 0) < 1);
  const moves = movements.filter((m) => leftover.some((c) => c.id === m.chequeId));

  console.log(`cheques with no entry behind them : ${leftover.length}  (${fmt(leftover.reduce((s, c) => s + c.amount, 0))})`);
  for (const c of leftover) {
    const again = cheques.find((x) => x.id !== c.id && x.chequeNumber === c.chequeNumber && used.has(x.id));
    console.log(`  #${c.chequeNumber}  ${pName.get(c.partyId) ?? ''}  ${fmt(c.amount)}  ${c.status}` +
                `${again ? '   (entered again later — that copy stays)' : ''}`);
  }
  if (!leftover.length) { console.log('\nnothing to remove.'); return; }
  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  // Never overwrite an earlier backup.
  if (!existsSync(BACKUP)) {
    writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), cheques: leftover, movements: moves }, null, 2));
    console.log('\nbackup written to remove-leftover-cheques-backup.json');
  }
  for (const m of moves) await deleteDoc(doc(db, ...P, 'pdcMovements', m.id));
  for (const c of leftover) await deleteDoc(doc(db, ...P, 'pdcCheques', c.id));
  console.log(`\nremoved ${leftover.length} cheque(s). No entry, party, cash or bank balance changed.`);
}

if (arg('--restore')) await restore();
else await run(!arg('--yes'));
process.exit(0);
