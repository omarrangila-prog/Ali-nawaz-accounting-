/**
 * First-run setup checklist.
 *
 * A new workspace has empty tables and no obvious starting point — and some
 * actions simply cannot work until their prerequisite exists (a cheque must be
 * drawn on a bank account, for instance). This states what is still missing,
 * in the order it is needed, and links straight to each fix.
 *
 * It hides itself once the essentials are done, so it never nags a set-up
 * business.
 */

import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/ui/Icon';
import { usePdc } from '@/store/pdcStore';
import { cx } from '@/lib/utils';

interface Step {
  done: boolean;
  label: string;
  why: string;
  action: string;
  to: string;
}

export function SetupChecklist() {
  const store = usePdc();
  const data = store.dataset();
  const navigate = useNavigate();

  const steps: Step[] = [
    {
      done: data.parties.length > 0,
      label: 'Add your parties',
      why: 'The customers and suppliers you trade with.',
      action: 'Add a party',
      to: '/parties',
    },
    {
      done: data.bankAccounts.length > 0,
      label: 'Add a bank account',
      why: 'Cheques and bank balances need a real account — a bank name alone is not enough.',
      action: 'Add an account',
      to: '/parties?tab=banks',
    },
    {
      done: data.transactions.length > 0,
      label: 'Record your first entry',
      why: 'Press F1 for a sale, F3 for a cash receipt, or F5 for a cheque received.',
      action: 'Go to Cash Book',
      to: '/',
    },
  ];

  // Once everything essential exists, get out of the way for good.
  if (steps.every((s) => s.done)) return null;

  const remaining = steps.filter((s) => !s.done).length;

  return (
    <div className="card setup-card no-print">
      <div className="setup-head">
        <Icon name="sparkles" size={16} />
        <strong>Finish setting up</strong>
        <span className="faint">{remaining} step{remaining === 1 ? '' : 's'} left</span>
      </div>

      <ol className="setup-steps">
        {steps.map((s) => (
          <li key={s.label} className={cx('setup-step', s.done && 'done')}>
            <span className="setup-tick">
              {s.done ? <Icon name="check" size={13} /> : null}
            </span>
            <span className="setup-body">
              <span className="setup-label">{s.label}</span>
              <span className="setup-why">{s.why}</span>
            </span>
            {!s.done && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate(s.to)}>
                {s.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
