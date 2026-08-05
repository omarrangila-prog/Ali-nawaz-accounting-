/**
 * Named Ledgers — Najeeb, Kamran, Yameen, Muneeb…
 *
 * Two views in one page:
 *   • no ledger selected → the list, with each ledger's rolled-up total
 *   • a ledger selected  → its own page: own balance, every assigned party,
 *     and the combined figure
 *
 * A ledger's total = entries posted directly to it + the balances of every
 * party assigned to it. A party may belong to several ledgers, so totals can
 * overlap; shared parties are marked rather than silently double-counted.
 */

import { useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { usePdc } from '@/store/pdcStore';
import { buildAllLedgerViews, buildLedgerView, balanceLabel, ledgerDeleteImpact } from '@/lib/pdcEngine';
import type { NamedLedger } from '@/types/pdc';
import { formatMoney, cx } from '@/lib/utils';
import { toast } from '@/store/toast';
import './pdc.css';

export function PdcLedgers() {
  const [params, setParams] = useSearchParams();
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const navigate = useNavigate();

  const selectedId = params.get('id') ?? '';
  const [modal, setModal] = useState<NamedLedger | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<NamedLedger | null>(null);
  const [assignFor, setAssignFor] = useState<string | null>(null);

  const views = useMemo(() => buildAllLedgerViews(data), [data]);
  const view = useMemo(
    () => (selectedId ? buildLedgerView(data, selectedId) : null),
    [data, selectedId]
  );

  const open = (id: string) => setParams(id ? { id } : {}, { replace: false });

  // ---- Individual ledger page ---------------------------------------------
  if (selectedId && view) {
    const v = view;
    return (
      <div className="pdc-page">
        <PageHeader
          title={v.ledger.name}
          subtitle={v.ledger.description || 'Ledger — own entries and assigned parties'}
        />

        <div className="pdc-search-row no-print" style={{ marginBottom: 12 }}>
          <button className="btn" onClick={() => open('')}>
            <Icon name="chevron" size={15} style={{ transform: 'rotate(90deg)' }} /> All Ledgers
          </button>
          <button className="btn" onClick={() => setModal(v.ledger)}>
            <Icon name="settings" size={15} /> Edit
          </button>
          <button className="btn btn-primary" onClick={() => setAssignFor(v.ledger.id)}>
            <Icon name="plus" size={15} /> Assign Parties
          </button>
          <button
            className="btn btn-danger"
            style={{ marginLeft: 'auto' }}
            onClick={() => setToDelete(v.ledger)}
          >
            <Icon name="trash" size={15} /> Delete Ledger
          </button>
        </div>

        {/* Headline figures for this ledger. */}
        <div className="pdc-cards pdc-cards-main" style={{ marginBottom: 14 }}>
          <div className={cx('pdc-card', 'hero')}>
            <span className="pdc-card-label">Ledger Total</span>
            <span className="pdc-card-value mono">{formatMoney(v.total, cur)}</span>
            <span className="pdc-card-hint">own + parties</span>
          </div>
          <div className="pdc-card">
            <span className="pdc-card-label">Own Balance</span>
            <span className="pdc-card-value mono">{formatMoney(v.ownBalance, cur)}</span>
            <span className="pdc-card-hint">posted directly</span>
          </div>
          <div className="pdc-card pos">
            <span className="pdc-card-label">Receivable</span>
            <span className="pdc-card-value mono">{formatMoney(v.receivable, cur)}</span>
          </div>
          <div className="pdc-card neg">
            <span className="pdc-card-label">Payable</span>
            <span className="pdc-card-value mono">{formatMoney(v.payable, cur)}</span>
          </div>
        </div>

        {v.sharedPartyIds.length > 0 && (
          <div className="pdc-warn" style={{ marginTop: 0, marginBottom: 12 }}>
            {v.sharedPartyIds.length} part{v.sharedPartyIds.length === 1 ? 'y' : 'ies'} here also
            belong to another ledger, so the same balance counts in both totals.
            Shared rows are marked below.
          </div>
        )}

        <div className="card">
          <div className="pdc-register-head">
            <div className="stmt-title" style={{ margin: 0 }}>
              Parties under {v.ledger.name} · {v.parties.length}
            </div>
          </div>

          {v.parties.length === 0 ? (
            <div className="empty">
              No parties assigned yet. Use <strong>Assign Parties</strong> above to add them.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="grid stack-sm">
                <thead>
                  <tr>
                    <th>Party</th><th className="num">Balance</th>
                    <th>Status</th><th>Shared With</th><th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {v.parties.map((r) => (
                    <tr key={r.party.id}>
                      <td data-label="Party">
                        <button className="btn btn-ghost btn-sm" style={{ padding: 0, height: 'auto' }}
                          onClick={() => navigate(`/ledger?party=${r.party.id}`)}>
                          {r.party.name}
                        </button>
                      </td>
                      <td data-label="Balance"
                        className={cx('num mono', r.balance > 0 ? 'pos' : r.balance < 0 ? 'neg' : '')}>
                        {formatMoney(Math.abs(r.balance), cur)}
                      </td>
                      <td data-label="Status">
                        <span className={cx('pdc-status',
                          r.balance > 0 ? 'st-cleared' : r.balance < 0 ? 'st-bounced' : 'st-cancelled')}>
                          {balanceLabel(r.balance)}
                        </span>
                      </td>
                      <td data-label="Shared With">
                        {r.shared
                          ? <span className="pdc-status st-transferred">{r.sharedWith.join(', ')}</span>
                          : <span className="faint">—</span>}
                      </td>
                      <td className="no-print actions-cell">
                        <button className="btn btn-ghost btn-icon btn-sm" title="Open party ledger"
                          onClick={() => navigate(`/ledger?party=${r.party.id}`)}>
                          <Icon name="book" size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="pdc-total-row">
                    <td>Parties subtotal</td>
                    <td className="num mono">{formatMoney(v.partiesTotal, cur)}</td>
                    <td colSpan={3}></td>
                  </tr>
                  <tr className="pdc-total-row">
                    <td>Own balance</td>
                    <td className="num mono">{formatMoney(v.ownBalance, cur)}</td>
                    <td colSpan={3}></td>
                  </tr>
                  <tr className="pdc-total-row">
                    <td><strong>{v.ledger.name} total</strong></td>
                    <td className="num mono"><strong>{formatMoney(v.total, cur)}</strong></td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <LedgerModal ledger={modal} onClose={() => setModal(null)} />
        <AssignModal ledgerId={assignFor} onClose={() => setAssignFor(null)} />
        {/* The detail view needs its own confirm dialog — the one further down
            only renders in the list view. */}
        <ConfirmDialog
          open={!!toDelete}
          title={`Delete ${toDelete?.name ?? 'this ledger'}?`}
          message={(() => {
            if (!toDelete) return '';
            const i = ledgerDeleteImpact(data, toDelete.id);
            const own = i.transactions
              ? ` Its ${i.transactions} own entry(ies) are deleted too.`
              : '';
            return `Parties assigned to ${toDelete.name} are only unlinked — they keep their own balances and history.${own} This cannot be undone.`;
          })()}
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            const l = toDelete;
            setToDelete(null);
            if (l && (await store.deleteLedger(l.id))) {
              toast.success(`Deleted ${l.name}`);
              open('');   // back to the list; this ledger no longer exists
            }
          }}
          onCancel={() => setToDelete(null)}
        />
      </div>
    );
  }

  // ---- List of every ledger -----------------------------------------------
  return (
    <div className="pdc-page">
      <PageHeader title="Ledgers" subtitle="Each ledger with its own parties and running total" />

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="pdc-search-row">
          <div className="faint" style={{ flex: 1, fontSize: 12.5 }}>
            A ledger totals the entries posted to it plus every party assigned to it.
          </div>

        </div>
      </div>

      {views.length === 0 ? (
        <div className="card">
          <div className="empty">
            No ledgers yet. Create one for each salesman or book of business —
            e.g. <strong>Najeeb</strong>, <strong>Kamran</strong>.
          </div>
        </div>
      ) : (
        <div className="rp-grid">
          {views.map((v) => (
            <button key={v.ledger.id} className="rp-card tone-blue" onClick={() => open(v.ledger.id)}>
              <span className="rp-card-icon"><Icon name="book" size={19} /></span>
              <span className="rp-card-text">
                <span className="rp-card-title">{v.ledger.name}</span>
                <span className="rp-card-desc">
                  {v.parties.length} part{v.parties.length === 1 ? 'y' : 'ies'}
                  {v.ownBalance !== 0 && ` · own ${formatMoney(v.ownBalance, cur)}`}
                </span>
                <span className={cx('ledger-card-total mono', v.total >= 0 ? 'pos' : 'neg')}>
                  {formatMoney(v.total, cur)}
                </span>
              </span>
              <span className="rp-card-go"><Icon name="chevron" size={16} /></span>
            </button>
          ))}
        </div>
      )}

      <LedgerModal ledger={modal} onClose={() => setModal(null)} />
      <ConfirmDialog
        open={!!toDelete}
        title="Delete this ledger?"
        message="Parties assigned to this ledger are only unlinked — they keep their own balances and history. Any entries posted directly to the ledger are deleted."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          const l = toDelete;
          setToDelete(null);
          if (l) await store.deleteLedger(l.id);
        }}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function LedgerModal({ ledger, onClose }: { ledger: NamedLedger | 'new' | null; onClose: () => void }) {
  const store = usePdc();
  const editing = ledger && ledger !== 'new' ? ledger : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [opening, setOpening] = useState(String(editing?.openingBalance ?? 0));
  const [active, setActive] = useState(editing?.active ?? true);

  const key = editing?.id ?? ledger;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setOpening(String(editing?.openingBalance ?? 0));
    setActive(editing?.active ?? true);
  }

  if (!ledger) return null;

  const save = async () => {
    const rec = await store.saveLedger({
      id: editing?.id,
      name,
      description: description || undefined,
      openingBalance: Number(opening) || 0,
      active,
    });
    if (rec) {
      toast.success(editing ? 'Ledger updated' : 'Ledger created');
      onClose();
    }
  };

  return (
    <Modal
      open
      title={editing ? 'Edit Ledger' : 'New Ledger'}
      subtitle={editing ? undefined : 'e.g. a salesman — Najeeb, Kamran, Yameen'}
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
          <label>Ledger Name</label>
          <input className="input" autoFocus value={name} placeholder="e.g. Najeeb"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div className="field">
          <label>Description <span className="faint">(optional)</span></label>
          <input className="input" value={description} placeholder="e.g. Salesman — north zone"
            onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Opening Balance <span className="faint">(this ledger's own)</span></label>
            <input className="input" type="number" value={opening}
              onChange={(e) => setOpening(e.target.value)} />
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
      </div>
    </Modal>
  );
}

/** Tick the parties that belong to this ledger. */
function AssignModal({ ledgerId, onClose }: { ledgerId: string | null; onClose: () => void }) {
  const store = usePdc();
  const data = store.dataset();
  const [search, setSearch] = useState('');

  if (!ledgerId) return null;
  const ledger = data.ledgers.find((l) => l.id === ledgerId);
  if (!ledger) return null;

  const q = search.trim().toLowerCase();
  const list = data.parties
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggle = async (partyId: string, on: boolean) => {
    const party = data.parties.find((p) => p.id === partyId);
    if (!party) return;
    const current = party.ledgerIds ?? [];
    const next = on
      ? [...new Set([...current, ledgerId])]
      : current.filter((id) => id !== ledgerId);
    await store.setPartyLedgers(partyId, next);
  };

  return (
    <Modal
      open
      title={`Assign parties to ${ledger.name}`}
      subtitle="A party may belong to more than one ledger."
      onClose={onClose}
      width={520}
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <div className="field" style={{ marginBottom: 12 }}>
        <input className="input" autoFocus placeholder="Search parties…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {list.length === 0 ? (
        <div className="empty">No parties found.</div>
      ) : (
        <div className="assign-list">
          {list.map((p) => {
            const on = (p.ledgerIds ?? []).includes(ledgerId);
            const others = (p.ledgerIds ?? [])
              .filter((id) => id !== ledgerId)
              .map((id) => data.ledgers.find((l) => l.id === id)?.name)
              .filter(Boolean);
            return (
              <label key={p.id} className={cx('assign-row', on && 'on')}>
                <input type="checkbox" checked={on}
                  onChange={(e) => toggle(p.id, e.target.checked)} />
                <span className="assign-name">{p.name}</span>
                {others.length > 0 && (
                  <span className="faint" style={{ fontSize: 11 }}>also in {others.join(', ')}</span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
