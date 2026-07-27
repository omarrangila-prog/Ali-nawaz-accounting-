# Ali Nawaz Accounting Software

**Cheques, party ledgers, receivables, payables and payment management — in one
keyboard-first screen.**

React + TypeScript + Firebase (Firestore), offline-first, with a proper
double-entry engine underneath so every figure and report agrees.

---

## The Cash Book

Everything happens on one page. Summary cards group into **Money**, **Business**
and **Cheques**; each card filters the register below it.

| Key | Action |
|-----|--------|
| `F1` | Sale |
| `F2` | Purchase |
| `F3` | Cash Received |
| `F4` | Cash Paid |
| `F5` | Cheque In (PDC received) |
| `F6` | Cheque Out (PDC issued) |
| `F7` | Cheque Transfer (endorse to another party) |
| `F8` | Ledger |
| `F9` | Search |
| `F10` | Reports |

Inside the register: `↑`/`↓` move, `PgUp`/`PgDn` page, `Enter` opens details,
`Delete` reverses, `Esc` closes. In a form, `Enter` advances a field,
`Shift+Enter` goes back, and `Enter` on the last field saves.

## Accounting model

Every action posts **balanced double-entry lines** sharing one transaction id.
Balances are always replayed from the ledger — never stored as a mutable total —
so the Cash Book and the reports cannot disagree.

- A **credit sale** makes the party owe you and counts revenue, without moving cash.
- A **cash sale** moves money and counts the same revenue once.
- Collecting that debt later **does not** change profit — it only settles the balance.
- One physical cheque is **one record for life**. Endorsing it to another party
  updates the holder and appends a movement; it is never duplicated.
- Bouncing a cheque **restores the original debt** rather than flipping a status.
- Posted entries are **reversed**, not deleted, and both stay in history.

`src/lib/pdcEngine.test.ts` locks these rules down with 40 tests.

## Reports

29 reports across five groups — Financial, Trading, Cheques, Ledgers, Activity —
each rendering a designed PDF with a branded header, KPI cards, native vector
charts (donut, comparison, trend), status pills and page numbers.

Headline reports: **Complete Cash Book**, **Profit & Loss**, **Balance Sheet**.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build
npm test           # 144 tests
```

Login PIN: **4444**

### Firebase

Copy `.env.example` to `.env` and fill in your own Firebase web config:

```
VITE_FIREBASE_API_KEY=…
VITE_FIREBASE_AUTH_DOMAIN=…
VITE_FIREBASE_PROJECT_ID=…
VITE_FIREBASE_STORAGE_BUCKET=…
VITE_FIREBASE_MESSAGING_SENDER_ID=…
VITE_FIREBASE_APP_ID=…
```

**With the keys blank the app runs on local mock data** — nothing is written to
a real database. Deploy `firestore.rules` before using live Firestore, or every
write will fail on permissions.

> ⚠️ **Security note.** There is currently no user authentication: the PIN only
> selects a workspace and lives in the client bundle, and `firestore.rules`
> allows open read/write. Do not put real accounting data behind a public URL
> until Firebase Auth and scoped rules are added.

### Desktop build

```bash
npm run electron:dev      # dev
npm run electron:build    # Windows installer
```

## Tech

React 18 · TypeScript (strict) · Vite · Zustand · Firebase Firestore ·
jsPDF + autotable · vitest
