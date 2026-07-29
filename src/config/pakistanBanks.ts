/**
 * Banks operating in Pakistan, offered as suggestions when adding a bank.
 *
 * This is a convenience list only — the user can still type any name, and a
 * bank is only created once they save it. Nothing here is written to the
 * database on its own.
 *
 * Grouped roughly by type so the common commercial banks appear first.
 */

export interface BankSuggestion {
  name: string;
  /** Short label shown beside the name in the dropdown. */
  kind: string;
}

export const PAKISTAN_BANKS: BankSuggestion[] = [
  // --- Major commercial banks ---
  { name: 'Habib Bank Limited (HBL)', kind: 'Commercial' },
  { name: 'United Bank Limited (UBL)', kind: 'Commercial' },
  { name: 'MCB Bank Limited', kind: 'Commercial' },
  { name: 'Allied Bank Limited (ABL)', kind: 'Commercial' },
  { name: 'National Bank of Pakistan (NBP)', kind: 'Public' },
  { name: 'Bank Alfalah', kind: 'Commercial' },
  { name: 'Askari Bank', kind: 'Commercial' },
  { name: 'Bank Al Habib', kind: 'Commercial' },
  { name: 'Faysal Bank', kind: 'Commercial' },
  { name: 'Habib Metropolitan Bank', kind: 'Commercial' },
  { name: 'Soneri Bank', kind: 'Commercial' },
  { name: 'Standard Chartered Bank Pakistan', kind: 'Foreign' },
  { name: 'JS Bank', kind: 'Commercial' },
  { name: 'Summit Bank', kind: 'Commercial' },
  { name: 'Silkbank', kind: 'Commercial' },
  { name: 'Samba Bank', kind: 'Commercial' },
  { name: 'Bank of Punjab (BOP)', kind: 'Public' },
  { name: 'Sindh Bank', kind: 'Public' },
  { name: 'Bank of Khyber', kind: 'Public' },
  { name: 'First Women Bank', kind: 'Commercial' },

  // --- Islamic banks ---
  { name: 'Meezan Bank', kind: 'Islamic' },
  { name: 'Dubai Islamic Bank Pakistan', kind: 'Islamic' },
  { name: 'BankIslami Pakistan', kind: 'Islamic' },
  { name: 'Al Baraka Bank Pakistan', kind: 'Islamic' },
  { name: 'MCB Islamic Bank', kind: 'Islamic' },
  { name: 'Faysal Islamic Banking', kind: 'Islamic' },

  // --- Microfinance banks ---
  { name: 'Khushhali Microfinance Bank', kind: 'Microfinance' },
  { name: 'Mobilink Microfinance Bank (JazzCash)', kind: 'Microfinance' },
  { name: 'Telenor Microfinance Bank (Easypaisa)', kind: 'Microfinance' },
  { name: 'U Microfinance Bank (UBank)', kind: 'Microfinance' },
  { name: 'FINCA Microfinance Bank', kind: 'Microfinance' },
  { name: 'NRSP Microfinance Bank', kind: 'Microfinance' },
  { name: 'Apna Microfinance Bank', kind: 'Microfinance' },
  { name: 'Advans Pakistan Microfinance Bank', kind: 'Microfinance' },
  { name: 'HBL Microfinance Bank', kind: 'Microfinance' },

  // --- Development / specialised ---
  { name: 'Zarai Taraqiati Bank (ZTBL)', kind: 'Development' },
  { name: 'Industrial Development Bank of Pakistan', kind: 'Development' },
  { name: 'SME Bank', kind: 'Development' },
  { name: 'Punjab Provincial Cooperative Bank', kind: 'Cooperative' },

  // --- Foreign banks operating locally ---
  { name: 'Citibank Pakistan', kind: 'Foreign' },
  { name: 'Deutsche Bank Pakistan', kind: 'Foreign' },
  { name: 'Bank of China Pakistan', kind: 'Foreign' },
  { name: 'Industrial and Commercial Bank of China (ICBC)', kind: 'Foreign' },
];

/** Options shaped for the Combo dropdown. */
export const PAKISTAN_BANK_OPTIONS = PAKISTAN_BANKS.map((b) => ({
  id: b.name,
  label: b.name,
  sub: b.kind,
}));
