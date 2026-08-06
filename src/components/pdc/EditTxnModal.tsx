/**
 * Ali Nawaz PDC — edit any posted transaction.
 *
 * Editing never rewrites history silently. The store reverses the original and
 * posts the correction, so both entries stay visible and the audit trail records
 * what changed and why — the books are always explainable.
 *
 * Every field that was captured on entry can be changed here: the party, the
 * amount, quantity and rate, the item, the date, the description, how it was
 * paid, and the cheque's own number, bank and date.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Combo } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import {
  buildSale, buildPurchase, buildCashReceived, buildCashPaid,
  buildExpense, buildIncome, buildDebitAdjustment, buildCreditAdjustment,
  bankAccountLabel, type Posting,
} from '@/lib/pdcEngine';
import { isDuplicateCheque } from '@/lib/chequeWorkflow';
import type { RegisterRow } from '@/types/pdc';
import { PAKISTAN_BANKS } from '@/config/pakistanBanks';
import { round2, cx } from '@/lib/utils';
import { toast } from '@/store/toast';

/** Marks a dropdown option that is a bank SUGGESTION, not an existing record. */
const SUGGEST = 'new-bank:';

/** Transaction types this form knows how to rebuild. */
const EDITABLE = new Set([
  'Sale', 'Purchase', 'Cash Received', 'Cash Paid', 'Expense', 'Income',
  'Debit Adjustment', 'Credit Adjustment',
]);

/** True when a transaction can be edited through this form. */
export function canEdit(row: RegisterRow | null): boolean {
  if (!row) return false;
  const t = row.txn;
  if (t.reversed) return false;               // correct the correcting entry
  // A cheque that has moved on has a life of its own; changing the entry
  // beneath it would contradict its recorded history.
  if (row.cheque && row.cheque.status !== 'pending') return false;
  return EDITABLE.has(t.type);
}

interface Props {
  row: RegisterRow | null;
  onClose: () => void;
}

export function EditTxnModal({ row, onClose }: Props) {
  const store = usePdc();
  const data = store.dataset();

  const txn = row?.txn;
  const cheque = row?.cheque;

  const [partyId, setPartyId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [itemName, setItemName] = useState('');
  const [category, setCategory] = useState('');
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank' | 'cheque'>('cash');
  const [bankAccountId, setBankAccountId] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [chequeBankId, setChequeBankId] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [reason, setReason] = useState('');

  // Load the transaction's current values whenever a different row is opened.
  useEffect(() => {
    if (!txn) return;
    setPartyId(txn.partyId ?? '');
    setAmount(String(txn.amount));
    setDate(txn.date);
    setDescription(txn.description ?? '');
    setItemName(txn.itemName ?? '');
    setCategory(txn.category ?? '');
    setQty(txn.quantity !== undefined ? String(txn.quantity) : '');
    setRate(txn.rate !== undefined ? String(txn.rate) : '');
    setMethod(
      txn.chequeId ? 'cheque'
        : (txn.fromBankAccountId || txn.toBankAccountId) ? 'bank'
        : 'cash'
    );
    setBankAccountId(txn.fromBankAccountId ?? txn.toBankAccountId ?? '');
    setChequeNumber(cheque?.chequeNumber ?? '');
    setChequeBankId(cheque?.bankId ?? '');
    setChequeDate(cheque?.chequeDate ?? '');
    setReason('');
  }, [txn?.id]);

  // Quantity × rate keeps driving the amount, as it does on the entry form.
  useEffect(() => {
    const q = Number(qty), r = Number(rate);
    if (qty.trim() && rate.trim() && Number.isFinite(q) && Number.isFinite(r)) {
      setAmount(String(round2(q * r)));
    }
  }, [qty, rate]);

  if (!row || !txn) return null;

  const isTrade = txn.type === 'Sale' || txn.type === 'Purchase';
  const isMoney = txn.type === 'Cash Received' || txn.type === 'Cash Paid';
  const isNominal = txn.type === 'Expense' || txn.type === 'Income';
  const isAdjust = txn.type === 'Debit Adjustment' || txn.type === 'Credit Adjustment';
  const received = txn.type === 'Cash Received';

  const partyOptions = data.parties
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, label: p.name }));

  const accountOptions = data.bankAccounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, label: bankAccountLabel(data.banks, data.bankAccounts, a.id) }));

  /** Banks on file, then every Pakistani bank — created on first use. */
  const have = data.banks.filter((b) => b.active).map((b) => ({ id: b.id, label: b.name }));
  const haveNames = new Set(have.map((b) => b.label.trim().toLowerCase()));
  const bankOptions = [
    ...have,
    ...PAKISTAN_BANKS
      .filter((b) => !haveNames.has(b.name.trim().toLowerCase()))
      .map((b) => ({ id: `${SUGGEST}${b.name}`, label: b.name, sub: b.kind })),
  ];

  const resolveBank = async (value: string) => {
    if (!value.startsWith(SUGGEST)) { setChequeBankId(value); return; }
    const name = value.slice(SUGGEST.length);
    const existing = data.banks.find(
      (b) => b.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    const bank = existing ?? (await store.saveBank({ name }));
    if (bank) setChequeBankId(bank.id);
  };

  async function save() {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount.'); return; }
    if (!date) { toast.error('Enter a date.'); return; }
    if (!isNominal && !partyId) { toast.error('Select a party.'); return; }
    if (isNominal && !category.trim()) { toast.error('Enter a category.'); return; }

    // A changed cheque number must still be unique for its bank and direction.
    if (method === 'cheque' && chequeNumber.trim() && chequeBankId) {
      const dir = received || txn!.type === 'Sale' ? 'received' : 'issued';
      if (isDuplicateCheque(
        data,
        { chequeNumber: chequeNumber.trim(), bankId: chequeBankId, direction: dir },
        cheque?.id
      )) {
        toast.error('That cheque number already exists for this bank.');
        return;
      }
    }

    const q = qty.trim() ? Number(qty) : undefined;
    const r = rate.trim() ? Number(rate) : undefined;
    const chequeInput = method === 'cheque'
      ? { chequeNumber: chequeNumber.trim(), chequeDate, bankId: chequeBankId }
      : undefined;

    let corrected: Posting;
    switch (txn!.type) {
      // A trade posts to the party ledger; payment is collected separately.
      case 'Sale':
        corrected = buildSale(data, {
          partyId, amount: amt, date, settlement: 'credit', description,
          quantity: q, rate: r, itemName: itemName.trim() || undefined,
        });
        break;
      case 'Purchase':
        corrected = buildPurchase(data, {
          partyId, amount: amt, date, settlement: 'credit', description,
          quantity: q, rate: r, itemName: itemName.trim() || undefined,
        });
        break;
      case 'Cash Received':
        corrected = buildCashReceived(data, {
          partyId, amount: amt, date, description,
          bankAccountId: method === 'bank' ? bankAccountId || undefined : undefined,
          paymentMethod: method,
          cheque: chequeInput,
        });
        break;
      case 'Cash Paid':
        corrected = buildCashPaid(data, {
          partyId, amount: amt, date, description,
          bankAccountId: method === 'bank' ? bankAccountId || undefined : undefined,
          paymentMethod: method,
          cheque: chequeInput,
        });
        break;
      case 'Expense':
        corrected = buildExpense(data, {
          amount: amt, date, category, description,
          bankAccountId: method === 'bank' ? bankAccountId || undefined : undefined,
          partyId: partyId || undefined,
        });
        break;
      case 'Income':
        corrected = buildIncome(data, {
          amount: amt, date, category, description,
          bankAccountId: method === 'bank' ? bankAccountId || undefined : undefined,
          partyId: partyId || undefined,
        });
        break;
      case 'Debit Adjustment':
        corrected = buildDebitAdjustment(data, { partyId, amount: amt, date, description });
        break;
      case 'Credit Adjustment':
        corrected = buildCreditAdjustment(data, { partyId, amount: amt, date, description });
        break;
      default:
        toast.error(`${txn!.type} entries cannot be edited here.`);
        return;
    }

    if (await store.editTransaction(txn!.id, corrected, reason.trim() || undefined)) {
      onClose();
    }
  }

  return (
    <Modal
      open
      title={`Edit ${txn.type}`}
      subtitle={`${txn.reference} · the original is reversed and this correction posted, so both stay in history`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={store.saving}>
            {store.saving ? 'Saving…' : 'Save Correction'}
          </button>
        </>
      }
    >
      <div className="pdc-form-grid">
        {(isTrade || isMoney || isAdjust) && (
          <div className="field">
            <label>{txn.type === 'Sale' ? 'Customer' : txn.type === 'Purchase' ? 'Supplier' : 'Party'}</label>
            <Combo
              value={partyId}
              options={partyOptions}
              placeholder="Select or type a name to create"
              allowCreate
              onChange={setPartyId}
              onCreate={async (name) => (await store.saveParty({ name }))?.id ?? ''}
            />
          </div>
        )}

        {isNominal && (
          <>
            <div className="field">
              <label>Category</label>
              <input className="input" value={category}
                placeholder="e.g. Rent, Salary, Fuel"
                onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="field">
              <label>Party <span className="faint">(optional)</span></label>
              <Combo
                value={partyId}
                options={[{ id: '', label: 'None' }, ...partyOptions]}
                placeholder="Select or type a name to create"
                allowCreate
                onChange={setPartyId}
                onCreate={async (name) => (await store.saveParty({ name }))?.id ?? ''}
              />
            </div>
          </>
        )}

        {isTrade && (
          <>
            <div className="field">
              <label>Quantity &amp; Rate <span className="faint">(fills the amount)</span></label>
              <div className="grid-2">
                <input className="input" type="number" inputMode="decimal" placeholder="Qty"
                  value={qty} onChange={(e) => setQty(e.target.value)} />
                <input className="input" type="number" inputMode="decimal" placeholder="Rate"
                  value={rate} onChange={(e) => setRate(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>Item / Product</label>
              <input className="input" value={itemName}
                onChange={(e) => setItemName(e.target.value)} />
            </div>
          </>
        )}

        <div className="field">
          <label>Amount</label>
          <input className="input" type="number" inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value)} />
        </div>

        {(isMoney || isNominal) && (
          <div className="field">
            <label>Payment</label>
            <div className="format-picker">
              {(isMoney
                ? ([
                    { id: 'cash', label: 'Cash' },
                    { id: 'bank', label: 'Bank' },
                    { id: 'cheque', label: 'Cheque' },
                  ] as const)
                : ([
                    { id: 'cash', label: 'Cash' },
                    { id: 'bank', label: 'Bank' },
                  ] as const)
              ).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={cx('format-btn', method === o.id && 'on')}
                  onClick={() => setMethod(o.id)}
                >
                  <span className="format-btn-label">{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {method === 'bank' && (isMoney || isNominal) && (
          <div className="field">
            <label>Bank Account</label>
            <Combo
              value={bankAccountId}
              options={accountOptions}
              placeholder="Select an account"
              onChange={setBankAccountId}
            />
          </div>
        )}

        {/* Cheque details stay fully editable, and every one is optional — a
            cheque taken in without its number can be completed here later. */}
        {method === 'cheque' && isMoney && (
          <>
            <div className="field">
              <label>Cheque Bank <span className="faint">(optional)</span></label>
              <Combo
                value={chequeBankId}
                options={bankOptions}
                placeholder="Search any bank"
                onChange={resolveBank}
              />
            </div>
            <div className="grid-2">
              <div className="field">
                <label>Cheque Number <span className="faint">(optional)</span></label>
                <input className="input" value={chequeNumber}
                  onChange={(e) => setChequeNumber(e.target.value)} />
              </div>
              <div className="field">
                <label>Cheque Date <span className="faint">(optional)</span></label>
                <input className="input" type="date" value={chequeDate}
                  onChange={(e) => setChequeDate(e.target.value)} />
              </div>
            </div>
          </>
        )}

        <div className="field">
          <label>Date</label>
          <input className="input" type="date" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </div>

        <div className="field">
          <label>Description</label>
          <input className="input" value={description}
            placeholder="What this entry is for"
            onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="field">
          <label>Reason for the change <span className="faint">(kept in the audit trail)</span></label>
          <input className="input" value={reason}
            placeholder="e.g. typed the wrong amount"
            onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>

      <div className="pdc-warn" style={{ marginTop: 10 }}>
        The original entry is reversed and this correction posted in its place.
        Both remain in history, and every ledger, statement and report updates
        together.
      </div>
    </Modal>
  );
}
