/**
 * ONE-OFF MIGRATION — rewrite every "Cash Paid" entry as "Cash Received".
 *
 * Use only if those entries were money coming IN that was recorded with the Pay
 * button by mistake. It swaps each posting's sides:
 *
 *     before   Dr Party / Cr Cash     (party owes you, cash goes down)
 *     after    Dr Cash  / Cr Party    (you owe the party, cash goes up)
 *
 * Both sides are swapped together, so the books stay balanced either way.
 *
 * Run a dry run FIRST:   node tools/flip-pay-to-receive.mjs --dry
 * Then for real:         node tools/flip-pay-to-receive.mjs --yes
 * To put it all back:    node tools/flip-pay-to-receive.mjs --restore
 *
 * tools/flip-backup.json holds the 102 transactions and 204 ledger lines
 * exactly as they were before any change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc } from 'firebase/firestore';

const WORKSPACE = 'bond-workspace';
const BACKUP = fileURLToPath(new URL('./flip-backup.json', import.meta.url));

// Read the web config straight from .env so no keys live in this file.
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8')
    .split('\n').filter((l) => l.startsWith('VITE_FIREBASE'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })
);
const db = getFirestore(initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
}));

const P = [ 'users', WORKSPACE ];
const load = async (c) => (await getDocs(collection(db, ...P, c))).docs.map((d) => ({ id: d.id, ...d.data() }));
const money = (n) => Math.round(n * 100) / 100;
const arg = (f) => process.argv.includes(f);

async function cashInHand() {
  const ledger = await load('pdcLedger');
  return money(ledger.reduce((s, l) =>
    l.account?.kind === 'cash' && l.account?.id === 'CASH' ? s + (l.debit || 0) - (l.credit || 0) : s, 0));
}

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const t of b.transactions) await setDoc(doc(db, ...P, 'pdcTransactions', t.id), t);
  for (const l of b.ledgerLines) await setDoc(doc(db, ...P, 'pdcLedger', l.id), l);
  console.log(`restored ${b.transactions.length} transactions and ${b.ledgerLines.length} ledger lines`);
  console.log(`cash in hand is now ${(await cashInHand()).toLocaleString()}`);
}

async function flip(dry) {
  const [txns, ledger] = await Promise.all([load('pdcTransactions'), load('pdcLedger')]);
  const pays = txns.filter((t) => t.type === 'Cash Paid');
  const ids = new Set(pays.map((t) => t.id));
  const lines = ledger.filter((l) => ids.has(l.txnId));
  const total = money(pays.reduce((s, t) => s + t.amount, 0));
  const cash = await cashInHand();

  console.log(`entries to flip : ${pays.length}`);
  console.log(`their total     : ${total.toLocaleString()}`);
  console.log(`cash in hand    : ${cash.toLocaleString()}`);
  console.log(`cash afterwards : ${money(cash + 2 * total).toLocaleString()}`);

  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  // Keep a fresh snapshot so --restore always undoes the LAST run.
  writeFileSync(BACKUP, JSON.stringify(
    { takenAt: new Date().toISOString(), transactions: pays, ledgerLines: lines }, null, 2));

  for (const t of pays) {
    await setDoc(doc(db, ...P, 'pdcTransactions', t.id), {
      ...t, type: 'Cash Received', paymentMethod: 'cash',
      fromBankAccountId: null, toBankAccountId: t.fromBankAccountId ?? null,
      updatedAt: Date.now(),
    });
  }
  for (const l of lines) {
    await setDoc(doc(db, ...P, 'pdcLedger', l.id), { ...l, debit: l.credit || 0, credit: l.debit || 0 });
  }
  console.log(`\nflipped ${pays.length} transactions and ${lines.length} ledger lines`);
  console.log(`cash in hand is now ${(await cashInHand()).toLocaleString()}`);
}

if (arg('--restore')) await restore();
else if (arg('--yes')) await flip(false);
else await flip(true);
process.exit(0);
