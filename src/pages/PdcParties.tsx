/**
 * Ali Nawaz PDC — Parties, Banks & Accounts (spec §20, §21)
 *
 * Renaming a party changes only the display name: every transaction references
 * the party ID, so balances and history are untouched (spec §31.8).
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Combo } from '@/components/ui/Combo';
import { usePdc } from '@/store/pdcStore';
import { bankAccountLabel, bankBalances, partyBalances, balanceLabel } from '@/lib/pdcEngine';
import type { Bank, BankAccount, PdcParty } from '@/types/pdc';
import { formatMoney, cx } from '@/lib/utils';
import { toast } from '@/store/toast';
import './pdc.css';

type Tab = 'parties' | 'banks';

export function PdcParties() {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('parties');
  const [search, setSearch] = useState('');
  const [partyModal, setPartyModal] = useState<PdcParty | 'new' | null>(null);
  const [bankModal, setBankModal] = useState<Bank | 'new' | null>(null);
  const [accountModal, setAccountModal] = useState<BankAccount | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<PdcParty | null>(null);

  const balances = useMemo(() => partyBalances(data), [data]);
  const bankBals = useMemo(() => bankBalances(data), [data]);

  const parties = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.parties
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.phone ?? '').includes(q))
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
              <button className="btn" onClick={() => setBankModal('new')}>
                <Icon name="bank" size={15} /> New Bank
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
                    <th>Party</th><th>Phone</th><th>CNIC / Reg#</th>
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
                        <td data-label="Phone">{p.phone || '—'}</td>
                        <td data-label="CNIC / Reg#">{p.cnic || '—'}</td>
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
        title="Delete this party?"
        message="A party with any transaction history is marked inactive instead of deleted, so balances and ledgers stay intact."
        confirmLabel="Delete"
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
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [address, setAddress] = useState(editing?.address ?? '');
  const [cnic, setCnic] = useState(editing?.cnic ?? '');
  const [opening, setOpening] = useState(String(editing?.openingBalance ?? 0));
  const [creditLimit, setCreditLimit] = useState(String(editing?.creditLimit ?? ''));
  const [terms, setTerms] = useState(editing?.paymentTerms ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [active, setActive] = useState(editing?.active ?? true);

  // Reset the fields whenever a different party is opened.
  const key = editing?.id ?? party;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setName(editing?.name ?? '');
    setPhone(editing?.phone ?? '');
    setAddress(editing?.address ?? '');
    setCnic(editing?.cnic ?? '');
    setOpening(String(editing?.openingBalance ?? 0));
    setCreditLimit(String(editing?.creditLimit ?? ''));
    setTerms(editing?.paymentTerms ?? '');
    setNotes(editing?.notes ?? '');
    setActive(editing?.active ?? true);
  }

  if (!party) return null;

  const save = async () => {
    const rec = await store.saveParty({
      id: editing?.id,
      name,
      phone: phone || undefined,
      address: address || undefined,
      cnic: cnic || undefined,
      openingBalance: Number(opening) || 0,
      creditLimit: creditLimit ? Number(creditLimit) : undefined,
      paymentTerms: terms || undefined,
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
      <div className="pdc-form-grid">
        <div className="field">
          <label>Party Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Phone</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="field">
            <label>CNIC / Registration #</label>
            <input className="input" value={cnic} onChange={(e) => setCnic(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Address</label>
          <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Opening Balance <span className="faint">(+receivable / −payable)</span></label>
            <input className="input" type="number" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </div>
          <div className="field">
            <label>Credit Limit <span className="faint">(optional)</span></label>
            <input className="input" type="number" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Payment Terms</label>
            <input className="input" placeholder="e.g. 30 days" value={terms} onChange={(e) => setTerms(e.target.value)} />
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
          <label>Notes</label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
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
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="e.g. HBL, Meezan Bank" />
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
