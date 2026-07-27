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
  linkReplacement,
} from '@/lib/chequeWorkflow';
import { bankAccountLabel } from '@/lib/pdcEngine';
import type { Cheque } from '@/types/pdc';
import { todayISO, formatMoney } from '@/lib/utils';
import { toast } from '@/store/toast';

export type ChequeAction = 'deposit' | 'clear' | 'bounce' | 'cancel' | 'replace' | null;

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

  useEffect(() => {
    if (!action) return;
    setBankAccountId(cheque?.bankAccountId ?? '');
    setReason('');
    setDate(todayISO());
    setReplacementId('');
  }, [action, cheque]);

  if (!action || !cheque) return null;

  const accountOptions = data.bankAccounts
    .filter((a) => a.active)
    .map((a) => ({ id: a.id, label: bankAccountLabel(data.banks, data.bankAccounts, a.id) }));

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
  };

  return (
    <Modal
      open
      title={titles[action]}
      subtitle={`Cheque ${cheque.chequeNumber} · ${formatMoney(cheque.amount, cur)} · due ${cheque.chequeDate}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className={action === 'bounce' || action === 'cancel' ? 'btn btn-danger' : 'btn btn-primary'}
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
        {action === 'bounce' && (
          <div className="field">
            <label>Bounce Reason</label>
            <input
              className="input"
              autoFocus
              value={reason}
              placeholder="e.g. Insufficient funds"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
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
