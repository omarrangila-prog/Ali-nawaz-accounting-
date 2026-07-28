/**
 * Cheque panel — every cheque, in and out, visible on the Cash Book itself.
 *
 * The register below lists transactions; this shows the CHEQUES, which is what
 * the user actually watches day to day: what is coming in, what is going out,
 * what is due, and what has bounced.
 */

import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { usePdc } from '@/store/pdcStore';
import { holderLabel, partyName } from '@/lib/pdcEngine';
import type { Cheque } from '@/types/pdc';
import { formatMoney, formatDate, cx } from '@/lib/utils';

type Tab = 'all' | 'received' | 'issued' | 'due' | 'bounced';

interface Props {
  today: string;
  /** Open a cheque's details / actions. */
  onOpen: (chequeId: string) => void;
}

/** Cheques still in play — not settled, cancelled or replaced. */
const isLive = (c: Cheque) =>
  c.status === 'pending' || c.status === 'deposited' || c.status === 'presented';

export function ChequePanel({ today, onOpen }: Props) {
  const store = usePdc();
  const data = store.dataset();
  const cur = data.settings.currency;
  const [tab, setTab] = useState<Tab>('all');

  const counts = useMemo(() => {
    const live = data.cheques.filter(isLive);
    return {
      all: live.length,
      received: live.filter((c) => c.direction === 'received').length,
      issued: live.filter((c) => c.direction === 'issued').length,
      due: live.filter((c) => c.chequeDate <= today).length,
      bounced: data.cheques.filter((c) => c.status === 'bounced').length,
    };
  }, [data.cheques, today]);

  const rows = useMemo(() => {
    let list = data.cheques.filter((c) => (tab === 'bounced' ? c.status === 'bounced' : isLive(c)));
    if (tab === 'received') list = list.filter((c) => c.direction === 'received');
    if (tab === 'issued') list = list.filter((c) => c.direction === 'issued');
    if (tab === 'due') list = list.filter((c) => c.chequeDate <= today);
    // Soonest due first — the ones needing attention rise to the top.
    return [...list].sort((a, b) => a.chequeDate.localeCompare(b.chequeDate));
  }, [data.cheques, tab, today]);

  const total = rows.reduce((s, c) => s + c.amount, 0);

  const TABS: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'received', label: 'Coming In', count: counts.received },
    { id: 'issued', label: 'Going Out', count: counts.issued },
    { id: 'due', label: 'Due / Overdue', count: counts.due },
    { id: 'bounced', label: 'Bounced', count: counts.bounced },
  ];

  return (
    <div className="card pdc-cheque-panel">
      <div className="pdc-register-head">
        <div className="stmt-title" style={{ margin: 0 }}>
          <Icon name="cheque" size={16} /> Cheques
        </div>
        <div className="cheque-tabs no-print">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={cx('chip', tab === t.id && 'chip-done')}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <span className="chip-count">{t.count}</span>
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          {data.cheques.length === 0
            ? <>No cheques yet. Press <strong>F5</strong> to record one received, or <strong>F6</strong> for one issued.</>
            : <>No cheques in this view.</>}
        </div>
      ) : (
        <div className="table-wrap pdc-cheque-wrap">
          <table className="grid pdc-grid stack-sm">
            <thead>
              <tr>
                {/* WHEN → WHAT → WHO → MONEY → STATUS, same order as the
                    register so the two tables read the same way. */}
                <th>Due Date</th><th>Cheque #</th><th>In / Out</th>
                <th>Party</th><th>Bank</th>
                <th className="num">Amount</th>
                <th>Status</th><th>Held By</th><th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const overdue = isLive(c) && c.chequeDate < today;
                const dueToday = isLive(c) && c.chequeDate === today;
                return (
                  <tr key={c.id} onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
                    <td data-label="Due Date" className={cx(overdue && 'neg', dueToday && 'due-today-cell')}>
                      {formatDate(c.chequeDate)}
                      {overdue && <span className="due-flag">overdue</span>}
                      {dueToday && <span className="due-flag today">today</span>}
                    </td>
                    <td data-label="Cheque #" className="mono">{c.chequeNumber}</td>
                    <td data-label="In / Out">
                      <span className={cx('cheque-dir', c.direction)}>
                        <Icon name={c.direction === 'received' ? 'cheque-in' : 'cheque-out'} size={13} />
                        {c.direction === 'received' ? 'In' : 'Out'}
                      </span>
                    </td>
                    <td data-label="Party">{partyName(data, c.partyId)}</td>
                    <td data-label="Bank">{data.banks.find((b) => b.id === c.bankId)?.name ?? '—'}</td>
                    <td
                      data-label="Amount"
                      className={cx('num mono', c.direction === 'received' ? 'pos' : 'neg')}
                    >
                      {formatMoney(c.amount, cur)}
                    </td>
                    <td data-label="Status">
                      <span className={cx('pdc-status', `st-${c.status}`)}>{c.status}</span>
                    </td>
                    <td data-label="Held By">{holderLabel(data, c.holder)}</td>
                    <td className="no-print actions-cell">
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        title="Open cheque"
                        onClick={(e) => { e.stopPropagation(); onOpen(c.id); }}
                      >
                        <Icon name="eye" size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="pdc-total-row">
                {/* Five label columns, then Amount, then Status / Held By. */}
                <td colSpan={5}>Total · {rows.length} cheque{rows.length === 1 ? '' : 's'}</td>
                <td className="num mono">{formatMoney(total, cur)}</td>
                <td colSpan={2}></td>
                <td className="no-print"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
