/**
 * Multi-client registry — the ONE place that maps a login PIN to an isolated
 * Firebase/Firestore workspace. Each client's data lives entirely under
 * `users/{workspace}/…` (purchases, sales, stock, cash book, receivable /
 * payable, reports, settings), so two clients can never see each other's data.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TO ADD A NEW CLIENT: add one line below with a fresh PIN and a NEW, unique
 * `workspace` id. That's it — a brand-new empty database is created for them
 * automatically on their first save. Nothing else in the app changes.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️  The existing client MUST keep workspace id 'bond-workspace' — that is
 *     where all of their current live data already lives. Never rename it.
 */

export interface ClientConfig {
  /** Login PIN. Any length of digits works (4-digit is just the default UI). */
  pin: string;
  /** Firestore workspace id → data path `users/{workspace}/…`. Must be UNIQUE. */
  workspace: string;
  /** Human label (shown after login / in the header). */
  name: string;
}

/**
 * The client roster. Order doesn't matter; PINs must be unique.
 *
 * PIN 4444 → Ali Nawaz → workspace 'bond-workspace' (the main live workspace)
 * PIN 5555 → Client B  → workspace 'client-b'       (spare, empty)
 * PIN 6666 → Client C  → workspace 'client-c'       (spare, empty)
 *
 * ⚠️  The workspace id 'bond-workspace' is deliberately unchanged — renaming it
 *     would orphan every record already stored under that path. The name shown
 *     in the UI comes from Settings → business name, not from this id.
 */
export const CLIENTS: ClientConfig[] = [
  { pin: '4444', workspace: 'bond-workspace', name: 'Ali Nawaz' },
  { pin: '5555', workspace: 'client-b', name: 'Client B' },
  { pin: '6666', workspace: 'client-c', name: 'Client C' },
];

/** Resolve a typed PIN to its client, or null if the PIN is unknown. */
export function clientForPin(pin: string): ClientConfig | null {
  return CLIENTS.find((c) => c.pin === pin) ?? null;
}

/** Look up a client by workspace id (used to restore a session). */
export function clientForWorkspace(workspace: string): ClientConfig | null {
  return CLIENTS.find((c) => c.workspace === workspace) ?? null;
}

/** The longest PIN length — lets the lock know how many boxes to show. */
export const MAX_PIN_LENGTH = CLIENTS.reduce((n, c) => Math.max(n, c.pin.length), 4);
