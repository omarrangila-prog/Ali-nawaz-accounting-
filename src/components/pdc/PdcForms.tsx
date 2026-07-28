/**
 * Ali Nawaz PDC — entry forms (spec §7–§10, §13, §15, §16)
 *
 * Every form is a compact modal over the Cashbook — never a separate page.
 * Keyboard contract (spec §25):
 *   • the first field focuses on open
 *   • Enter moves to the next field, Shift+Enter to the previous
 *   • Enter on the last field saves
 *   • after save, focus returns to the first field for the next entry
 *   • validation failure keeps the entered data and focuses the bad field
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Combo, type ComboHandle } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import {
  buildBankTransfer,
  buildCashPaid,
  buildCashReceived,
  buildCreditAdjustment,
  buildDebitAdjustment,
  buildPartyTransfer,
  buildPdcIssued,
  buildPdcReceived,
  buildSale,
  buildPurchase,
  buildExpense,
  buildIncome,
  bankAccountLabel,
} from '@/lib/pdcEngine';
import { buildChequeTransfer, isDuplicateCheque, unallocated } from '@/lib/chequeWorkflow';
import { todayISO, formatMoney } from '@/lib/utils';
import { toast } from '@/store/toast';

/** Which form is open. */
export type PdcFormKind =
  | 'sale'
  | 'purchase'
  | 'expense'
  | 'income'
  | 'pdc-received'
  | 'pdc-issued'
  | 'cash-received'
  | 'cash-paid'
  | 'debit'
  | 'credit'
  | 'party-transfer'
  | 'cheque-transfer'
  | 'bank-transfer'
  | null;

const TITLES: Record<NonNullable<PdcFormKind>, string> = {
  sale: 'Sale',
  purchase: 'Purchase',
  expense: 'Expense',
  income: 'Other Income',
  'pdc-received': 'PDC Received',
  'pdc-issued': 'PDC Issued',
  'cash-received': 'Cash Received',
  'cash-paid': 'Cash Paid',
  debit: 'Debit Entry',
  credit: 'Credit Entry',
  'party-transfer': 'Party-to-Party Transfer',
  'cheque-transfer': 'Cheque Transfer',
  'bank-transfer': 'Bank Transfer',
};

const SUBTITLES: Record<NonNullable<PdcFormKind>, string> = {
  sale: 'F1 · goods or services sold',
  purchase: 'F2 · goods or services bought',
  expense: 'money spent on running costs',
  income: 'money earned that is not a sale',
  'pdc-received': 'F5 · cheque received from a party',
  'pdc-issued': 'F6 · cheque issued to a party',
  'cash-received': 'F3 · cash or bank receipt',
  'cash-paid': 'F4 · cash or bank payment',
  debit: 'increases what the party owes you',
  credit: 'increases what you owe the party',
  'party-transfer': 'move a balance between parties',
  'cheque-transfer': 'F7 · endorse a received cheque to another party',
  'bank-transfer': 'move money between your own accounts',
};

/**
 * Sequential keyboard navigation over a form's fields. Enter advances,
 * Shift+Enter goes back, Enter on the last field submits.
 */
function useFieldChain(count: number, onSubmit: () => void) {
  const refs = useRef<Array<HTMLElement | ComboHandle | null>>([]);

  const focusAt = (i: number) => {
    const el = refs.current[i];
    if (!el) return;
    if ('focus' in el && typeof el.focus === 'function') el.focus();
  };

  const keyHandler = (index: number) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.shiftKey) {
      if (index > 0) focusAt(index - 1);
      return;
    }
    if (index >= count - 1) onSubmit();
    else focusAt(index + 1);
  };

  const set = (i: number) => (el: HTMLElement | ComboHandle | null) => {
    refs.current[i] = el;
  };

  return { set, keyHandler, focusAt };
}

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
}

function Field({ label, children, hint, error }: FieldProps) {
  return (
    <div className="field">
      <label>
        {label} {hint && <span className="faint">{hint}</span>}
      </label>
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

interface Props {
  kind: PdcFormKind;
  /** Pre-selected party from the Cashbook's party picker. */
  defaultParty?: string;
  /** Pre-selected cheque (used when transferring straight from a row). */
  defaultCheque?: string;
  onClose: () => void;
}

export function PdcForm({ kind, defaultParty = '', defaultCheque = '', onClose }: Props) {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;

  // --- form state ----------------------------------------------------------
  const [partyId, setPartyId] = useState(defaultParty);
  const [toPartyId, setToPartyId] = useState('');
  const [bankId, setBankId] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [toBankAccountId, setToBankAccountId] = useState('');
  const [chequeId, setChequeId] = useState(defaultCheque);
  const [chequeNumber, setChequeNumber] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState('');
  const [settlement, setSettlement] = useState<'cash' | 'credit'>('credit');
  const [category, setCategory] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reset whenever the form opens so a previous entry never leaks in.
  useEffect(() => {
    if (!kind) return;
    setPartyId(defaultParty);
    setToPartyId('');
    setBankId('');
    setBankAccountId('');
    setToBankAccountId('');
    setChequeId(defaultCheque);
    setChequeNumber('');
    setChequeDate('');
    setAmount('');
    setDate(todayISO());
    setDescription('');
    setSettlement('credit');
    setCategory('');
    setErrors({});
  }, [kind, defaultParty, defaultCheque]);

  // --- options -------------------------------------------------------------
  const partyOptions = useMemo(
    () => data.parties.filter((p) => p.active).map((p) => ({ id: p.id, label: p.name })),
    [data.parties]
  );
  const bankOptions = useMemo(
    () => data.banks.filter((b) => b.active).map((b) => ({ id: b.id, label: b.name })),
    [data.banks]
  );
  const accountOptions = useMemo(
    () =>
      data.bankAccounts
        .filter((a) => a.active)
        .map((a) => ({
          id: a.id,
          label: bankAccountLabel(data.banks, data.bankAccounts, a.id),
          sub: a.accountNumber,
        })),
    [data.bankAccounts, data.banks]
  );
  /** Received cheques still available to endorse. */
  const transferableCheques = useMemo(
    () =>
      data.cheques
        .filter(
          (c) =>
            c.direction === 'received' &&
            c.status === 'pending' &&
            unallocated(c) > 0
        )
        .map((c) => ({
          id: c.id,
          label: `${c.chequeNumber} · ${formatMoney(c.amount, cur)}`,
          sub: `${data.parties.find((p) => p.id === c.partyId)?.name ?? ''} · due ${c.chequeDate}`,
        })),
    [data.cheques, data.parties, cur]
  );

  const selectedCheque = data.cheques.find((c) => c.id === chequeId);

  // Endorsing pre-fills the amount: full cheque unless partial is enabled.
  useEffect(() => {
    if (kind === 'cheque-transfer' && selectedCheque) {
      setAmount(String(unallocated(selectedCheque)));
    }
  }, [kind, chequeId]);

  // --- validation ----------------------------------------------------------
  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    const amt = Number(amount);
    const needsAmount = true;
    // Expense / Income / Bank transfer don't require a party.
    const needsParty =
      kind !== 'bank-transfer' && kind !== 'expense' && kind !== 'income';

    if (needsParty && !partyId) e.partyId = 'Select a party.';
    if ((kind === 'expense' || kind === 'income') && !category.trim()) {
      e.category = 'Enter a category (e.g. Rent, Salary).';
    }
    if (needsAmount) {
      if (!amount.trim()) e.amount = 'Enter an amount.';
      else if (!Number.isFinite(amt)) e.amount = 'Amount must be a number.';
      else if (amt <= 0) e.amount = 'Amount must be greater than zero.';
    }
    if (!date) e.date = 'Enter a date.';

    if (kind === 'pdc-received') {
      if (!bankId) e.bankId = 'Select the drawer’s bank.';
      if (!chequeNumber.trim()) e.chequeNumber = 'Enter the cheque number.';
      if (!chequeDate) e.chequeDate = 'Enter the cheque date.';
      if (bankId && chequeNumber.trim() &&
          isDuplicateCheque(data, { chequeNumber, bankId, direction: 'received' })) {
        e.chequeNumber = 'This cheque number already exists for that bank.';
      }
    }
    if (kind === 'pdc-issued') {
      if (!bankAccountId) e.bankAccountId = 'Select the bank account.';
      if (!chequeNumber.trim()) e.chequeNumber = 'Enter the cheque number.';
      if (!chequeDate) e.chequeDate = 'Enter the cheque date.';
      if (bankAccountId && chequeNumber.trim() &&
          isDuplicateCheque(data, { chequeNumber, bankId: '', bankAccountId, direction: 'issued' })) {
        e.chequeNumber = 'This cheque number already exists for that account.';
      }
    }
    if (kind === 'party-transfer') {
      if (!toPartyId) e.toPartyId = 'Select the receiving party.';
      else if (toPartyId === partyId) e.toPartyId = 'Cannot transfer to the same party.';
    }
    if (kind === 'cheque-transfer') {
      if (!chequeId) e.chequeId = 'Select a cheque.';
      if (!toPartyId) e.toPartyId = 'Select the receiving party.';
    }
    if (kind === 'bank-transfer') {
      if (!bankAccountId) e.bankAccountId = 'Select the source account.';
      if (!toBankAccountId) e.toBankAccountId = 'Select the destination account.';
      else if (toBankAccountId === bankAccountId) e.toBankAccountId = 'Cannot transfer to the same account.';
    }
    return e;
  }

  // --- submit --------------------------------------------------------------
  async function submit() {
    if (store.saving) return; // spec §28: block double-save
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) {
      // Keep everything typed; just focus the first bad field.
      const order = ['partyId', 'chequeId', 'toPartyId', 'bankId', 'bankAccountId',
        'toBankAccountId', 'chequeNumber', 'chequeDate', 'amount', 'date'];
      const first = order.find((k) => e[k]);
      toast.error(e[first ?? order[0]] ?? 'Please fix the highlighted field.');
      return;
    }

    const amt = Number(amount);
    let ok = false;

    switch (kind) {
      case 'sale':
        ok = await store.commit(
          buildSale(data, {
            partyId, amount: amt, date, settlement, description,
            bankAccountId: settlement === 'cash' ? bankAccountId || undefined : undefined,
          })
        );
        break;
      case 'purchase':
        ok = await store.commit(
          buildPurchase(data, {
            partyId, amount: amt, date, settlement, description,
            bankAccountId: settlement === 'cash' ? bankAccountId || undefined : undefined,
          })
        );
        break;
      case 'expense':
        ok = await store.commit(
          buildExpense(data, {
            amount: amt, date, category, description,
            bankAccountId: bankAccountId || undefined,
            partyId: partyId || undefined,
          })
        );
        break;
      case 'income':
        ok = await store.commit(
          buildIncome(data, {
            amount: amt, date, category, description,
            bankAccountId: bankAccountId || undefined,
            partyId: partyId || undefined,
          })
        );
        break;
      case 'pdc-received':
        ok = await store.commit(
          buildPdcReceived(data, {
            partyId, bankId, chequeNumber, chequeDate, amount: amt, date, description,
          })
        );
        break;
      case 'pdc-issued':
        ok = await store.commit(
          buildPdcIssued(data, {
            partyId, bankAccountId, chequeNumber, chequeDate, amount: amt, date, description,
          })
        );
        break;
      case 'cash-received':
        ok = await store.commit(
          buildCashReceived(data, { partyId, amount: amt, date, description, bankAccountId: bankAccountId || undefined })
        );
        break;
      case 'cash-paid':
        ok = await store.commit(
          buildCashPaid(data, { partyId, amount: amt, date, description, bankAccountId: bankAccountId || undefined })
        );
        break;
      case 'debit':
        ok = await store.commit(buildDebitAdjustment(data, { partyId, amount: amt, date, description }));
        break;
      case 'credit':
        ok = await store.commit(buildCreditAdjustment(data, { partyId, amount: amt, date, description }));
        break;
      case 'party-transfer':
        ok = await store.commit(
          buildPartyTransfer(data, { fromPartyId: partyId, toPartyId, amount: amt, date, description })
        );
        break;
      case 'bank-transfer':
        ok = await store.commit(
          buildBankTransfer(data, {
            fromBankAccountId: bankAccountId, toBankAccountId, amount: amt, date, description,
          })
        );
        break;
      case 'cheque-transfer': {
        const res = buildChequeTransfer(data, { chequeId, toPartyId, amount: amt, date, description });
        if ('error' in res) {
          toast.error(res.error);
          return;
        }
        ok = await store.commit(res, { action: 'cheque-transfer' });
        break;
      }
    }

    if (!ok) return;
    toast.success(`${TITLES[kind!]} saved`);
    // Clear the entry fields but keep date + party so rapid repeat entry is fast.
    setAmount('');
    setChequeNumber('');
    setChequeDate('');
    setDescription('');
    setChequeId('');
    setErrors({});
    chain.focusAt(0); // spec §7: focus returns to the first field
  }

  // --- field layout per form ----------------------------------------------
  // Each form declares its fields in order; the chain wires Enter navigation.
  const fields: ReactNode[] = [];
  const fieldCount = (() => {
    switch (kind) {
      // party, amount, cash/credit, account, date, desc
      case 'sale':
      case 'purchase': return 6;
      // category, amount, date, account, desc
      case 'expense':
      case 'income': return 5;
      case 'pdc-received': return 7;   // party, bank, cheque#, cheque date, amount, date, desc
      case 'pdc-issued': return 7;     // party, account, cheque#, cheque date, amount, date, desc
      case 'cash-received':
      case 'cash-paid': return 5;      // party, amount, date, account, desc
      case 'debit':
      case 'credit': return 4;         // party, amount, date, desc
      case 'party-transfer': return 5; // from, to, amount, date, desc
      case 'cheque-transfer': return 5;// cheque, to party, amount, date, desc
      case 'bank-transfer': return 5;  // from, to, amount, date, desc
      default: return 0;
    }
  })();

  const chain = useFieldChain(fieldCount, submit);

  // Focus the first field when the form opens (spec §25).
  useEffect(() => {
    if (!kind) return;
    const t = setTimeout(() => chain.focusAt(0), 60);
    return () => clearTimeout(t);
  }, [kind]);

  if (!kind) return null;

  let i = 0;
  const partyField = (label: string, value: string, onChange: (v: string) => void, errKey: string) => {
    const idx = i++;
    return (
      <Field key={errKey} label={label} error={errors[errKey]}>
        <Combo
          ref={chain.set(idx)}
          value={value}
          options={partyOptions}
          placeholder="Select or create a party"
          allowCreate
          invalid={!!errors[errKey]}
          onChange={onChange}
          onCreate={async (name) => (await store.saveParty({ name }))?.id ?? ''}
          onDone={() => chain.focusAt(idx + 1)}
        />
      </Field>
    );
  };

  const comboField = (
    label: string, value: string, options: Array<{ id: string; label: string; sub?: string }>,
    onChange: (v: string) => void, errKey: string, placeholder: string, hint?: string
  ) => {
    const idx = i++;
    return (
      <Field key={errKey} label={label} error={errors[errKey]} hint={hint}>
        <Combo
          ref={chain.set(idx)}
          value={value}
          options={options}
          placeholder={placeholder}
          invalid={!!errors[errKey]}
          onChange={onChange}
          onDone={() => chain.focusAt(idx + 1)}
        />
      </Field>
    );
  };

  const textField = (
    label: string, value: string, onChange: (v: string) => void, errKey: string,
    type: 'text' | 'number' | 'date' = 'text', placeholder?: string, hint?: string
  ) => {
    const idx = i++;
    return (
      <Field key={errKey} label={label} error={errors[errKey]} hint={hint}>
        <input
          ref={chain.set(idx) as any}
          className={errors[errKey] ? 'input invalid' : 'input'}
          type={type}
          inputMode={type === 'number' ? 'decimal' : undefined}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={chain.keyHandler(idx)}
        />
      </Field>
    );
  };

  /** A plain <select> that participates in the Enter-to-advance chain. */
  const selectField = (
    label: string, value: string, options: Array<{ value: string; label: string }>,
    onChange: (v: string) => void, errKey: string, hint?: string
  ) => {
    const idx = i++;
    return (
      <Field key={errKey} label={label} error={errors[errKey]} hint={hint}>
        <select
          ref={chain.set(idx) as any}
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={chain.keyHandler(idx)}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
    );
  };

  switch (kind) {
    case 'sale':
    case 'purchase': {
      const isSale = kind === 'sale';
      fields.push(partyField(isSale ? 'Customer' : 'Supplier', partyId, setPartyId, 'partyId'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(selectField(
        'Payment', settlement,
        [
          { value: 'credit', label: isSale ? 'On credit — they will pay later' : 'On credit — we will pay later' },
          { value: 'cash', label: isSale ? 'Cash / bank received now' : 'Cash / bank paid now' },
        ],
        (v) => setSettlement(v as 'cash' | 'credit'), 'settlement'
      ));
      // Only relevant when money actually moves now.
      fields.push(comboField(
        'Cash or Bank', bankAccountId,
        [{ id: '', label: 'Cash in hand' }, ...accountOptions],
        setBankAccountId, 'bankAccountId', 'Cash in hand',
        settlement === 'cash' ? '(where the money went)' : '(not used for credit)'
      ));
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;
    }

    case 'expense':
    case 'income':
      fields.push(textField(
        'Category', category, setCategory, 'category', 'text',
        kind === 'expense' ? 'e.g. Rent, Salary, Fuel' : 'e.g. Commission, Rebate'
      ));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(comboField(
        'Cash or Bank', bankAccountId,
        [{ id: '', label: 'Cash in hand' }, ...accountOptions],
        setBankAccountId, 'bankAccountId', 'Cash in hand',
        kind === 'expense' ? '(paid from)' : '(received into)'
      ));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'pdc-received':
      fields.push(partyField('Party', partyId, setPartyId, 'partyId'));
      fields.push(comboField('Bank', bankId, bankOptions, setBankId, 'bankId', 'Drawer’s bank'));
      fields.push(textField('Cheque Number', chequeNumber, setChequeNumber, 'chequeNumber'));
      fields.push(textField('Cheque Date', chequeDate, setChequeDate, 'chequeDate', 'date'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Entry Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'pdc-issued':
      fields.push(partyField('Party', partyId, setPartyId, 'partyId'));
      fields.push(comboField('Bank Account', bankAccountId, accountOptions, setBankAccountId, 'bankAccountId', 'Your account'));
      fields.push(textField('Cheque Number', chequeNumber, setChequeNumber, 'chequeNumber'));
      fields.push(textField('Cheque Date', chequeDate, setChequeDate, 'chequeDate', 'date'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Entry Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'cash-received':
    case 'cash-paid':
      fields.push(partyField('Party', partyId, setPartyId, 'partyId'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(comboField(
        'Bank Account', bankAccountId,
        [{ id: '', label: 'Cash in hand' }, ...accountOptions],
        setBankAccountId, 'bankAccountId', 'Cash in hand', '(leave as cash for physical cash)'
      ));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'debit':
    case 'credit':
      fields.push(partyField('Party', partyId, setPartyId, 'partyId'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(textField('Reason / Description', description, setDescription, 'description'));
      break;

    case 'party-transfer':
      fields.push(partyField('From Party', partyId, setPartyId, 'partyId'));
      fields.push(partyField('To Party', toPartyId, setToPartyId, 'toPartyId'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'cheque-transfer':
      fields.push(comboField('Cheque', chequeId, transferableCheques, setChequeId, 'chequeId', 'Select a received cheque'));
      fields.push(partyField('To Party', toPartyId, setToPartyId, 'toPartyId'));
      fields.push(textField(
        'Amount', amount, setAmount, 'amount', 'number', '0.00',
        data.settings.allowPartialAllocation ? '(partial allowed)' : '(full cheque only)'
      ));
      fields.push(textField('Transfer Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'bank-transfer':
      fields.push(comboField('From Account', bankAccountId, accountOptions, setBankAccountId, 'bankAccountId', 'Source account'));
      fields.push(comboField('To Account', toBankAccountId, accountOptions, setToBankAccountId, 'toBankAccountId', 'Destination account'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;
  }

  // Live context so the accountant sees the effect before saving.
  const context = (() => {
    if (kind === 'cheque-transfer' && selectedCheque) {
      const from = data.parties.find((p) => p.id === selectedCheque.partyId)?.name ?? '';
      return `Cheque ${selectedCheque.chequeNumber} from ${from} · ${formatMoney(selectedCheque.amount, cur)} · due ${selectedCheque.chequeDate}`;
    }
    // Plain-language explanation of what this entry will do.
    const who = data.parties.find((p) => p.id === partyId)?.name || 'the party';
    const where = bankAccountId
      ? accountOptions.find((a) => a.id === bankAccountId)?.label ?? 'the bank'
      : 'cash in hand';
    if (kind === 'sale') {
      return settlement === 'credit'
        ? `${who} will owe you this amount. Counts as sales revenue.`
        : `Money goes into ${where}. Counts as sales revenue.`;
    }
    if (kind === 'purchase') {
      return settlement === 'credit'
        ? `You will owe ${who} this amount. Counts as a purchase cost.`
        : `Money comes out of ${where}. Counts as a purchase cost.`;
    }
    if (kind === 'expense') return `Money comes out of ${where} and reduces profit.`;
    if (kind === 'income') return `Money goes into ${where} and increases profit.`;
    return null;
  })();

  return (
    <Modal
      open={!!kind}
      title={TITLES[kind]}
      subtitle={SUBTITLES[kind]}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel (Esc)</button>
          <button className="btn btn-primary" onClick={submit} disabled={store.saving}>
            {store.saving ? 'Saving…' : 'Save (Ctrl+S)'}
          </button>
        </>
      }
    >
      {context && <div className="pdc-form-context">{context}</div>}
      <div className="pdc-form-grid">{fields}</div>
      <div className="faint pdc-form-hint">
        Enter → next field · Shift+Enter → previous · Enter on the last field saves
      </div>
    </Modal>
  );
}
