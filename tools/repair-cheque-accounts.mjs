/**
 * Put each cheque's money back in its own account.
 *
 * Editing a cheque entry used to post the corrected lines to a NEW cheque
 * account while the cheque itself kept its old id. The receipt then sat in an
 * account no cheque owns, and the cheque's later clearing or transfer was
 * posted to its real account — so each such cheque showed +amount in one place
 * and −amount in another. The books still balanced, but the cheque figures
 * did not agree with them.
 *
 * Every affected line still names its real cheque (`chequeId`), so the repair
 * is exact: the line moves to that cheque's account. Amounts, dates, parties,
 * cash and bank balances are untouched — only which cheque account the line
 * sits in changes.
 *
 *   node tools/repair-cheque-accounts.mjs --dry      show what would change
 *   node tools/repair-cheque-accounts.mjs --yes      repair
 *   node tools/repair-cheque-accounts.mjs --restore  put the lines back as they were
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc } from 'firebase/firestore';

const WORKSPACE = 'bond-workspace';
const HERE = (f) => fileURLToPath(new URL(f, import.meta.url));
const BACKUP = HERE('./repair-cheque-accounts-backup.json');

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
const LIVE = ['pending', 'deposited', 'presented'];

/** Balance of every cheque account, keyed by account id. */
function custody(ledger) {
  const out = new Map();
  for (const l of ledger) {
    if (!/^PDCI?:/.test(l.account?.id ?? '')) continue;
    out.set(l.account.id, (out.get(l.account.id) ?? 0) + (l.debit || 0) - (l.credit || 0));
  }
  return out;
}

/** Cheques whose account does not hold what their status says. */
function mismatches(cheques, ledger) {
  const bal = custody(ledger);
  return cheques.filter((c) => {
    const held = bal.get(`${c.direction === 'received' ? 'PDC' : 'PDCI'}:${c.id}`) ?? 0;
    const want = LIVE.includes(c.status)
      ? (c.direction === 'received' ? c.amount - (c.allocatedAmount || 0) : -c.amount)
      : 0;
    return Math.abs(held - want) > 1;
  });
}

async function restore() {
  const b = JSON.parse(readFileSync(BACKUP, 'utf8'));
  for (const x of b.ledgerLines) await setDoc(doc(db, ...P, 'pdcLedger', x.id), x);
  console.log(`restored ${b.ledgerLines.length} line(s) to their accounts before the repair`);
}

async function run(dry) {
  const [txns, ledger, cheques, parties] = await Promise.all(
    ['pdcTransactions', 'pdcLedger', 'pdcCheques', 'pdcParties'].map(load));
  const pName = new Map(parties.map((p) => [p.id, p.name]));
  const chq = new Map(cheques.map((c) => [c.id, c]));
  const ref = new Map(txns.map((t) => [t.id, t.reference]));

  // A line in a cheque account no cheque owns, that names a cheque which does.
  const moves = [];
  for (const l of ledger) {
    const m = /^(PDCI?):(.+)$/.exec(l.account?.id ?? '');
    if (!m || chq.has(m[2])) continue;
    if (l.chequeId && chq.has(l.chequeId)) moves.push({ line: l, to: `${m[1]}:${l.chequeId}` });
  }

  const beforeBad = mismatches(cheques, ledger);
  console.log(`cheque lines in the wrong account : ${moves.length}`);
  for (const { line, to } of moves) {
    const c = chq.get(line.chequeId);
    console.log(`  ${ref.get(line.txnId) ?? '?'}  #${c.chequeNumber}  ${pName.get(c.partyId) ?? ''}  ` +
                `${line.debit ? 'Dr ' + fmt(line.debit) : 'Cr ' + fmt(line.credit)}  -> its own cheque account`);
  }

  const fixedLedger = ledger.map((l) => {
    const mv = moves.find((x) => x.line.id === l.id);
    return mv ? { ...l, account: { ...l.account, id: mv.to } } : l;
  });
  const afterBad = mismatches(cheques, fixedLedger);
  console.log(`\ncheques not matching the books : ${beforeBad.length} now, ${afterBad.length} after repair`);

  if (afterBad.length) {
    // What the repair cannot settle on its own: a cheque record whose status
    // says one thing while no entry in the books backs it. These need a person.
    console.log('\nstill needing a decision (no entry in the books backs the status):');
    const bal = custody(fixedLedger);
    for (const c of afterBad) {
      const held = bal.get(`${c.direction === 'received' ? 'PDC' : 'PDCI'}:${c.id}`) ?? 0;
      console.log(`  #${c.chequeNumber}  ${pName.get(c.partyId) ?? ''}  ${fmt(c.amount)}  ` +
                  `status ${c.status}, books hold ${fmt(held)}`);
    }
  }

  if (!moves.length) { console.log('\nnothing to move.'); return; }
  if (dry) { console.log('\nDRY RUN — nothing was written.'); return; }

  // Never overwrite an earlier backup: it holds the lines as they first were.
  if (!existsSync(BACKUP)) {
    writeFileSync(BACKUP, JSON.stringify({
      takenAt: new Date().toISOString(),
      ledgerLines: moves.map((x) => x.line),
    }, null, 2));
    console.log('\nbackup written to repair-cheque-accounts-backup.json');
  }

  for (const { line, to } of moves) {
    await setDoc(doc(db, ...P, 'pdcLedger', line.id), { ...line, account: { ...line.account, id: to } });
  }

  const check = await load('pdcLedger');
  const t = check.reduce((a, x) => ({ d: a.d + (x.debit || 0), c: a.c + (x.credit || 0) }), { d: 0, c: 0 });
  console.log(`\nrepaired ${moves.length} line(s). book ${Math.round(t.d - t.c) === 0 ? 'BALANCED' : 'OUT BY ' + fmt(t.d - t.c)}`);
}

if (arg('--restore')) await restore();
else await run(!arg('--yes'));
process.exit(0);
