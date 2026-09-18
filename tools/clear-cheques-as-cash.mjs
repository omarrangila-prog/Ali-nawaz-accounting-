/**
 * Mark specific RECEIVED cheques as paid in cash.
 *
 * Posts exactly what the app's "Receive as Cash" button posts, so the result is
 * indistinguishable from having clicked it:
 *
 *     Dr Cash in Hand
 *     Cr PDC Received (that cheque's custody account)
 *
 * The party is deliberately untouched — they settled when they handed the
 * cheque over. Only WHERE the value sits changes. The cheque keeps its id,
 * number and history, and gains a "Received as cash" movement.
 *
 *   node tools/clear-cheques-as-cash.mjs --dry     preview, writes nothing
 *   node tools/clear-cheques-as-cash.mjs --yes     apply
 *   node tools/clear-cheques-as-cash.mjs --restore undo the last run
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';

/** The cheque numbers to mark as paid in cash. */
const NUMBERS = ['12165219', '12165220'];
const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const BACKUP = HERE('./clear-cheques-backup.json');

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
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toUpperCase();
const fmt = (n) => Math.round(n).toLocaleString();
const arg = (f) => process.argv.includes(f);
const cashOf = (ledger) => ledger.reduce((s, l) =>
  l.account?.kind === 'cash' && l.account?.id === 'CASH' ? s + (l.debit || 0) - (l.credit || 0) : s, 0);

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const c of b.cheques) await setDoc(doc(db, ...P, 'pdcCheques', c.id), c);
  for (const id of b.created.txns) await deleteDoc(doc(db, ...P, 'pdcTransactions', id));
  for (const id of b.created.lines) await deleteDoc(doc(db, ...P, 'pdcLedger', id));
  for (const id of b.created.movements) await deleteDoc(doc(db, ...P, 'pdcMovements', id));
  console.log(`restored ${b.cheques.length} cheque(s); removed the entries this script created`);
  console.log(`cash in hand is now ${fmt(cashOf(await load('pdcLedger')))}`);
}

async function run(dry) {
  const [cheques, txns, ledger, parties] = await Promise.all(
    ['pdcCheques', 'pdcTransactions', 'pdcLedger', 'pdcParties'].map(load));
  const pName = new Map(parties.map((p) => [p.id, p.name]));

  const targets = [];
  for (const num of NUMBERS) {
    const c = cheques.find((x) => String(x.chequeNumber).trim() === num);
    if (!c) { console.log(`#${num}: NOT FOUND — skipped`); continue; }
    if (c.direction !== 'received') { console.log(`#${num}: issued, not received — skipped`); continue; }
    // Only a cheque still in hand can become cash; anything else has moved on.
    if (!['pending', 'deposited', 'presented'].includes(c.status)) {
      console.log(`#${num}: already ${c.status} — skipped`); continue;
    }
    targets.push(c);
  }
  if (targets.length === 0) { console.log('\nnothing to do.'); return; }

  const cash = cashOf(ledger);
  console.log(`\ncash in hand    : ${fmt(cash)}`);
  for (const c of targets)
    console.log(`  #${c.chequeNumber}  ${fmt(c.amount)}  ${pName.get(c.partyId) || ''}  ${c.status} -> cleared (cash)`);
  console.log(`cash afterwards : ${fmt(cash + targets.reduce((s, c) => s + c.amount, 0))}`);

  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  // Continue the CLR-###### sequence rather than restarting it.
  let seq = txns.filter((t) => /^CLR-/.test(t.reference || ''))
    .reduce((mx, t) => Math.max(mx, Number(t.reference.slice(4)) || 0), 0);

  const created = { txns: [], lines: [], movements: [] };
  const before = targets.map((c) => ({ ...c }));

  for (const c of targets) {
    const when = Date.now();
    const date = c.chequeDate || c.date;
    const [y, mo] = date.split('-').map(Number);
    const ref = `CLR-${String(++seq).padStart(6, '0')}`;
    const desc = `Cheque ${c.chequeNumber} received as cash`;
    const txnId = uid();

    const txn = {
      id: txnId, reference: ref, type: 'Cheque Cleared', date, month: mo, year: y,
      amount: c.amount, partyId: c.partyId, chequeId: c.id,
      paymentMethod: 'cash', description: desc, createdAt: when, updatedAt: when,
    };
    const l1 = {
      id: uid(), txnId, date, month: mo, year: y, type: 'Cheque Cleared',
      account: { kind: 'cash', id: `PDC:${c.id}` }, mainLedger: 'PDC Received',
      debit: 0, credit: c.amount, chequeId: c.id, description: desc, createdAt: when,
    };
    const l2 = {
      id: uid(), txnId, date, month: mo, year: y, type: 'Cheque Cleared',
      account: { kind: 'cash', id: 'CASH' }, mainLedger: 'Cash',
      debit: c.amount, credit: 0, chequeId: c.id, relatedPartyId: c.partyId,
      description: desc, createdAt: when,
    };
    const mv = {
      id: uid(), chequeId: c.id, at: when, date, action: 'Received as cash',
      fromStatus: c.status, toStatus: 'cleared',
      fromHolder: c.holder ?? { kind: 'business' }, toHolder: { kind: 'business' },
      txnId, reference: ref, description: desc,
    };

    // Ledger lines first: a failure then leaves no transaction without effect.
    await setDoc(doc(db, ...P, 'pdcLedger', l1.id), l1);
    await setDoc(doc(db, ...P, 'pdcLedger', l2.id), l2);
    await setDoc(doc(db, ...P, 'pdcMovements', mv.id), mv);
    await setDoc(doc(db, ...P, 'pdcTransactions', txn.id), txn);
    await setDoc(doc(db, ...P, 'pdcCheques', c.id), {
      ...c, status: 'cleared', holder: { kind: 'business' }, updatedAt: when,
    });

    created.txns.push(txn.id);
    created.lines.push(l1.id, l2.id);
    created.movements.push(mv.id);
    console.log(`  #${c.chequeNumber} -> cleared as cash, ${ref}`);
  }

  if (!existsSync(BACKUP)) {
    writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), cheques: before, created }, null, 2));
  }
  console.log(`\ncash in hand is now ${fmt(cashOf(await load('pdcLedger')))}`);
}

if (arg('--restore')) await restore();
else await run(!arg('--yes'));
process.exit(0);
