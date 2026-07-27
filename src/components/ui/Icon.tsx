/** Lightweight inline SVG icon set (stroke, 1.8px). No external icon dep. */
import type { CSSProperties } from 'react';

export type IconName =
  | 'dashboard' | 'purchase' | 'sale' | 'stock' | 'receivable' | 'payable'
  | 'ledger' | 'trial' | 'reports' | 'settings' | 'search' | 'print'
  | 'pdf' | 'excel' | 'save' | 'refresh' | 'user' | 'plus' | 'trash'
  | 'close' | 'check' | 'lock' | 'chevron' | 'wifi-off' | 'sparkles'
  | 'arrow-up' | 'arrow-down' | 'logout' | 'calendar' | 'wallet' | 'scale'
  | 'menu' | 'info' | 'warning' | 'more'
  // --- Cash Book / cheque & finance set ---
  | 'cheque' | 'cheque-in' | 'cheque-out' | 'transfer' | 'bank' | 'coins'
  | 'trend-up' | 'trend-down' | 'clock' | 'alert-circle'
  | 'check-circle' | 'x-circle' | 'eye' | 'undo' | 'filter'
  | 'building' | 'receipt' | 'list' | 'book' | 'shield' | 'clipboard';

const paths: Record<IconName, string> = {
  dashboard: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z',
  purchase: 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4H6zM3 6h18M16 10a4 4 0 0 1-8 0',
  sale: 'M3 3v18h18M7 14l4-4 3 3 5-6',
  stock: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  receivable: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  payable: 'M3 6h18v12H3zM3 10h18M7 15h4',
  ledger: 'M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4zM8 4v16M12 9h4M12 13h4',
  trial: 'M12 3v18M5 8l7-5 7 5M4 21h16M6 8v6a3 3 0 0 0 6 0M12 8v6a3 3 0 0 0 6 0',
  reports: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13h6M9 17h6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.4z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M8 15h1.5a1.5 1.5 0 0 0 0-3H8v6M14 12v6M13 15h2',
  excel: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13l6 6M15 13l-6 6',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  refresh: 'M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  chevron: 'M6 9l6 6 6-6',
  'wifi-off': 'M1 1l22 22M16.7 11.7A9 9 0 0 0 12 10.5M5 12.5a9 9 0 0 1 3-2M8.5 16.5a5 5 0 0 1 7 0M12 20h.01',
  sparkles: 'M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  wallet: 'M20 12V8H6a2 2 0 0 1-2-2 2 2 0 0 1 2-2h12v4M20 12v4H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4h-4z',
  scale: 'M12 3v18M5 8l7-5 7 5M4 21h16M6 8v6a3 3 0 0 0 6 0M12 8v6a3 3 0 0 0 6 0',
  menu: 'M3 12h18M3 6h18M3 18h18',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  warning: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',

  // --- Cash Book / cheque & finance set ---
  /** A cheque leaf with a signature line. */
  cheque: 'M2 6h20v12H2zM2 10h20M6 14h5M16 14h2',
  /** Cheque with an arrow coming in. */
  'cheque-in': 'M21 7H3v10h18V11M3 10h10M6 14h4M17 3v6M17 9l-2.5-2.5M17 9l2.5-2.5',
  /** Cheque with an arrow going out. */
  'cheque-out': 'M21 7H3v10h18V11M3 10h10M6 14h4M17 9V3M17 3l-2.5 2.5M17 3l2.5 2.5',
  /** Two arrows swapping — transfer between accounts/parties. */
  transfer: 'M4 8h13l-3-3M20 16H7l3 3',
  /** Bank building with columns. */
  bank: 'M3 21h18M4 10h16M5 10V21M9 10V21M15 10V21M19 10V21M12 3 2 8h20L12 3z',
  /** Stacked coins — cash. */
  coins: 'M9 12a7 3 0 1 0 0-6 7 3 0 0 0 0 6zM2 9v4c0 1.7 3.1 3 7 3s7-1.3 7-3V9M16 15.5c2.9-.3 5-1.4 5-2.8V8.5M9 16v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4',
  /** Upward trend — income / profit. */
  'trend-up': 'M22 7 13.5 15.5l-5-5L2 17M16 7h6v6',
  /** Downward trend — cost / loss. */
  'trend-down': 'M22 17 13.5 8.5l-5 5L2 7M16 17h6v-6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  'alert-circle': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01',
  'check-circle': 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  'x-circle': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  undo: 'M3 7v6h6M3.5 13a9 9 0 1 0 2.1-5.6L3 10',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5L22 3z',
  building: 'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2',
  receipt: 'M4 2v20l2-1.5L8 22l2-1.5L12 22l2-1.5L16 22l2-1.5L20 22V2l-2 1.5L16 2l-2 1.5L12 2l-2 1.5L8 2 6 3.5 4 2zM8 8h8M8 12h8M8 16h5',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM9 7h7M9 11h7',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM9 13h6M9 17h4',
};

interface Props {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, className, style, strokeWidth = 1.8 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}
