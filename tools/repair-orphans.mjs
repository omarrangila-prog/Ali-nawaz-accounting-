/**
 * Repair a half-deleted posting.
 *
 * A ledger line whose transaction no longer exists is an unmatched debit or
 * credit: the books cannot balance while it is there, and it silently inflates
 * whatever account it sits on. This removes any such line, and puts right any
 * cheque left claiming a status its transaction no longer supports.
 *
 *   node tools/repair-orphans.mjs --dry      show what is wrong
 *   node tools/repair-orphans.mjs --yes      repair
 *   node tools/repair-orphans.mjs --restore  put back what was removed
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';

const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const BACKUP = HERE('./repair-orphans-backup.json');

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
const cashOf = (l) => l.reduce((s, x) =>
  x.account?.kind === 'cash' && x.account?.id === 'CASH' ? s + (x.debit || 0) - (x.credit || 0) : s, 0);
const totals = (l) => l.reduce((a, x) => ({ d: a.d + (x.debit || 0), c: a.c + (x.credit || 0) }), { d: 0, c: 0 });

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const x of b.ledgerLines) await setDoc(doc(db, ...P, 'pdcLedger', x.id), x);
  for (const x of b.cheques) await setDoc(doc(db, ...P, 'pdcCheques', x.id), x);
  for (const x of b.movements) await setDoc(doc(db, ...P, 'pdcMovements', x.id), x);
  console.log(`restored ${b.ledgerLines.length} line(s), ${b.cheques.length} cheque(s), ${b.movements.length} movement(s)`);
}

async function run(dry) {
  const [txns, ledger, cheques, movements, parties] = await Promise.all(
    ['pdcTransactions', 'pdcLedger', 'pdcCheques', 'pdcMovements', 'pdcParties'].map(load));
  const pName = new Map(parties.map((p) => [p.id, p.name]));
  const txnIds = new Set(txns.map((t) => t.id));

  const orphanLines = ledger.filter((l) => !txnIds.has(l.txnId));
  // A movement whose transaction is gone describes an event that no longer exists.
  const orphanMoves = movements.filter((m) => m.txnId && !txnIds.has(m.txnId));

  const before = totals(ledger);
  console.log(`book now      : debits ${fmt(before.d)}  credits ${fmt(before.c)}  ` +
              `${Math.round(before.d - before.c) === 0 ? 'balanced' : 'OUT BY ' + fmt(before.d - before.c)}`);
  console.log(`cash in hand  : ${fmt(cashOf(ledger))}`);
  console.log(`\norphan ledger lines : ${orphanLines.length}`);
  for (const l of orphanLines)
    console.log(`  ${l.date}  ${l.account?.kind}:${l.account?.id}  ` +
                `${l.debit ? 'Dr ' + fmt(l.debit) : 'Cr ' + fmt(l.credit)}  "${l.description || ''}"`);
  console.log(`orphan movements    : ${orphanMoves.length}`);

  // A cheque marked cleared with no clearing transaction left is stale: the
  // entry that cleared it is gone, so it is back to being held and unpaid.
  const clearedIds = new Set(txns.filter((t) => t.type === 'Cheque Cleared' && t.chequeId).map((t) => t.chequeId));
  const stale = cheques.filter((c) => c.status === 'cleared' && !clearedIds.has(c.id));
  console.log(`cheques marked cleared with no clearing entry : ${stale.length}`);
  for (const c of stale)
    console.log(`  #${c.chequeNumber}  ${fmt(c.amount)}  ${pName.get(c.partyId) || ''}  cleared -> pending`);

  const keptCash = cashOf(ledger.filter((l) => txnIds.has(l.txnId)));
  const after = totals(ledger.filter((l) => txnIds.has(l.txnId)));
  console.log(`\nafter repair  : debits ${fmt(after.d)}  credits ${fmt(after.c)}  ` +
              `${Math.round(after.d - after.c) === 0 ? 'BALANCED' : 'still out by ' + fmt(after.d - after.c)}`);
  console.log(`cash in hand  : ${fmt(keptCash)}`);

  if (orphanLines.length === 0 && orphanMoves.length === 0 && stale.length === 0) {
    console.log('\nnothing to repair.'); return;
  }
  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  if (!existsSync(BACKUP)) {
    writeFileSync(BACKUP, JSON.stringify({
      takenAt: new Date().toISOString(),
      ledgerLines: orphanLines, movements: orphanMoves, cheques: stale.map((c) => ({ ...c })),
    }, null, 2));
    console.log('\nbackup written to repair-orphans-backup.json');
  }

  for (const l of orphanLines) await deleteDoc(doc(db, ...P, 'pdcLedger', l.id));
  for (const m of orphanMoves) await deleteDoc(doc(db, ...P, 'pdcMovements', m.id));
  for (const c of stale) {
    await setDoc(doc(db, ...P, 'pdcCheques', c.id), {
      ...c, status: 'pending', holder: { kind: 'business' }, updatedAt: Date.now(),
    });
  }

  const fixed = await load('pdcLedger');
  const t2 = totals(fixed);
  console.log(`\nrepaired. book ${Math.round(t2.d - t2.c) === 0 ? 'BALANCED' : 'OUT BY ' + fmt(t2.d - t2.c)}` +
              `   cash in hand ${fmt(cashOf(fixed))}`);
}

if (arg('--restore')) await restore();
else await run(!arg('--yes'));
process.exit(0);
