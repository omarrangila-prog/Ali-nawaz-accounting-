/**
 * Ali Nawaz PDC — Reports (spec §23)
 *
 * Every report opens in the shared full-screen preview, which already provides
 * zoom in / out / fit-to-width, print and PDF download.
 */

import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Combo } from '@/components/ui/Combo';
import { PdfPreview } from '@/components/ui/PdfPreview';
import { usePdc } from '@/store/pdcStore';
import { bankAccountLabel } from '@/lib/pdcEngine';
import {
  PDC_REPORTS,
  PDC_REPORT_GROUPS,
  buildPdcReport,
  pdcFileName,
  type PdcReportFilters,
  type PdcReportId,
} from '@/lib/pdcReports';
import type { IconName } from '@/components/ui/Icon';
import { toast } from '@/store/toast';
import { cx } from '@/lib/utils';
import './pdc.css';
import './reports.css';

export function PdcReports() {
  const store = usePdc();
  const data = store.dataset();

  const [open, setOpen] = useState<PdcReportId | null>(null);
  const [filters, setFilters] = useState<PdcReportFilters>({});
  const [search, setSearch] = useState('');

  const partyOptions = data.parties.map((p) => ({ id: p.id, label: p.name }));
  const accountOptions = data.bankAccounts.map((a) => ({
    id: a.id,
    label: bankAccountLabel(data.banks, data.bankAccounts, a.id),
  }));

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PDC_REPORTS;
    return PDC_REPORTS.filter(
      (r) => r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    );
  }, [search]);

  const meta = PDC_REPORTS.find((r) => r.id === open);

  const run = (id: PdcReportId) => {
    const m = PDC_REPORTS.find((r) => r.id === id)!;
    if (m.needsParty && !filters.partyId) {
      toast.error(`${m.title} needs a party — select one in Filters above.`);
      return;
    }
    if (m.needsAccount && !filters.bankAccountId) {
      toast.error(`${m.title} needs a bank account — select one in Filters above.`);
      return;
    }
    setOpen(id);
  };

  // Stable factory so the preview regenerates only when inputs actually change.
  const makeDoc = useCallback(
    () => buildPdcReport(data, open!, filters),
    [data, open, filters]
  );

  return (
    <div className="pdc-page">
      <PageHeader title="Reports" subtitle="Preview, zoom, print or download any statement" />

      <div className="card rp-filters" style={{ marginBottom: 14 }}>
        <div className="rp-filters-head">
          <Icon name="filter" size={15} />
          <span>Filters</span>
          <span className="faint">apply to every report below</span>
          {(filters.from || filters.to || filters.partyId || filters.bankAccountId) && (
            <button className="btn btn-sm btn-ghost rp-clear" onClick={() => setFilters({})}>
              Clear all
            </button>
          )}
        </div>
        <div className="pdc-filter-grid" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          <div className="field">
            <label>From</label>
            <input className="input" type="date" value={filters.from ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          </div>
          <div className="field">
            <label>To</label>
            <input className="input" type="date" value={filters.to ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
          </div>
          <div className="field">
            <label>Party <span className="faint">(for party reports)</span></label>
            <Combo
              value={filters.partyId ?? ''}
              options={[{ id: '', label: 'All parties' }, ...partyOptions]}
              placeholder="All parties"
              onChange={(v) => setFilters((f) => ({ ...f, partyId: v }))}
            />
          </div>
          <div className="field">
            <label>Bank Account <span className="faint">(for bank reports)</span></label>
            <Combo
              value={filters.bankAccountId ?? ''}
              options={[{ id: '', label: 'All accounts' }, ...accountOptions]}
              placeholder="All accounts"
              onChange={(v) => setFilters((f) => ({ ...f, bankAccountId: v }))}
            />
          </div>
          <div className="field">
            <label>Find a report</label>
            <input className="input" placeholder="Search reports…" value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {PDC_REPORT_GROUPS.map((group) => {
        const inGroup = visible.filter((r) => r.group === group);
        if (inGroup.length === 0) return null;
        return (
          <section key={group} className="rp-section">
            <h3 className="rp-section-title">
              {group}
              <span className="rp-section-count">{inGroup.length}</span>
            </h3>
            <div className="rp-grid">
              {inGroup.map((r) => {
                // A report that needs a selection it doesn't have is dimmed,
                // so it's obvious why it won't open yet.
                const blocked =
                  (r.needsParty && !filters.partyId) || (r.needsAccount && !filters.bankAccountId);
                return (
                  <button
                    key={r.id}
                    className={cx('rp-card', `tone-${r.tone}`, r.featured && 'featured', blocked && 'blocked')}
                    onClick={() => run(r.id)}
                    title={r.description}
                  >
                    <span className="rp-card-icon">
                      <Icon name={r.icon as IconName} size={19} />
                    </span>
                    <span className="rp-card-text">
                      <span className="rp-card-title">{r.title}</span>
                      <span className="rp-card-desc">{r.description}</span>
                      {blocked && (
                        <span className="rp-card-need">
                          select a {r.needsParty ? 'party' : 'bank account'} above
                        </span>
                      )}
                    </span>
                    <span className="rp-card-go"><Icon name="chevron" size={16} /></span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {visible.length === 0 && (
        <div className="card"><div className="empty">No report matches “{search}”.</div></div>
      )}

      <PdfPreview
        makeDoc={open ? makeDoc : null}
        title={meta?.title ?? ''}
        fileName={pdcFileName(meta?.title ?? 'report')}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
