/**
 * Backup & Restore.
 *
 * Two exports, for two different purposes:
 *   • Excel  — readable books to open outside the app (not restorable)
 *   • Backup — an exact JSON copy that CAN be restored
 *
 * Restore is deliberately awkward: it validates the file, shows exactly what
 * it will write, and demands a typed confirmation, because it overwrites the
 * live books.
 */

import { useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { usePdc } from '@/store/pdcStore';
import {
  buildBackup, describeBackup, downloadBackup, exportExcel, validateBackup,
  type PdcBackup, type RestoreCheck,
} from '@/lib/pdcBackup';
import { formatNumber } from '@/lib/utils';
import { toast } from '@/store/toast';
import './pdc.css';

export function PdcBackupPage() {
  const store = usePdc();
  const data = store.dataset();
  const fileRef = useRef<HTMLInputElement>(null);

  const [check, setCheck] = useState<RestoreCheck | null>(null);
  const [pending, setPending] = useState<PdcBackup | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => buildBackup(data).counts, [data]);
  const totalRecords = Object.values(counts).reduce((s, n) => s + n, 0);

  const doExcel = () => {
    try {
      const name = exportExcel(data);
      toast.success(`Downloaded ${name}`);
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
    }
  };

  const doBackup = () => {
    try {
      const name = downloadBackup(data);
      toast.success(`Downloaded ${name}`);
    } catch (e) {
      toast.error(`Backup failed: ${(e as Error).message}`);
    }
  };

  const onFile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      const result = validateBackup(raw);
      setCheck(result);
      setPending(result.backup ?? null);
      setConfirmText('');
    } catch {
      setCheck({ ok: false, errors: ['That file is not valid JSON — pick a backup file.'], warnings: [] });
      setPending(null);
    }
  };

  const doRestore = async () => {
    if (!pending) return;
    setBusy(true);
    const res = await store.restoreBackup(pending);
    setBusy(false);
    if (res.ok) {
      toast.success(`Restored ${res.written} records`);
      setCheck(null);
      setPending(null);
    }
  };

  return (
    <div className="pdc-page">
      <PageHeader title="Backup & Export" subtitle="Keep a copy of your books outside the database" />

      <div className="backup-grid">
        {/* --- Excel --- */}
        <div className="card backup-card">
          <div className="backup-icon tone-green"><Icon name="excel" size={22} /></div>
          <h3>Export to Excel</h3>
          <p className="muted">
            A readable workbook: summary, cash book, cheques, parties, ledgers,
            bank accounts, every ledger entry, cheque history and the audit trail.
            Open it in Excel to check or share your books.
          </p>
          <p className="faint" style={{ fontSize: 11.5 }}>
            For reading only — this cannot be restored back into the app.
          </p>
          <button className="btn btn-green" onClick={doExcel}>
            <Icon name="excel" size={15} /> Download Excel
          </button>
        </div>

        {/* --- JSON backup --- */}
        <div className="card backup-card">
          <div className="backup-icon tone-blue"><Icon name="save" size={22} /></div>
          <h3>Download Backup</h3>
          <p className="muted">
            An exact copy of every record, which <strong>can be restored</strong>.
            Keep one before making big changes, and take a fresh copy regularly.
          </p>
          <p className="faint" style={{ fontSize: 11.5 }}>
            {formatNumber(totalRecords)} records · {counts.transactions} transactions ·{' '}
            {counts.cheques} cheques · {counts.parties} parties
          </p>
          <button className="btn btn-primary" onClick={doBackup}>
            <Icon name="save" size={15} /> Download Backup
          </button>
        </div>

        {/* --- Restore --- */}
        <div className="card backup-card">
          <div className="backup-icon tone-red"><Icon name="undo" size={22} /></div>
          <h3>Restore from Backup</h3>
          <p className="muted">
            Load a backup file back into the database. Every record in the file
            is written over the current data.
          </p>
          <p className="pdc-warn" style={{ marginTop: 0 }}>
            This overwrites your live books. Download a backup of what you have
            now before restoring an older one.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
          <button className="btn btn-danger" onClick={() => fileRef.current?.click()}>
            <Icon name="undo" size={15} /> Choose Backup File
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 className="pdc-section-title">What is in the database right now</h3>
        <div className="table-wrap">
          <table className="grid stack-sm">
            <thead><tr><th>Record type</th><th className="num">Count</th></tr></thead>
            <tbody>
              {Object.entries(counts).map(([k, v]) => (
                <tr key={k}>
                  <td data-label="Record type">{labelFor(k)}</td>
                  <td data-label="Count" className="num mono">{formatNumber(v)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="pdc-total-row">
                <td>Total</td>
                <td className="num mono">{formatNumber(totalRecords)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* --- Restore confirmation --- */}
      <Modal
        open={!!check}
        title={check?.ok ? 'Restore this backup?' : 'That backup cannot be used'}
        onClose={() => { setCheck(null); setPending(null); }}
        width={520}
        footer={
          check?.ok ? (
            <>
              <button className="btn" onClick={() => { setCheck(null); setPending(null); }}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={confirmText.trim().toUpperCase() !== 'RESTORE' || busy}
                onClick={doRestore}
              >
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setCheck(null)}>Close</button>
          )
        }
      >
        {check && (
          <>
            {check.errors.map((e, i) => (
              <div key={i} className="pdc-warn" style={{ marginTop: 0, marginBottom: 8 }}>{e}</div>
            ))}
            {check.ok && pending && (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  Backup from <strong>{describeBackup(pending)}</strong>
                </p>
                {check.warnings.map((w, i) => (
                  <div key={i} className="pdc-warn" style={{ marginTop: 0, marginBottom: 8 }}>{w}</div>
                ))}
                <div className="table-wrap" style={{ marginBottom: 12 }}>
                  <table className="grid">
                    <thead><tr><th>Will write</th><th className="num">Records</th></tr></thead>
                    <tbody>
                      {Object.entries(pending.counts ?? {}).map(([k, v]) => (
                        <tr key={k}><td>{labelFor(k)}</td><td className="num mono">{formatNumber(v)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="field">
                  <label>Type <strong>RESTORE</strong> to confirm</label>
                  <input
                    className="input"
                    autoFocus
                    value={confirmText}
                    placeholder="RESTORE"
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}

function labelFor(key: string): string {
  const map: Record<string, string> = {
    parties: 'Parties',
    ledgers: 'Ledgers',
    banks: 'Banks',
    bankAccounts: 'Bank accounts',
    cheques: 'Cheques',
    transactions: 'Transactions',
    ledgerEntries: 'Ledger entries (double-entry lines)',
    movements: 'Cheque history',
    allocations: 'Cheque allocations',
    audit: 'Audit trail',
  };
  return map[key] ?? key;
}
