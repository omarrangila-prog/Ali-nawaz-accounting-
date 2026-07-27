import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from '../ui/Icon';
import { useData } from '@/store/dataStore';
import { useT } from '@/lib/i18n';
import './sidebar.css';

interface NavItem { to: string; tkey: string; icon: IconName; shortcut?: string; }

interface NavGroup { label?: string; items: NavItem[]; }

/** One clean nav — four screens, no duplicates. */
const groups: NavGroup[] = [
  {
    items: [
      { to: '/', tkey: 'Cash Book', icon: 'wallet' },
      { to: '/parties', tkey: 'Parties & Banks', icon: 'user' },
      { to: '/ledger', tkey: 'Ledger', icon: 'ledger', shortcut: 'F8' },
      { to: '/reports', tkey: 'Reports', icon: 'reports', shortcut: 'F10' },
    ],
  },
];

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate?: () => void }) {
  const settings = useData((s) => s.settings);
  const t = useT();
  return (
    <aside className={`sidebar no-print ${open ? 'open' : ''}`}>
      <div className="brand">
        <div className="brand-mark">{(settings.businessName || 'A')[0].toUpperCase()}</div>
        <div className="col" style={{ lineHeight: 1.15 }}>
          <strong style={{ fontSize: 15 }}>{settings.businessName || 'Ali Nawaz'}</strong>
          <span className="faint" style={{ fontSize: 11.5 }}>Accounting Software</span>
        </div>
      </div>

      <nav className="nav">
        {groups.map((g, gi) => (
          <div key={g.label ?? gi} className="nav-group">
            {g.label && <div className="nav-group-label">{g.label}</div>}
            {g.items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.to === '/' || it.to === '/pdc'}
                onClick={onNavigate}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon"><Icon name={it.icon} size={18} /></span>
                {/* PDC entries use plain labels; bond entries use i18n keys. */}
                <span className="nav-label">{it.tkey.startsWith('nav.') ? t(it.tkey) : it.tkey}</span>
                {it.shortcut && <span className="nav-key">{it.shortcut}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="tip glass card-tight">
          <Icon name="wallet" size={15} />
          <span>F1 Sale · F2 Purchase · F3/F4 Cash · F5/F6 Cheques</span>
        </div>
      </div>
    </aside>
  );
}
