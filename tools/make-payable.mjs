/**
 * ONE-OFF MIGRATION — turn the 102 flipped entries into PAYABLE obligations.
 *
 * Those entries began as "Cash Paid", were flipped to "Cash Received", and
 * neither is what they are. They record that the business OWES the party — an
 * obligation, with no money changing hands.
 *
 *     now        Dr Cash        / Cr Party    (cash up, party payable)
 *     after      Dr Adjustments / Cr Party    (party payable, cash untouched)
 *
 * Only the cash side is rewritten, so the party keeps its payable balance and
 * the posting stays balanced. Cash moves ONCE rather than twice — which is the
 * doubling that made the figure wrong.
 *
 *   node tools/make-payable.mjs --dry     preview, writes nothing
 *   node tools/make-payable.mjs --yes     apply
 *   node tools/make-payable.mjs --restore put back what this script changed
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc } from 'firebase/firestore';

const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const SOURCE = HERE('./flip-backup.json');   // the original 102, by id
const BACKUP = HERE('./make-payable-backup.json');

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
const m = (n) => Math.round(n * 100) / 100;
const fmt = (n) => m(n).toLocaleString();
const arg = (f) => process.argv.includes(f);

const cashOf = (ledger) => m(ledger.reduce((s, l) =>
  l.account?.kind === 'cash' && l.account?.id === 'CASH' ? s + (l.debit || 0) - (l.credit || 0) : s, 0));

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const t of b.transactions) await setDoc(doc(db, ...P, 'pdcTransactions', t.id), t);
  for (const l of b.ledgerLines) await setDoc(doc(db, ...P, 'pdcLedger', l.id), l);
  console.log(`restored ${b.transactions.length} transactions and ${b.ledgerLines.length} ledger lines`);
  console.log(`cash in hand is now ${fmt(cashOf(await load('pdcLedger')))}`);
}

async function run(dry) {
  const targetIds = new Set(JSON.parse(readFileSync(SOURCE, 'utf8')).transactions.map((t) => t.id));
  const [txns, ledger] = await Promise.all([load('pdcTransactions'), load('pdcLedger')]);

  const hits = txns.filter((t) => targetIds.has(t.id));
  const lines = ledger.filter((l) => targetIds.has(l.txnId));
  // Only the CASH side changes; the party line already carries the payable.
  const cashLines = lines.filter((l) => l.account?.kind === 'cash' && l.account?.id === 'CASH');
  const total = m(cashLines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0));
  const cash = cashOf(ledger);

  const done = hits.filter((t) => t.type === 'Credit Adjustment').length;
  const onAdj = lines.filter((l) => l.account?.kind === 'cash' && l.account?.id === 'ADJ').length;
  console.log(`entries        : ${hits.length}  (${done} already converted)`);
  console.log(`cash lines     : ${cashLines.length} left on CASH, ${onAdj} already on ADJ`);
  console.log(`  totalling    : ${fmt(total)}`);
  console.log(`cash in hand   : ${fmt(cash)}`);
  console.log(`cash afterwards: ${fmt(cash - total)}   (moves once, not twice)`);

  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  if (!existsSync(BACKUP)) {
    writeFileSync(BACKUP, JSON.stringify(
      { takenAt: new Date().toISOString(), transactions: hits, ledgerLines: lines }, null, 2));
    console.log('backup written');
  } else {
    console.log('backup already exists — kept, so the original state is not lost');
  }

  for (const t of hits) {
    await setDoc(doc(db, ...P, 'pdcTransactions', t.id), {
      ...t, type: 'Credit Adjustment',
      // No money changes hands, so no method and no bank account apply.
      paymentMethod: null, fromBankAccountId: null, toBankAccountId: null,
      updatedAt: Date.now(),
    });
  }
  for (const l of cashLines) {
    await setDoc(doc(db, ...P, 'pdcLedger', l.id), {
      ...l, account: { kind: 'cash', id: 'ADJ' }, mainLedger: 'Adjustments',
    });
  }
  console.log(`\nconverted ${hits.length} entries to payable obligations`);
  console.log(`cash in hand is now ${fmt(cashOf(await load('pdcLedger')))}`);
}

if (arg('--restore')) await restore();
else await run(!arg('--yes'));
process.exit(0);
