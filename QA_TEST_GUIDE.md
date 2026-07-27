# Bond Ledger OS — QA Test Guide (Q & A)

A complete manual test plan. Each test has **Steps → Expected Result**.
Mark each **Pass / Fail**. Run top-to-bottom; later tests assume earlier data exists.

- **Env:** `npm run dev` → open the printed URL.
- **Data mode:** Real Firebase (your configured project) if `.env` has keys and `VITE_USE_MOCK=false`; otherwise local demo mode.
- **Reset for a clean run:** Demo mode → clear browser storage (DevTools → Application → Local Storage → clear). Firebase mode → delete docs under `users/bond-workspace/…` in the console.

---

## 0. Smoke / Startup

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 0.1 | Does the app open without login? | Open the URL | Lands directly on **Dashboard**, no sign-in screen. |
| 0.2 | Is the sidebar complete? | Look at left sidebar | Dashboard, Purchase, Sale, Stock, **Parties, Bond Types**, Receivable, Payable, Ledger, Trial Balance, Reports, Settings. |
| 0.3 | Does data persist on reload? | Add any bond type, press F5 / reload | The bond type is still there. |
| 0.4 | Is Firestore actually connected? | Add a bond type → open Firebase console → `users/bond-workspace/bondTypes` | Document exists. (If red error toast appears → deploy `firestore.rules`.) |

---

## 1. Bond Types (Masters)

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 1.1 | Can I quick-add common bonds? | Bond Types → tap chips 100, 200, 750, 1500, 25000, 40000 | Each appears in the table; chip turns green ✓. |
| 1.2 | Can I add a custom denomination? | Type `7500` → Add | Rs. 7500 appears; face value auto = 7500. |
| 1.3 | Are duplicates blocked? | Try to add `100` again | Info toast "already exists"; no duplicate row. |
| 1.4 | Can I edit a bond? | Click edit (gear) on a row → change value → check | Row updates; success toast. |
| 1.5 | Is delete protected when in use? | (After adding a purchase for Rs.100) delete Rs.100 | Error toast: has transactions — cannot delete. |
| 1.6 | Can I delete an unused bond? | Delete a bond with no transactions → confirm | Row removed. |

---

## 2. Parties (Masters)

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 2.1 | Can I add a party? | Parties → name "Ali Traders", phone, opening 0 → Add | Row appears; success toast. |
| 2.2 | Does opening balance show sign? | Add party "Khan" opening `25000` | Balance shows 25,000 **Dr** (receivable). |
| 2.3 | Negative opening = payable? | Add "Bilal" opening `-15000` | Shows 15,000 **Cr** (payable). |
| 2.4 | Are duplicate names merged? | Add "Ali Traders" again | Returns existing; no duplicate. |
| 2.5 | Can I edit name/phone? | Edit a party → save | Updates in table. |
| 2.6 | Delete protection? | Delete a party that has transactions | Error toast — cannot delete. |

---

## 3. Purchase Entry

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 3.1 | Does amount auto-calculate? | Purchase → Qty 10, Rate 17500 | Amount shows PKR 175,000 live. |
| 3.2 | Full keyboard entry works? | Focus loads on Party → type "Ali" Enter → "100" Enter → 10 Enter → 17500 Enter → Enter on Cash | Purchase saved with one hand on keyboard; success toast. |
| 3.3 | After-save keeps party/date? | Right after 3.2, look at form | Party & date unchanged; Qty/Rate blank; cursor in Quantity. |
| 3.4 | Can I create party inline? | In Party field type a new name → Enter on "+ Create" | Party created and selected. |
| 3.5 | Positive validation? | Qty 0 or Rate 0 → Save | Blocked; field outlined red; toast. |
| 3.6 | Does it appear in the list + total? | After saving | Row in Purchases table; footer Total updates. |
| 3.7 | Cash vs Credit tag? | Save one Cash, one Credit | Badges show green "cash" / orange "credit". |
| 3.8 | Delete a purchase? | Click trash → confirm | Removed; stock & totals recalc. |

---

## 4. Sale Entry (with stock guard + profit)

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 4.1 | Stock available hint shows? | Sale → pick a bond you purchased | Green hint "Available stock: N bonds". |
| 4.2 | **Oversell blocked?** | Enter Qty greater than available | Red warning; Save disabled/blocked. |
| 4.3 | Valid sale saves + profit? | Sell within stock at a higher rate | Saved; Profit column positive; P/L badge updates. |
| 4.4 | Loss shows negative? | Sell below avg cost | Profit shows negative (red). |
| 4.5 | Keyboard flow same as purchase? | Repeat 3.2 pattern on Sale | Works identically. |

---

## 5. Cash Entry (Received / Paid)

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 5.1 | F4 opens Cash Received? | Press **F4** anywhere | Cash Received modal opens. |
| 5.2 | F5 opens Cash Paid? | Press **F5** | Cash Paid modal opens. |
| 5.3 | Received reduces receivable? | On a party who owes you, record Received 50,000 | Their balance drops by 50,000. |
| 5.4 | Paid reduces payable? | On a party you owe, record Paid 30,000 | Payable drops by 30,000. |
| 5.5 | Positive amount enforced? | Amount 0 → Save | Blocked with toast. |
| 5.6 | Keyboard: party → amount → Enter saves | Open F4, type party Enter, amount Enter | Saved, modal closes. |

---

## 6. Ledger

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 6.1 | Party statement correct? | Ledger → select a party | Opening + all purchases/sales/cash lines, sorted by date. |
| 6.2 | Running balance + Dr/Cr? | Read Balance column | Cumulative; labelled Dr (they owe) / Cr (you owe). |
| 6.3 | Current balance header? | Top-right of ledger card | Matches last running balance. |
| 6.4 | Export ledger PDF? | Click PDF | Professional PDF downloads. |

---

## 7. Stock, Receivable, Payable

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 7.1 | Stock movement correct? | Stock page | Opening + Purchased − Sold = Closing, per bond; weighted avg cost. |
| 7.2 | Stock value = qty × avg? | Check Value column | Matches. |
| 7.3 | Receivables list right? | Receivable page | Only parties with positive balance; total correct. |
| 7.4 | Payables list right? | Payable page | Only parties you owe; total correct. |
| 7.5 | Ledger link from row? | Click "Ledger" on a party row | Opens that party's ledger. |

---

## 8. Trial Balance

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 8.1 | Is it balanced? | Trial Balance page | Green "Balanced" banner; Debits = Credits. |
| 8.2 | Lines present? | Read rows | Cash, (Bank/File if imported), Receivable, Closing Stock, Payable, Profit/Loss, (Opening Capital if imported). |
| 8.3 | Difference shown if unbalanced? | (Edge) | Amber banner with difference (should not happen in normal use). |

---

## 9. Reports & Export

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 9.1 | Generate full month report? | Reports → Generate Report | PDF with header, month/year, summary cards, tables, totals. |
| 9.2 | Individual report tiles? | Click each tile (Stock, Sale, etc.) | Correct single-report PDF each. |
| 9.3 | Export Excel? | Reports → Export Excel (or top bar) | .xlsx with Stock/Purchases/Sales/Cash/Balances/TrialBalance sheets. |
| 9.4 | Top-bar PDF/Excel/Print? | Use top-bar icons | PDF downloads / Excel downloads / print dialog opens. |

---

## 10. Monthly logic & Closing

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 10.1 | **Month view isolation?** | Add entries in current month → switch top-bar month to a different month | The other month shows empty / its own data only; switch back → data returns. |
| 10.2 | **New entry defaults to selected month?** | Set top bar to a past month → open Purchase | Date field defaults to the 1st of that month (not today). |
| 10.3 | Close month locks it? | Reports → Close Month → confirm | Month marked Closed/Locked. |
| 10.4 | Locked month blocks entries? | Try to add a purchase in the closed month | Blocked with "month is closed" toast; form shows locked banner. |
| 10.5 | Carry-forward works? | After closing, switch to next month → Stock | Opening stock = previous month's closing; party balances carried. |

---

## 11. Smart Entry

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 11.1 | Purchase sentence? | Smart Entry → `Bought 100 bond 10 qty at 17500 from Ali cash` | Preview shows PURCHASE with parsed fields; Record → saved. |
| 11.2 | Sale sentence? | `Sold 100 bond 5 qty at 17800 to Khan credit` | Parsed as SALE credit; saved (if stock allows). |
| 11.3 | Received? | `Received 50000 from Ali` | Cash received parsed & saved. |
| 11.4 | Paid? | `Paid 30000 to Khan` | Cash paid parsed & saved. |
| 11.5 | Low confidence warns? | Type gibberish | No/low-confidence preview; error if you try to record. |

---

## 12. Excel Migration (Settings → Import Old Excel Data)

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 12.1 | Only in Settings? | Check dashboard | No Excel import on dashboard; only under Settings. |
| 12.2 | Reads BALANCE SHEET? | Choose your real `.xlsx` | Preview shows opening stock per denomination (qty, avg cost, value, profit). |
| 12.3 | Numbers match sheet? | Compare 100-bond row | Purchase 3117 / Sale 3104 / Closing 13 / Profit 45,962.50 (for the sample file). |
| 12.4 | REC/PAY/FILE parsed? | Preview panels | Receivables, Payables, Bank/File accounts listed with totals. |
| 12.5 | Preview before save? | Before clicking Confirm | Nothing is written yet. |
| 12.6 | Confirm writes data? | Confirm Import | Success toast; app jumps to the chosen opening month. |
| 12.7 | **Duplicate import blocked?** | Try to import again | "Already imported" note with Reset option; no double data. |
| 12.8 | Opening feeds dashboard? | Dashboard for opening month | Stock/receivable/payable/bank reflect imported opening; Trial Balance balanced via Opening Capital line. |

---

## 13. Keyboard Shortcuts

| Key | Expected |
|-----|----------|
| F2 | Go to Purchase (new). |
| F3 | Go to Sale (new). |
| F4 | Cash Received modal. |
| F5 | Cash Paid modal. |
| F6 | Ledger. |
| F7 | Reports. |
| Ctrl/Cmd + K | Search / command palette; ↑↓ + Enter navigates. |
| Ctrl/Cmd + S | Saves current entry form. |
| Ctrl/Cmd + P | Print. |
| Enter (in forms) | Advances to next field; saves on last. |
| Esc | Closes modal / dropdown. |

---

## 14. Responsive / Web-app layout

Resize the browser (or DevTools device toolbar) and check each width.

| # | Width | Expected |
|---|-------|----------|
| 14.1 | 1440px desktop | Sidebar docked; entry form + list side-by-side; 4 stat cards per row. |
| 14.2 | 960px tablet | Sidebar collapses to ☰ menu; layouts stack; **no horizontal page scroll**. |
| 14.3 | 768px | Top bar wraps; tables scroll inside their card only; 2 stat cards per row. |
| 14.4 | 390px phone | 1–2 cards per row; modals become bottom sheets; toasts full width; **no page-level horizontal scroll**. |
| 14.5 | 320px | Still usable; content never clipped off-screen. |
| 14.6 | Sidebar toggle | ☰ opens sidebar overlay; tapping a link or the dim area closes it. |
| 14.7 | Inputs on mobile | Tapping a number field shows numeric keypad; page does not zoom in. |

---

## 15. Offline / Sync

| # | Question | Steps | Expected |
|---|----------|-------|----------|
| 15.1 | Offline banner? | DevTools → Network → Offline | "Offline" pill in top bar; warning toast. |
| 15.2 | Offline writes queue? | While offline, add a purchase | Saves locally; appears immediately. |
| 15.3 | Auto-sync on reconnect? | Go back Online | "Back online — syncing" toast; data persists after reload. |

---

## 16. Validation & Safety

| # | Question | Expected |
|---|----------|----------|
| 16.1 | Delete confirmation | Every delete asks to confirm. |
| 16.2 | Toasts | Success/error/info toasts appear for each action. |
| 16.3 | No NaN / blank amounts | Empty numeric fields treated as 0, never NaN. |
| 16.4 | Firestore failure surfaced | If a write fails, a clear red toast appears (not silent). |

---

### Sign-off

| Area | Pass | Fail | Notes |
|------|------|------|-------|
| Masters (bonds/parties) | | | |
| Purchase / Sale / Cash | | | |
| Ledger / Stock / Balances | | | |
| Trial Balance / Reports | | | |
| Monthly logic / Closing | | | |
| Smart Entry | | | |
| Excel Migration | | | |
| Keyboard | | | |
| Responsive | | | |
| Offline / Sync | | | |

Tester: ______________  Date: ____________  Build: ____________
