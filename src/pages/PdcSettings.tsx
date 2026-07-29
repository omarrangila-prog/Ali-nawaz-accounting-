/**
 * Settings.
 *
 * The engine already honours these; until now there was no way to change them
 * without editing the database by hand.
 */

import { useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { usePdc } from '@/store/pdcStore';
import { toast } from '@/store/toast';
import './pdc.css';

export function PdcSettings() {
  const store = usePdc();
  const s = store.settings;

  const [businessName, setBusinessName] = useState(s.businessName);
  const [currency, setCurrency] = useState(s.currency);
  const [dirty, setDirty] = useState(false);

  const saveText = async () => {
    await store.updateSettings({ businessName: businessName.trim() || 'Ali Nawaz', currency: currency.trim() || 'Rs' });
    setDirty(false);
    toast.success('Settings saved');
  };

  /** Toggles apply immediately — there is nothing to mistype. */
  const toggle = async (patch: Parameters<typeof store.updateSettings>[0], msg: string) => {
    await store.updateSettings(patch);
    toast.success(msg);
  };

  return (
    <div className="pdc-page">
      <PageHeader title="Settings" subtitle="Business details and how cheques behave" />

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 className="pdc-section-title">Business</h3>
        <div className="pdc-form-grid">
          <div className="grid-2">
            <div className="field">
              <label>Business Name <span className="faint">(shown on every report)</span></label>
              <input
                className="input"
                value={businessName}
                onChange={(e) => { setBusinessName(e.target.value); setDirty(true); }}
                onKeyDown={(e) => e.key === 'Enter' && saveText()}
              />
            </div>
            <div className="field">
              <label>Currency Symbol</label>
              <input
                className="input"
                value={currency}
                placeholder="Rs"
                onChange={(e) => { setCurrency(e.target.value); setDirty(true); }}
                onKeyDown={(e) => e.key === 'Enter' && saveText()}
              />
            </div>
          </div>
          {dirty && (
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={saveText}>
              <Icon name="save" size={15} /> Save
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3 className="pdc-section-title">Cheque Rules</h3>

        <label className="setting-row">
          <input
            type="checkbox"
            checked={s.allowPartialAllocation}
            onChange={(e) =>
              toggle(
                { allowPartialAllocation: e.target.checked },
                e.target.checked ? 'Partial allocation enabled' : 'Full transfer only'
              )
            }
          />
          <span className="setting-body">
            <span className="setting-label">Allow splitting one cheque across several parties</span>
            <span className="setting-why">
              Off by default, which matches physical reality: a cheque has one
              holder, so the whole cheque must be endorsed at once. Turn this on
              only if you genuinely allocate one cheque against several
              balances — for example a 100,000 cheque covering 60,000 to one
              party and 40,000 to another.
            </span>
          </span>
        </label>

        <label className="setting-row">
          <input
            type="checkbox"
            checked={s.lowBalanceWarnings}
            onChange={(e) =>
              toggle(
                { lowBalanceWarnings: e.target.checked },
                e.target.checked ? 'Low-balance warnings on' : 'Low-balance warnings off'
              )
            }
          />
          <span className="setting-body">
            <span className="setting-label">Warn when a bank account cannot cover its upcoming cheques</span>
            <span className="setting-why">
              Shows an alert on the Cash Book when cheques due in the next seven
              days exceed that account's balance.
            </span>
          </span>
        </label>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 className="pdc-section-title">Keyboard Shortcuts</h3>
        <div className="table-wrap">
          <table className="grid stack-sm">
            <thead><tr><th>Key</th><th>Action</th></tr></thead>
            <tbody>
              {[
                ['F1', 'Sale'], ['F2', 'Purchase'],
                ['F3', 'Cash Received'], ['F4', 'Cash Paid'],
                ['F5', 'Cheque In (received)'], ['F6', 'Cheque Out (issued)'],
                ['F7', 'Cheque Transfer'], ['F8', 'Ledger'],
                ['F9', 'Search'], ['F10', 'Reports'],
                ['Enter', 'Open the selected row'],
                ['Delete', 'Delete the entry permanently'],
                ['Shift + Delete', 'Reverse it instead, keeping both in history'],
                ['↑ ↓', 'Move between rows'],
                ['Esc', 'Close the form or panel'],
              ].map(([k, a]) => (
                <tr key={k}>
                  <td data-label="Key"><kbd className="shortcut-key">{k}</kbd></td>
                  <td data-label="Action">{a}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
