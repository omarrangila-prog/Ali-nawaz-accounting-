import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './ui/Icon';
import './command.css';

interface Cmd { id: string; label: string; sub?: string; icon: IconName; run: () => void; }

export function CommandPalette({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => { nav(to); onClose(); };
    const pages: Cmd[] = [
      { id: 'cash', label: 'Cash Book', sub: 'All transactions', icon: 'wallet', run: go('/') },
      { id: 'rep', label: 'Reports', sub: 'F7', icon: 'reports', run: go('/reports') },
      { id: 'pur', label: 'New Purchase', sub: 'F2', icon: 'purchase', run: go('/purchase') },
      { id: 'sal', label: 'New Sale', sub: 'F3', icon: 'sale', run: go('/sale') },
      { id: 'stk', label: 'Stock', icon: 'stock', run: go('/stock') },
      { id: 'rec', label: 'Received', icon: 'receivable', run: go('/ledger?side=received') },
      { id: 'pay', label: 'Paid', icon: 'payable', run: go('/ledger?side=paid') },
      { id: 'tb', label: 'Trial Balance', icon: 'trial', run: go('/trial-balance') },
    ];
    return pages;
  }, [nav, onClose]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands.slice(0, 9);
    return commands.filter((c) => c.label.toLowerCase().includes(s)).slice(0, 12);
  }, [q, commands]);

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 40); } }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); }
    else if (e.key === 'Escape') onClose();
  };

  return (
    <div className="cmd-backdrop no-print" onMouseDown={onClose}>
      <div className="cmd glass" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-search">
          <Icon name="search" size={18} className="faint" />
          <input
            ref={inputRef}
            placeholder="Search pages, parties, actions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmd-list">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`cmd-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={c.run}
            >
              <span className="cmd-ico"><Icon name={c.icon} size={16} /></span>
              <span className="cmd-label">{c.label}</span>
              {c.sub && <span className="faint cmd-sub">{c.sub}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="faint" style={{ padding: 18, textAlign: 'center' }}>No results</div>}
        </div>
      </div>
    </div>
  );
}
