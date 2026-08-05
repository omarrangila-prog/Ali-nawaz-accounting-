/**
 * Ali Nawaz PDC — cheque status actions (spec §17, §19)
 *
 * Small confirm dialogs for deposit / clear / bounce / cancel. Every action
 * routes through the workflow builders, so an illegal status move is rejected
 * with a readable reason instead of silently corrupting the ledger.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Combo } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import {
  buildChequeBounce,
  buildChequeClear,
  buildChequeDeposit,
  buildChequeReturn,
  isDuplicateCheque,
  linkReplacement,
} from '@/lib/chequeWorkflow';
import { PAKISTAN_BANKS } from '@/config/pakistanBanks';
import { bankAccountLabel } from '@/lib/pdcEngine';
import type { Cheque } from '@/types/pdc';
import { todayISO, formatMoney } from '@/lib/utils';
import { toast } from '@/store/toast';

export type ChequeAction = 'deposit' | 'clear' | 'bounce' | 'cancel' | 'replace' | 'edit' | 'return' | null;

interface Props {
  action: ChequeAction;
  cheque: Cheque | null;
  onClose: () => void;
}

export function ChequeActionDialog({ action, cheque, onClose }: Props) {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;

  const [bankAccountId, setBankAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayISO());
  const [replacementId, setReplacementId] = useState('');
  // --- edit form ---
  const [editNumber, setEditNumber] = useState('');
  const [editBankId, setEditBankId] = useState('');
  const [editChequeDate, setEditChequeDate] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDrawer, setEditDrawer] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editReason, setEditReason] = useState('');

  useEffect(() => {
    if (!action) return;
    setBankAccountId(cheque?.bankAccountId ?? '');
    setReason('');
    setDate(todayISO());
    setReplacementId('');
    setEditNumber(cheque?.chequeNumber ?? '');
    setEditBankId(cheque?.bankId ?? '');
    setEditChequeDate(cheque?.chequeDate ?? '');
    setEditAmount(String(cheque?.amount ?? ''));
    setEditDrawer(cheque?.drawerName ?? '');
    setEditDesc(cheque?.description ?? '');
    setEditReason('');
  }, [action, cheque]);

  if (!action || !cheque) return null;

  const accountOptions = data.bankAccounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, label: bankAccountLabel(data.banks, data.bankAccounts, a.id) }));

  /** Banks on file, then every Pakistani bank — created on first use. */
  const SUGGEST = 'new-bank:';
  const have = data.banks.filter((b) => b.active).map((b) => ({ id: b.id, label: b.name }));
  const haveNames = new Set(have.map((b) => b.label.trim().toLowerCase()));
  const bankOptions = [
    ...have,
    ...PAKISTAN_BANKS
      .filter((b) => !haveNames.has(b.name.trim().toLowerCase()))
      .map((b) => ({ id: `${SUGGEST}${b.name}`, label: b.name, sub: b.kind })),
  ];

  /** Turn a suggested bank into a real one before storing its id. */
  const resolveEditBank = async (value: string) => {
    if (!value.startsWith(SUGGEST)) { setEditBankId(value); return; }
    const name = value.slice(SUGGEST.length);
    const existing = data.banks.find(
      (b) => b.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    const bank = existing ?? (await store.saveBank({ name }));
    if (bank) setEditBankId(bank.id);
  };

  /** Cheques that could serve as a replacement for this bounced one. */
  const replacementOptions = data.cheques
    .filter((c) => c.id !== cheque.id && c.partyId === cheque.partyId && !c.replacesChequeId)
    .map((c) => ({ id: c.id, label: `${c.chequeNumber} · ${formatMoney(c.amount, cur)}`, sub: `due ${c.chequeDate}` }));

  async function run() {
    if (store.saving) return;

    if (action === 'deposit') {
      if (!bankAccountId) { toast.error('Select the bank account.'); return; }
      const res = buildChequeDeposit(data, { chequeId: cheque!.id, bankAccountId, date });
      if ('error' in res) { toast.error(res.error); return; }
      if (await store.commit(res, { action: 'status-change' })) {
        toast.success('Cheque marked deposited');
        onClose();
      }
      return;
    }

    if (action === 'clear') {
      const res = buildChequeClear(data, { chequeId: cheque!.id, bankAccountId: bankAccountId || undefined, date });
      if ('error' in res) { toast.error(res.error); return; }
      if (await store.commit(res, { action: 'cheque-clear' })) {
        toast.success('Cheque cleared');
        onClose();
      }
      return;
    }

    if (action === 'bounce') {
      if (!reason.trim()) { toast.error('Enter the bounce reason.'); return; }
      const res = buildChequeBounce(data, { chequeId: cheque!.id, date, reason });
      if ('error' in res) { toast.error(res.error); return; }
      if (await store.commit(res, { action: 'cheque-bounce', reason })) {
        toast.success('Cheque marked bounced — balances restored');
        onClose();
      }
      return;
    }

    if (action === 'cancel') {
      if (cheque!.status === 'cleared') {
        toast.error('A cleared cheque cannot be cancelled. Reverse the clearance first.');
        return;
      }
      await store.saveCheque({ ...cheque!, status: 'cancelled', holder: { kind: 'business' } });
      await store.logAudit({
        action: 'status-change', entity: 'cheque', entityId: cheque!.id,
        before: { status: cheque!.status }, after: { status: 'cancelled' },
        description: `Cheque ${cheque!.chequeNumber} cancelled`,
      });
      toast.success('Cheque cancelled');
      onClose();
      return;
    }

    if (action === 'edit') {
      // Number, date and bank stay optional here as well. This dialog is how a
      // cheque recorded without them gets completed later, so it must accept a
      // partly-filled cheque exactly as the entry form does. Only the amount
      // has to be real, because the ledger already carries it.
      const num = editNumber.trim();
      const amt = Number(editAmount);
      if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount.'); return; }
      if (num && editBankId && isDuplicateCheque(
        data,
        { chequeNumber: num, bankId: editBankId, direction: cheque!.direction },
        cheque!.id
      )) {
        toast.error('That cheque number already exists for this bank.');
        return;
      }

      const ok = await store.updateChequeDetails(
        cheque!.id,
        {
          chequeNumber: num,
          // An unknown due date keeps the date the cheque was recorded on,
          // rather than going blank and sorting before every real cheque.
          chequeDate: editChequeDate || cheque!.date,
          bankId: editBankId,
          amount: amt,
          drawerName: editDrawer || undefined,
          description: editDesc || undefined,
        },
        editReason || undefined
      );
      if (ok) onClose();
      return;
    }

    if (action === 'return') {
      const res = buildChequeReturn(data, { chequeId: cheque!.id, date, reason: reason || undefined });
      if ('error' in res) { toast.error(res.error); return; }
      if (await store.commit(res, { action: 'status-change', reason })) {
        toast.success('Cheque returned — balances restored');
        onClose();
      }
      return;
    }

    if (action === 'replace') {
      if (!replacementId) { toast.error('Select the replacement cheque.'); return; }
      const res = linkReplacement(data, {
        originalChequeId: cheque!.id, replacementChequeId: replacementId, date,
      });
      if ('error' in res) { toast.error(res.error); return; }
      await store.saveCheque(res.original);
      await store.saveCheque(res.replacement);
      await store.logAudit({
        action: 'cheque-replace', entity: 'cheque', entityId: cheque!.id,
        description: `Cheque ${cheque!.chequeNumber} replaced`,
      });
      toast.success('Replacement linked');
      onClose();
    }
  }

  const titles: Record<NonNullable<ChequeAction>, string> = {
    deposit: 'Deposit Cheque',
    clear: 'Mark Cheque Cleared',
    bounce: 'Mark Cheque Bounced',
    cancel: 'Cancel Cheque',
    replace: 'Link Replacement Cheque',
    edit: 'Edit Cheque Details',
    return: 'Return Cheque',
  };

  return (
    <Modal
      open
      title={titles[action]}
      subtitle={`${cheque.chequeNumber ? `Cheque ${cheque.chequeNumber}` : 'Cheque (number not recorded yet)'} · ${formatMoney(cheque.amount, cur)} · due ${cheque.chequeDate}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={action === 'bounce' || action === 'cancel' || action === 'return' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={run}
            disabled={store.saving}
          >
            {store.saving ? 'Saving…' : 'Confirm'}
          </button>
        </>
      }
    >
      <div className="pdc-form-grid">
        {(action === 'deposit' || action === 'clear') && (
          <div className="field">
            <label>Bank Account</label>
            <Combo
              value={bankAccountId}
              options={accountOptions}
              placeholder="Select account"
              onChange={setBankAccountId}
            />
          </div>
        )}
        {(action === 'bounce' || action === 'return') && (
          <div className="field">
            <label>{action === 'bounce' ? 'Bounce Reason' : 'Reason (optional)'}</label>
            <input
              className="input"
              autoFocus
              value={reason}
              placeholder={action === 'bounce' ? 'e.g. Insufficient funds' : 'e.g. party asked for it back'}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        {action === 'edit' && (
          <>
            <div className="grid-2">
              <div className="field">
                <label>Cheque Number <span className="faint">(optional)</span></label>
                <input className="input" autoFocus value={editNumber}
                  placeholder="Fill in when you have the cheque"
                  onChange={(e) => setEditNumber(e.target.value)} />
              </div>
              <div className="field">
                <label>Cheque Date <span className="faint">(optional)</span></label>
                <input className="input" type="date" value={editChequeDate}
                  onChange={(e) => setEditChequeDate(e.target.value)} />
              </div>
            </div>
            {/* The bank belongs here too, so a cheque taken in without any
                details can be identified fully from this one dialog. */}
            <div className="field">
              <label>Bank <span className="faint">(optional)</span></label>
              <Combo
                value={editBankId}
                options={bankOptions}
                placeholder="Search any bank"
                onChange={resolveEditBank}
              />
            </div>
            <div className="field">
              <label>Amount</label>
              <input className="input" type="number" value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)} />
            </div>
            <div className="field">
              <label>Drawer Name <span className="faint">(optional)</span></label>
              <input className="input" value={editDrawer}
                onChange={(e) => setEditDrawer(e.target.value)} />
            </div>
            <div className="field">
              <label>Description <span className="faint">(optional)</span></label>
              <input className="input" value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)} />
            </div>
            <div className="field">
              <label>Reason for the change <span className="faint">(kept in the audit trail)</span></label>
              <input className="input" value={editReason} placeholder="e.g. typed the wrong amount"
                onChange={(e) => setEditReason(e.target.value)} />
            </div>
            <div className="pdc-warn" style={{ marginTop: 0 }}>
              This corrects the cheque's own details. It does not re-post the
              accounting entry — if the amount already moved money, reverse that
              entry from the register instead.
            </div>
          </>
        )}
        {action === 'replace' && (
          <div className="field">
            <label>Replacement Cheque</label>
            <Combo
              value={replacementId}
              options={replacementOptions}
              placeholder="Select the new cheque"
              onChange={setReplacementId}
            />
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
              Record the new cheque first with F1 / F2, then link it here. The bounced
              cheque stays in history.
            </div>
          </div>
        )}
        <div className="field">
          <label>Date</label>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {action === 'bounce' && (
        <div className="pdc-warn">
          This restores the original receivable/payable and updates the party ledger — it is
          not just a status change.
        </div>
      )}
    </Modal>
  );
}
