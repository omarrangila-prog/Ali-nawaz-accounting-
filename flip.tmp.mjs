import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc } from 'firebase/firestore';
import { writeFileSync } from 'node:fs';
const db = getFirestore(initializeApp(JSON.parse(process.env.FBCFG)));
const P = ['users','bond-workspace'];
const load = async c => (await getDocs(collection(db,...P,c))).docs.map(d=>({id:d.id,...d.data()}));
const DRY = process.env.DRY === '1';
const OUT = process.env.OUTDIR;

const [txns, ledger] = await Promise.all(['pdcTransactions','pdcLedger'].map(load));
const pays = txns.filter(t => t.type === 'Cash Paid');
const payIds = new Set(pays.map(t => t.id));
const lines = ledger.filter(l => payIds.has(l.txnId));

// Full snapshot of exactly what is about to change, so it can be put back.
writeFileSync(`${OUT}/flip-backup.json`, JSON.stringify({
  takenAt: new Date().toISOString(), transactions: pays, ledgerLines: lines,
}, null, 2));
console.log(`backup: ${pays.length} txns + ${lines.length} ledger lines -> flip-backup.json`);

const r2 = n => Math.round(n*100)/100;
const before = { d: 0, c: 0 };
for (const l of ledger) { before.d += l.debit||0; before.c += l.credit||0; }
console.log(`before: debits ${r2(before.d).toLocaleString()} credits ${r2(before.c).toLocaleString()}`);

if (DRY) { console.log('DRY RUN — nothing written'); process.exit(0); }

let n = 0;
for (const t of pays) {
  await setDoc(doc(db, ...P, 'pdcTransactions', t.id), {
    ...t, type: 'Cash Received',
    // Money now arrives rather than leaves; these entries were all cash.
    paymentMethod: 'cash',
    fromBankAccountId: null, toBankAccountId: t.fromBankAccountId ?? null,
    updatedAt: Date.now(),
  });
  n++;
}
let m = 0;
for (const l of lines) {
  // Swap the sides: Dr Party/Cr Cash becomes Dr Cash/Cr Party.
  await setDoc(doc(db, ...P, 'pdcLedger', l.id), {
    ...l, debit: l.credit || 0, credit: l.debit || 0,
  });
  m++;
}
console.log(`flipped ${n} transactions and ${m} ledger lines`);
process.exit(0);
