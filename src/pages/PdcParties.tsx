/**
 * Ali Nawaz PDC — Parties, Banks & Accounts (spec §20, §21)
 *
 * Renaming a party changes only the display name: every transaction references
 * the party ID, so balances and history are untouched (spec §31.8).
 */

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Combo } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import { bankAccountLabel, bankBalances, partyBalances, balanceLabel, partyDeleteImpact } from '@/lib/pdcEngine';
import type { Bank, BankAccount, PdcParty } from '@/types/pdc';
import { PAKISTAN_BANK_OPTIONS, PAKISTAN_BANKS } from '@/config/pakistanBanks';
import { formatMoney, cx } from '@/lib/utils';
import { toast } from '@/store/toast';
import './pdc.css';

type Tab = 'parties' | 'banks';

export function PdcParties() {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const navigate = useNavigate();

  const [params] = useSearchParams();
  // Deep links (e.g. from the Ledger page) can open straight on the Banks tab.
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'banks' ? 'banks' : 'parties');
  const [search, setSearch] = useState('');
  const [partyModal, setPartyModal] = useState<PdcParty | 'new' | null>(null);
  const [bankModal, setBankModal] = useState<Bank | 'new' | null>(null);
  const [accountModal, setAccountModal] = useState<BankAccount | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<PdcParty | null>(null);

  const balances = useMemo(() => partyBalances(data), [data]);
  const bankBals = useMemo(() => bankBalances(data), [data]);

  /** Bulk-add every Pakistani bank, skipping any already present. */
  const addAllBanks = async () => {
    const have = new Set(data.banks.map((b) => b.name.trim().toLowerCase()));
    const missing = PAKISTAN_BANKS.filter((b) => !have.has(b.name.trim().toLowerCase()));
    if (missing.length === 0) {
      toast.info('All Pakistani banks are already added.');
      return;
    }
    let added = 0;
    for (const b of missing) {
      if (await store.saveBank({ name: b.name })) added++;
    }
    toast.success(`Added ${added} bank${added === 1 ? '' : 's'}`);
  };

  const parties = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.parties
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data.parties, search]);

  return (
    <div className="pdc-page">
      <PageHeader title="Parties & Accounts" subtitle="Party ledgers, banks and bank accounts" />

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="pdc-search-row">
          <div className="cashbook-filters" style={{ margin: 0 }}>
            <button className={cx('chip', tab === 'parties' && 'chip-done')} onClick={() => setTab('parties')}>
              Parties ({data.parties.length})
            </button>
            <button className={cx('chip', tab === 'banks' && 'chip-done')} onClick={() => setTab('banks')}>
              Banks ({data.bankAccounts.length} accounts)
            </button>
          </div>
          <div className="pdc-search-box">
            <Icon name="search" size={16} />
            <input
              className="input"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {tab === 'parties' ? (
            <button className="btn btn-primary" onClick={() => setPartyModal('new')}>
              <Icon name="plus" size={15} /> New Party
            </button>
          ) : (
            <>
              <button className="btn" onClick={addAllBanks} disabled={store.saving}>
                <Icon name="bank" size={15} /> Add All Pakistani Banks
              </button>
              <button className="btn" onClick={() => setBankModal('new')}>
                <Icon name="plus" size={15} /> New Bank
              </button>
              <button className="btn btn-primary" onClick={() => setAccountModal('new')}>
                <Icon name="plus" size={15} /> New Account
              </button>
            </>
          )}
        </div>
      </div>

      {tab === 'parties' ? (
        <div className="card">
          {parties.length === 0 ? (
            <div className="empty">No parties yet. Add one to start recording cheques and payments.</div>
          ) : (
            <div className="table-wrap">
              <table className="grid stack-sm">
                <thead>
                  <tr>
                    <th>Party</th>
                    <th className="num">Opening</th><th className="num">Balance</th>
                    <th>Status</th><th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {parties.map((p) => {
                    const bal = balances.get(p.id) ?? 0;
                    return (
                      <tr key={p.id} className={cx(!p.active && 'row-reversed')}>
                        <td data-label="Party">
                          <button className="btn btn-ghost btn-sm" style={{ padding: 0, height: 'auto' }}
                            onClick={() => navigate(`/ledger?party=${p.id}`)}>
                            {p.name}
                          </button>
                        </td>
                        <td data-label="Opening" className="num mono">{formatMoney(p.openingBalance, cur)}</td>
                        <td data-label="Balance" className={cx('num mono', bal > 0 ? 'pos' : bal < 0 ? 'neg' : '')}>
                          {formatMoney(Math.abs(bal), cur)}
                        </td>
                        <td data-label="Status">
                          <span className={cx('pdc-status', bal > 0 ? 'st-cleared' : bal < 0 ? 'st-bounced' : 'st-cancelled')}>
                            {balanceLabel(bal)}
                          </span>
                        </td>
                        <td className="no-print actions-cell">
                          <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost btn-icon btn-sm" title="Ledger"
                              onClick={() => navigate(`/ledger?party=${p.id}`)}>
                              <Icon name="book" size={14} />
                            </button>
                            <button className="btn btn-ghost btn-icon btn-sm" title="Edit"
                              onClick={() => setPartyModal(p)}>
                              <Icon name="settings" size={14} />
                            </button>
                            <button className="btn btn-ghost btn-icon btn-sm del-btn" title="Delete"
                              onClick={() => setToDelete(p)}>
                              <Icon name="trash" size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          {data.bankAccounts.length === 0 ? (
            <div className="empty">No bank accounts yet. Add a bank, then an account under it.</div>
          ) : (
            <div className="table-wrap">
              <table className="grid stack-sm">
                <thead>
                  <tr>
                    <th>Bank</th><th>Account Title</th><th>Account #</th><th>Branch</th>
                    <th className="num">Opening</th><th className="num">Balance</th>
                    <th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.bankAccounts.map((a) => {
                    const bank = data.banks.find((b) => b.id === a.bankId);
                    const bal = bankBals.get(a.id) ?? 0;
                    return (
                      <tr key={a.id} className={cx(!a.active && 'row-reversed')}>
                        <td data-label="Bank">{bank?.name ?? '—'}</td>
                        <td data-label="Account Title">
                          <button className="btn btn-ghost btn-sm" style={{ padding: 0, height: 'auto' }}
                            onClick={() => navigate(`/ledger?account=${a.id}`)}>
                            {a.title}
                          </button>
                        </td>
                        <td data-label="Account #" className="mono">{a.accountNumber || '—'}</td>
                        <td data-label="Branch">{a.branch || '—'}</td>
                        <td data-label="Opening" className="num mono">{formatMoney(a.openingBalance, cur)}</td>
                        <td data-label="Balance" className={cx('num mono', bal >= 0 ? 'pos' : 'neg')}>
                          {formatMoney(bal, cur)}
                        </td>
                        <td className="no-print actions-cell">
                          <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost btn-icon btn-sm" title="Ledger"
                              onClick={() => navigate(`/ledger?account=${a.id}`)}>
                              <Icon name="book" size={14} />
                            </button>
                            <button className="btn btn-ghost btn-icon btn-sm" title="Edit"
                              onClick={() => setAccountModal(a)}>
                              <Icon name="settings" size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <PartyModal party={partyModal} onClose={() => setPartyModal(null)} />
      <BankModal bank={bankModal} onClose={() => setBankModal(null)} />
      <AccountModal account={accountModal} onClose={() => setAccountModal(null)} />

      <ConfirmDialog
        open={!!toDelete}
        title={`Delete ${toDelete?.name ?? 'this party'}?`}
        // State the full impact first — this erases transactions, not just the
        // party record.
        message={(() => {
          if (!toDelete) return '';
          const i = partyDeleteImpact(data, toDelete.id);
          if (i.clean) {
            return `${toDelete.name} has no transactions and will be removed completely.`;
          }
          const bits = [
            `${i.transactions} transaction${i.transactions === 1 ? '' : 's'}`,
            i.cheques ? `${i.cheques} cheque${i.cheques === 1 ? '' : 's'}` : '',
          ].filter(Boolean).join(' and ');
          return `This permanently deletes ${toDelete.name} along with ${bits}. Balances and reports will change to match, and this cannot be undone — download a backup first if you are unsure.`;
        })()}
        confirmLabel="Delete Everything"
        danger
        onConfirm={async () => {
          const p = toDelete;
          setToDelete(null);
          if (p) await store.deleteParty(p.id);
        }}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function PartyModal({ party, onClose }: { party: PdcParty | 'new' | null; onClose: () => void }) {
  const store = usePdc();
  const editing = party && party !== 'new' ? party : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [opening, setOpening] = useState(String(editing?.openingBalance ?? 0));
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [active, setActive] = useState(editing?.active ?? true);

  // Reset the fields whenever a different party is opened.
  const key = editing?.id ?? party;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setName(editing?.name ?? '');
    setOpening(String(editing?.openingBalance ?? 0));
    setNotes(editing?.notes ?? '');
    setActive(editing?.active ?? true);
  }

  if (!party) return null;

  const save = async () => {
    const rec = await store.saveParty({
      id: editing?.id,
      name,
      // Preserve any legacy contact details already saved against the party.
      phone: editing?.phone,
      address: editing?.address,
      cnic: editing?.cnic,
      openingBalance: Number(opening) || 0,
      creditLimit: editing?.creditLimit,
      paymentTerms: editing?.paymentTerms,
      notes: notes || undefined,
      active,
    });
    if (rec) {
      toast.success(editing ? 'Party updated' : 'Party added');
      onClose();
    }
  };

  return (
    <Modal
      open
      title={editing ? 'Edit Party' : 'New Party'}
      subtitle={editing ? 'Renaming is safe — transactions link by ID, not name.' : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </>
      }
    >
      {/* Deliberately minimal: name, opening balance, status and notes. Phone,
          CNIC and address were removed as they slowed down daily entry. */}
      <div className="pdc-form-grid">
        <div className="field">
          <label>Party Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Opening Balance <span className="faint">(+receivable / −payable)</span></label>
            <input className="input" type="number" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </div>
          <div className="field">
            <label>Status</label>
            <select className="input" value={active ? 'active' : 'inactive'}
              onChange={(e) => setActive(e.target.value === 'active')}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Notes <span className="faint">(optional)</span></label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
      </div>
    </Modal>
  );
}

function BankModal({ bank, onClose }: { bank: Bank | 'new' | null; onClose: () => void }) {
  const store = usePdc();
  const editing = bank && bank !== 'new' ? bank : null;
  const [name, setName] = useState(editing?.name ?? '');

  const key = editing?.id ?? bank;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) { setLastKey(key); setName(editing?.name ?? ''); }

  if (!bank) return null;

  const save = async () => {
    if (await store.saveBank({ id: editing?.id, name })) {
      toast.success(editing ? 'Bank updated' : 'Bank added');
      onClose();
    }
  };

  return (
    <Modal open title={editing ? 'Edit Bank' : 'New Bank'} onClose={onClose} width={420}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="field">
        <label>Bank Name</label>
        {/* Pick from the Pakistani banks, or type any other name — allowCreate
            means the list is a shortcut, never a restriction. */}
        <Combo
          value={name}
          options={PAKISTAN_BANK_OPTIONS}
          placeholder="Search or type a bank name"
          allowCreate
          onChange={setName}
          onCreate={async (typed) => { setName(typed); return typed; }}
          onDone={save}
        />
        <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
          {PAKISTAN_BANK_OPTIONS.length} Pakistani banks listed — or type your own.
        </div>
      </div>
    </Modal>
  );
}

function AccountModal({ account, onClose }: { account: BankAccount | 'new' | null; onClose: () => void }) {
  const store = usePdc();
  const data = store.dataset();
  const editing = account && account !== 'new' ? account : null;
  const [bankId, setBankId] = useState(editing?.bankId ?? '');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [accountNumber, setAccountNumber] = useState(editing?.accountNumber ?? '');
  const [iban, setIban] = useState(editing?.iban ?? '');
  const [branch, setBranch] = useState(editing?.branch ?? '');
  const [opening, setOpening] = useState(String(editing?.openingBalance ?? 0));
  const [active, setActive] = useState(editing?.active ?? true);

  const key = editing?.id ?? account;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setBankId(editing?.bankId ?? '');
    setTitle(editing?.title ?? '');
    setAccountNumber(editing?.accountNumber ?? '');
    setIban(editing?.iban ?? '');
    setBranch(editing?.branch ?? '');
    setOpening(String(editing?.openingBalance ?? 0));
    setActive(editing?.active ?? true);
  }

  if (!account) return null;

  const save = async () => {
    if (!bankId) { toast.error('Select a bank first.'); return; }
    const rec = await store.saveBankAccount({
      id: editing?.id, bankId, title,
      accountNumber: accountNumber || undefined,
      iban: iban || undefined,
      branch: branch || undefined,
      openingBalance: Number(opening) || 0,
      active,
    });
    if (rec) {
      toast.success(editing ? 'Account updated' : 'Account added');
      onClose();
    }
  };

  return (
    <Modal open title={editing ? 'Edit Bank Account' : 'New Bank Account'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="pdc-form-grid">
        <div className="field">
          <label>Bank</label>
          <Combo
            value={bankId}
            options={data.banks.map((b) => ({ id: b.id, label: b.name }))}
            placeholder="Select bank"
            allowCreate
            onChange={setBankId}
            onCreate={async (name) => (await store.saveBank({ name }))?.id ?? ''}
          />
        </div>
        <div className="field">
          <label>Account Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Main Account" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Account Number</label>
            <input className="input" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} />
          </div>
          <div className="field">
            <label>Branch</label>
            <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label>IBAN</label>
            <input className="input" value={iban} onChange={(e) => setIban(e.target.value)} />
          </div>
          <div className="field">
            <label>Opening Balance</label>
            <input className="input" type="number" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Status</label>
          <select className="input" value={active ? 'active' : 'inactive'}
            onChange={(e) => setActive(e.target.value === 'active')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
