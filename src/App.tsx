

import { useEffect, useState } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@/store/authStore';
import { useData } from '@/store/dataStore';
import { PinLock, isUnlocked } from '@/components/PinLock';
import { AppShell } from '@/components/layout/AppShell';
import { Toasts } from '@/components/ui/Toasts';
import { CashBook } from '@/pages/CashBook';
import { Purchase } from '@/pages/Purchase';
import { Sale } from '@/pages/Sale';
import { Stock } from '@/pages/Stock';
import { Balances } from '@/pages/Balances';
import { TrialBalance } from '@/pages/TrialBalance';
import { Reports } from '@/pages/Reports';
import { Masters } from '@/pages/Masters';
import { PdcCashbook } from '@/pages/PdcCashbook';
import { PdcParties } from '@/pages/PdcParties';
import { PdcLedger } from '@/pages/PdcLedger';
import { PdcLedgers } from '@/pages/PdcLedgers';
import { PdcReports } from '@/pages/PdcReports';
import { usePdc } from '@/store/pdcStore';

function Splash() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
      <div className="col" style={{ alignItems: 'center', gap: 12 }}>
        <div className="brand-mark" style={{ width: 52, height: 52, fontSize: 24 }}>A</div>
        <div className="muted">Loading Ali Nawaz Accounting…</div>
      </div>
    </div>
  );
}

export default function App() {
  const { user, init, refresh } = useAuth();
  const bind = useData((s) => s.bind);
  const unbind = useData((s) => s.unbind);
  const ready = useData((s) => s.ready);
  const bindPdc = usePdc((s) => s.bind);
  const unbindPdc = usePdc((s) => s.unbind);
  const [unlocked, setUnlocked] = useState(isUnlocked);

  useEffect(() => init(), [init]);

  // Bind data to the ACTIVE client's workspace. `user.uid` is the workspace id
  // chosen at login (PIN → client → workspace). When a different client logs in
  // this re-binds to their isolated data — one client's data never leaks into
  // another's because every read/write is scoped under users/{workspace}/….
  useEffect(() => {
    if (user) bind(user.uid);
    return () => unbind();
  }, [user, bind, unbind]);

  // The Ali Nawaz PDC module binds to the same workspace but its OWN
  // collections (pdc*), so cheque/ledger data and bond data never mix.
  useEffect(() => {
    if (user) bindPdc(user.uid);
    return () => unbindPdc();
  }, [user, bindPdc, unbindPdc]);

  if (!user) return <Splash />;
  // PIN gate — the entered PIN selects the client workspace, then unlocks.
  // refresh() re-reads the just-chosen workspace so data binds to that client.
  if (!unlocked) return <PinLock onUnlock={() => { refresh(); setUnlocked(true); }} />;
  // Don't render the app (and its derived dashboard/report totals) until the
  // Firestore snapshots have loaded — prevents flicker / stale partial values.
  if (!ready) return <Splash />;

  // Electron loads over file://, where BrowserRouter paths don't resolve —
  // use HashRouter there. Web/Vercel keeps clean BrowserRouter URLs.
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

  return (
    <Router>
      <Toasts />
      <Routes>
        <Route element={<AppShell />}>
          {/* ONE Cash Book — sales, purchases, cheques, payments and ledgers all
              post through the same double-entry engine, so every figure and
              report agrees. */}
          <Route path="/" element={<PdcCashbook />} />
          <Route path="/cashbook" element={<PdcCashbook />} />
          <Route path="/parties" element={<PdcParties />} />
          <Route path="/ledgers" element={<PdcLedgers />} />
          <Route path="/ledger" element={<PdcLedger />} />
          <Route path="/reports" element={<PdcReports />} />
          {/* Old paths keep working so bookmarks don't break. */}
          <Route path="/pdc" element={<Navigate to="/" replace />} />
          <Route path="/pdc/parties" element={<Navigate to="/parties" replace />} />
          <Route path="/pdc/ledger" element={<Navigate to="/ledger" replace />} />
          <Route path="/pdc/reports" element={<Navigate to="/reports" replace />} />
          {/* Legacy bond-trading screens, reachable by URL only (not in the
              sidebar). They read the OLD collections and are kept so historic
              data stays viewable. */}
          <Route path="/legacy/cashbook" element={<CashBook />} />
          <Route path="/legacy/reports" element={<Reports />} />
          <Route path="/legacy/purchase" element={<Purchase />} />
          <Route path="/legacy/sale" element={<Sale />} />
          <Route path="/legacy/stock" element={<Stock />} />
          <Route path="/legacy/receivable" element={<Balances kind="receivable" />} />
          <Route path="/legacy/payable" element={<Balances kind="payable" />} />
          <Route path="/legacy/trial-balance" element={<TrialBalance />} />
          <Route path="/legacy/masters" element={<Masters />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
