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
import { todayISO, formatMoney, round2, cx } from '@/lib/utils';
import { PAKISTAN_BANKS } from '@/config/pakistanBanks';

/** Marks a dropdown option that is a bank SUGGESTION, not an existing account. */
const SUGGEST = 'new-bank:';
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
  'cash-received': 'Receive',
  'cash-paid': 'Pay',
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
  'cash-received': 'F3 · money received — cash or cheque',
  'cash-paid': 'F4 · money paid — cash or cheque',
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
  /**
   * How the entry settles. 'bank' and 'cash' both move money now — they only
   * differ in WHERE it lands, so choosing 'bank' reveals the account picker.
   * 'credit' and 'debit' leave it on the party's account instead.
   */
  const [format, setFormat] = useState<'bank' | 'cash' | 'credit' | 'debit' | 'cheque'>('cash');
  /** Optional quantity × rate; when both are set they drive the amount. */
  const [showMore, setShowMore] = useState(false);
  const [itemName, setItemName] = useState('');
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('');
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
    setFormat('cash');
    setShowMore(false);
    setItemName('');
    setQty('');
    setRate('');
    setErrors({});
  }, [kind, defaultParty, defaultCheque]);

  // Quantity × rate drives the amount, so the user never multiplies by hand.
  useEffect(() => {
    const q = Number(qty);
    const r = Number(rate);
    if (qty.trim() && rate.trim() && Number.isFinite(q) && Number.isFinite(r)) {
      setAmount(String(round2(q * r)));
    }
  }, [qty, rate]);

  // The format selector IS the settlement choice — keep them in step so the
  // engine still receives a plain 'cash' | 'credit'.
  useEffect(() => {
    // A cheque settles the party immediately (the debt moves onto the cheque),
    // so it counts as 'cash' for the accounting even though no money moved yet.
    setSettlement(format === 'credit' || format === 'debit' ? 'credit' : 'cash');
    // Only a bank settlement needs an account; the others clear it.
    if (format !== 'bank') setBankAccountId('');
    if (format !== 'cheque') { setChequeNumber(''); setChequeDate(''); setBankId(''); }
  }, [format]);

  // --- options -------------------------------------------------------------
  const partyOptions = useMemo(
    () => data.parties.filter((p) => p.active).map((p) => ({ id: p.id, label: p.name })),
    [data.parties]
  );
  const bankOptions = useMemo(() => {
    const have = data.banks.filter((b) => b.active).map((b) => ({ id: b.id, label: b.name }));
    const haveNames = new Set(have.map((b) => b.label.trim().toLowerCase()));
    // Any Pakistani bank can be picked straight away and is created on choosing.
    const rest = PAKISTAN_BANKS
      .filter((b) => !haveNames.has(b.name.trim().toLowerCase()))
      .map((b) => ({ id: `${SUGGEST}${b.name}`, label: b.name, sub: b.kind }));
    return [...have, ...rest];
  }, [data.banks]);

  /** Resolve a suggested bank into a real one before storing its id. */
  const resolveBank = async (value: string) => {
    if (!value.startsWith(SUGGEST)) { setBankId(value); return; }
    const name = value.slice(SUGGEST.length);
    const existing = data.banks.find((b) => b.name.trim().toLowerCase() === name.trim().toLowerCase());
    const bank = existing ?? (await store.saveBank({ name }));
    if (bank) setBankId(bank.id);
  };
  /**
   * Accounts the user has, PLUS every Pakistani bank as a one-click option.
   * Picking a suggestion creates the bank and its account immediately, so the
   * list is never a dead end and the form never needs reopening.
   */
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

  /** Suggestions for banks the user has no account with yet. */
  const bankSuggestions = useMemo(() => {
    const haveBankIds = new Set(data.bankAccounts.map((a) => a.bankId));
    const usedNames = new Set(
      data.banks.filter((b) => haveBankIds.has(b.id)).map((b) => b.name.trim().toLowerCase())
    );
    return PAKISTAN_BANKS
      .filter((b) => !usedNames.has(b.name.trim().toLowerCase()))
      .map((b) => ({ id: `${SUGGEST}${b.name}`, label: b.name, sub: `${b.kind} · create account` }));
  }, [data.banks, data.bankAccounts]);

  /** Every option for an account picker: real accounts first, then suggestions. */
  const accountPickerOptions = useMemo(
    () => [...accountOptions, ...bankSuggestions],
    [accountOptions, bankSuggestions]
  );

  /**
   * Turn a chosen suggestion into a real bank + account, then select it.
   * Anything else is an existing account id and passes straight through.
   */
  const resolveAccount = async (value: string, set: (v: string) => void) => {
    if (!value.startsWith(SUGGEST)) { set(value); return; }
    const bankName = value.slice(SUGGEST.length);
    const existingBank = data.banks.find(
      (b) => b.name.trim().toLowerCase() === bankName.trim().toLowerCase()
    );
    const bank = existingBank ?? (await store.saveBank({ name: bankName }));
    if (!bank) { toast.error('Could not create that bank.'); return; }
    const acct = await store.saveBankAccount({ bankId: bank.id, title: 'Main Account' });
    if (!acct) { toast.error('Could not create the account.'); return; }
    set(acct.id);
    toast.success(`${bank.name} — ${acct.title} ready`);
  };
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
    // Receiving or paying by cheque: every cheque detail is OPTIONAL. The
    // receipt is the fact that matters and must save even when the cheque is
    // still in an envelope on the desk — the number, bank and date can be
    // filled in later by editing the transaction.
    if (format === 'cheque' && ['cash-received', 'cash-paid'].includes(kind ?? '')) {
      const dir = kind === 'cash-received' ? 'received' : 'issued';
      // Only guard against a genuine clash, and only once a number is typed.
      if (bankId && chequeNumber.trim() &&
          isDuplicateCheque(data, { chequeNumber, bankId, direction: dir })) {
        e.chequeNumber = 'That cheque number already exists for this bank.';
      }
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
      // A trade always posts to the party ledger. Settlement happens later
      // through Receive / Pay, so no bank, cash or cheque is touched here.
      case 'sale':
        ok = await store.commit(
          buildSale(data, {
            partyId, amount: amt, date, settlement: 'credit', description,
            quantity: qty.trim() ? Number(qty) : undefined,
            rate: rate.trim() ? Number(rate) : undefined,
            itemName: itemName.trim() || undefined,
          })
        );
        break;
      case 'purchase':
        ok = await store.commit(
          buildPurchase(data, {
            partyId, amount: amt, date, settlement: 'credit', description,
            quantity: qty.trim() ? Number(qty) : undefined,
            rate: rate.trim() ? Number(rate) : undefined,
            itemName: itemName.trim() || undefined,
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
          buildCashReceived(data, {
            partyId, amount: amt, date, description,
            bankAccountId: format === 'bank' ? bankAccountId || undefined : undefined,
            paymentMethod: format === 'cheque' ? 'cheque' : format === 'bank' ? 'bank' : 'cash',
            cheque: format === 'cheque'
              ? { chequeNumber: chequeNumber.trim(), chequeDate, bankId }
              : undefined,
          })
        );
        break;
      case 'cash-paid':
        ok = await store.commit(
          buildCashPaid(data, {
            partyId, amount: amt, date, description,
            bankAccountId: format === 'bank' ? bankAccountId || undefined : undefined,
            paymentMethod: format === 'cheque' ? 'cheque' : format === 'bank' ? 'bank' : 'cash',
            cheque: format === 'cheque'
              ? { chequeNumber: chequeNumber.trim(), chequeDate, bankId }
              : undefined,
          })
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
      // qty, rate, item, party, amount, date, desc
      case 'sale':
      case 'purchase': return 7;
      // category, qty, rate, amount, format, [account], date, desc
      case 'expense':
      case 'income': return 8;
      case 'pdc-received': return 7;   // party, bank, cheque#, cheque date, amount, date, desc
      case 'pdc-issued': return 7;     // party, account, cheque#, cheque date, amount, date, desc
      // party, amount, format, [cheque x3 | account], date, desc
      case 'cash-received':
      case 'cash-paid': return format === 'cheque' ? 8 : 6;
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
    onChange: (v: string) => void, errKey: string, placeholder: string, hint?: string,
    /** Creates a record from a typed name, so an empty list is never a dead end. */
    onCreate?: (typed: string) => Promise<string>
  ) => {
    const idx = i++;
    // A dropdown with nothing in it looks broken. Say what is missing and
    // where to add it, rather than leaving an empty list.
    const empty = options.filter((o) => o.id !== '').length === 0;
    return (
      <Field key={errKey} label={label} error={errors[errKey]} hint={hint}>
        <Combo
          ref={chain.set(idx)}
          value={value}
          options={options}
          placeholder={
            empty
              ? (onCreate ? `Type a name to create one` : `No ${label.toLowerCase()} available`)
              : placeholder
          }
          invalid={!!errors[errKey]}
          allowCreate={!!onCreate}
          onCreate={onCreate}
          onChange={onChange}
          onDone={() => chain.focusAt(idx + 1)}
        />
        {empty && (
          <div className="field-empty-hint">
            Nothing here yet — type a name and press Enter to create it.
          </div>
        )}
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

  /** Collapses the optional fields so the common entry stays short. */
  const moreToggle = () => (
    <button
      key="more"
      type="button"
      className="link-btn"
      style={{ alignSelf: 'flex-start' }}
      onClick={() => setShowMore((v) => !v)}
    >
      {showMore ? 'Hide' : 'More'} details — item, quantity, description
    </button>
  );

  /**
   * Create a bank account from a typed name, so an empty account dropdown can
   * be resolved without leaving the entry form. It attaches to the first bank
   * on file; the account can be moved and detailed later under Parties & Banks.
   */
  const createAccount = async (typed: string): Promise<string> => {
    const name = typed.trim();
    if (!name) return '';

    // Typing a bank's name creates the BANK and its account together, so the
    // entry never has to be abandoned to go and set one up first. A name that
    // matches a bank already on file (or any Pakistani bank) attaches to it;
    // anything else becomes an account under the first bank.
    const known =
      data.banks.find((b) => b.name.trim().toLowerCase() === name.toLowerCase()) ??
      (PAKISTAN_BANKS.some((b) => b.name.trim().toLowerCase() === name.toLowerCase())
        ? await store.saveBank({ name })
        : undefined);

    const bank = known ?? data.banks[0] ?? (await store.saveBank({ name }));
    if (!bank) { toast.error('Could not create that bank.'); return ''; }

    // Naming the bank itself makes this its main account; naming something
    // else makes that the account title under the bank we have.
    const title = bank.name.trim().toLowerCase() === name.toLowerCase() ? 'Main Account' : name;
    const rec = await store.saveBankAccount({ bankId: bank.id, title });
    if (rec) toast.success(`Created ${bank.name} — ${rec.title}`);
    return rec?.id ?? '';
  };

  /**
   * Quantity and Rate side by side. Filling both multiplies into Amount;
   * leaving them blank lets the user type a lump sum instead.
   */
  const qtyRateField = () => {
    const qi = i++;
    const ri = i++;
    return (
      <div className="field" key="qtyrate">
        <label>Quantity &amp; Rate <span className="faint">(optional — fills the amount)</span></label>
        <div className="grid-2">
          <input
            ref={chain.set(qi) as any}
            className="input"
            type="number"
            inputMode="decimal"
            placeholder="Qty"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={chain.keyHandler(qi)}
          />
          <input
            ref={chain.set(ri) as any}
            className="input"
            type="number"
            inputMode="decimal"
            placeholder="Rate"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onKeyDown={chain.keyHandler(ri)}
          />
        </div>
      </div>
    );
  };

  /** Four buttons choosing how the entry settles. */
  const formatButtons = (
    opts: Array<{ id: 'bank' | 'cash' | 'credit' | 'debit' | 'cheque'; label: string; hint: string }>,
    label: string
  ) => {
    const idx = i++;
    return (
      <div className="field" key="format">
        <label>{label}</label>
        {/* Keyboard-reachable: ←/→ pick a format, Enter moves on, so the whole
            form can still be completed without touching the mouse. */}
        <div
          className="format-picker"
          ref={chain.set(idx) as any}
          tabIndex={0}
          role="radiogroup"
          aria-label={label}
          onKeyDown={(e) => {
            const at = opts.findIndex((o) => o.id === format);
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              setFormat(opts[(at + 1) % opts.length].id);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              setFormat(opts[(at - 1 + opts.length) % opts.length].id);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) chain.focusAt(idx - 1);
              else chain.focusAt(idx + 1);
            }
          }}
        >
          {opts.map((o) => (
            <button
              key={o.id}
              type="button"
              tabIndex={-1}
              role="radio"
              aria-checked={format === o.id}
              className={cx('format-btn', format === o.id && 'on')}
              onClick={() => setFormat(o.id)}
              title={o.hint}
            >
              <span className="format-btn-label">{o.label}</span>
              <span className="format-btn-hint">{o.hint}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  /** Sale / Purchase / Receive / Pay: cash in hand, or a cheque. */
  const formatField = (isSale: boolean) =>
    formatButtons(
      [
        { id: 'cash', label: 'Cash', hint: isSale ? 'cash received now' : 'cash paid now' },
        { id: 'cheque', label: 'Cheque', hint: 'recorded now, clears later' },
      ],
      'Payment'
    );

  /**
   * The cheque fields, shown only when Cheque is the chosen payment. All three
   * are OPTIONAL — the receipt saves without them and they can be filled in
   * later by editing the transaction.
   */
  const chequeFields = (received: boolean) => [
    comboField('Cheque Bank', bankId, bankOptions, resolveBank, 'bankId',
      received ? 'Bank it is drawn on' : 'Your bank', '(optional — add later)'),
    textField('Cheque Number', chequeNumber, setChequeNumber, 'chequeNumber', 'text',
      'Leave blank if not to hand', '(optional — add later)'),
    textField('Cheque Date', chequeDate, setChequeDate, 'chequeDate', 'date',
      undefined, '(optional — when it can be presented)'),
  ];

  /**
   * Expense / Income / Cash entries always move money now, so only the
   * destination matters — Cash or Bank.
   */
  const moneySourceField = (verb: string) =>
    formatButtons(
      [
        { id: 'cash', label: 'Cash', hint: `${verb} cash in hand` },
        { id: 'bank', label: 'Bank', hint: `${verb} a bank account` },
      ],
      'Format'
    );

  switch (kind) {
    case 'sale':
    case 'purchase': {
      const isSale = kind === 'sale';
      // A Sale/Purchase records the TRADE only. No payment is taken here —
      // money is collected through Receive and paid through Pay, so the party
      // ledger always carries the balance between the two. Quantity and Rate
      // lead, because that is what the user reads off the invoice first.
      fields.push(qtyRateField());
      fields.push(textField('Item / Product', itemName, setItemName, 'itemName', 'text',
        isSale ? 'what you sold' : 'what you bought'));
      fields.push(partyField(isSale ? 'Customer' : 'Supplier', partyId, setPartyId, 'partyId'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00',
        qty.trim() && rate.trim() ? '(qty × rate)' : '(or enter directly)'));
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
      fields.push(qtyRateField());
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00',
        qty.trim() && rate.trim() ? '(qty × rate)' : '(or enter directly)'));
      fields.push(moneySourceField(kind === 'expense' ? 'paid from' : 'received into'));
      if (format === 'bank') {
        fields.push(comboField(
          'Bank Account', bankAccountId, accountPickerOptions,
          (v) => resolveAccount(v, setBankAccountId), 'bankAccountId', 'Select, search or type a bank',
          undefined, createAccount
        ));
      }
      fields.push(textField('Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'pdc-received':
      fields.push(partyField('Party', partyId, setPartyId, 'partyId'));
      fields.push(comboField('Bank', bankId, bankOptions, resolveBank, 'bankId', 'Search any bank'));
      fields.push(textField('Cheque Number', chequeNumber, setChequeNumber, 'chequeNumber'));
      fields.push(textField('Cheque Date', chequeDate, setChequeDate, 'chequeDate', 'date'));
      fields.push(textField('Amount', amount, setAmount, 'amount', 'number', '0.00'));
      fields.push(textField('Entry Date', date, setDate, 'date', 'date'));
      fields.push(textField('Description', description, setDescription, 'description', 'text', 'Optional'));
      break;

    case 'pdc-issued':
      fields.push(partyField('Party', partyId, setPartyId, 'partyId'));
      fields.push(comboField('Bank Account', bankAccountId, accountPickerOptions,
        (v) => resolveAccount(v, setBankAccountId), 'bankAccountId', 'Select, search or type a bank',
        undefined, createAccount));
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
      // Cash or cheque, both handled here — no separate Cheques screen.
      fields.push(formatField(kind === 'cash-received'));
      if (format === 'cheque') fields.push(...chequeFields(kind === 'cash-received'));
      if (format === 'bank') {
        fields.push(comboField(
          'Bank Account', bankAccountId, accountPickerOptions,
          (v) => resolveAccount(v, setBankAccountId), 'bankAccountId', 'Select, search or type a bank',
          undefined, createAccount
        ));
      }
      fields.push(textField('Date', date, setDate, 'date', 'date'));
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
      fields.push(comboField('From Account', bankAccountId, accountPickerOptions,
        (v) => resolveAccount(v, setBankAccountId), 'bankAccountId', 'Source account',
        undefined, createAccount));
      fields.push(comboField('To Account', toBankAccountId, accountPickerOptions,
        (v) => resolveAccount(v, setToBankAccountId), 'toBankAccountId', 'Destination account',
        undefined, createAccount));
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
