/**
 * Ali Nawaz PDC — Cheque lifecycle & transfer workflow
 *
 * Pure functions that validate a requested cheque action and return the records
 * to write. Illegal status moves are rejected here (spec §17) rather than in the
 * UI, so no screen — or a future import — can push a cheque into a bad state.
 *
 * The headline rule (spec §13, §31.4): transferring a cheque NEVER clones it.
 * The one cheque record keeps its number, bank, date and amount; only its
 * holder, status and allocation change, and a movement row records the hop.
 */

import type {
  Cheque,
  ChequeHolder,
  ChequeMovement,
  ChequeStatus,
  PdcDataSet,
  PdcLedgerEntry,
  PdcTransaction,
} from '@/types/pdc';
import type { ISODate } from '@/types';
import {
  bankAcc,
  buildLines,
  chequeAcc,
  nextReference,
  partyAcc,
  type Posting,
} from '@/lib/pdcEngine';
import { round2, uid, now, periodOf } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Status rules (spec §17)
// ---------------------------------------------------------------------------

/** Terminal statuses — a cheque here cannot move again without a reversal. */
const TERMINAL: ChequeStatus[] = ['cancelled', 'replaced'];

/** Allowed next statuses per current status, per direction. */
const RECEIVED_NEXT: Record<string, ChequeStatus[]> = {
  pending: ['transferred', 'deposited', 'cancelled', 'bounced', 'returned'],
  transferred: ['bounced', 'returned', 'cleared'],
  deposited: ['cleared', 'bounced', 'returned'],
  cleared: [],
  bounced: ['replaced', 'returned'],
  returned: ['replaced', 'cancelled'],
  cancelled: [],
  replaced: [],
};

const ISSUED_NEXT: Record<string, ChequeStatus[]> = {
  pending: ['presented', 'cancelled', 'returned'],
  presented: ['cleared', 'bounced', 'returned'],
  cleared: [],
  bounced: ['replaced', 'returned'],
  returned: ['replaced', 'cancelled'],
  cancelled: [],
  replaced: [],
};

/**
 * Can this cheque legally move to `next`? Returns an error message, or null
 * when the move is allowed.
 */
export function validateStatusChange(cheque: Cheque, next: ChequeStatus): string | null {
  if (cheque.status === next) return `Cheque is already ${next}.`;
  if (TERMINAL.includes(cheque.status)) {
    return `A ${cheque.status} cheque cannot be changed. Reverse it first.`;
  }
  if (cheque.status === 'cleared') {
    return 'A cleared cheque cannot be edited without a reversal.';
  }
  const table = cheque.direction === 'received' ? RECEIVED_NEXT : ISSUED_NEXT;
  const allowed = table[cheque.status] ?? [];
  if (!allowed.includes(next)) {
    return `A ${cheque.status} cheque cannot be marked ${next}.`;
  }
  return null;
}

/** Amount of a cheque not yet allocated to a payable. */
export function unallocated(cheque: Cheque): number {
  return round2(cheque.amount - (cheque.allocatedAmount || 0));
}

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

function makeTxn(
  data: PdcDataSet,
  type: PdcTransaction['type'],
  date: ISODate,
  amount: number,
  extra: Partial<PdcTransaction> = {}
): PdcTransaction {
  const { month, year } = periodOf(date);
  const t = now();
  return {
    id: uid(),
    reference: nextReference(data, type),
    type,
    date,
    month,
    year,
    amount: round2(amount),
    createdAt: t,
    updatedAt: t,
    ...extra,
  };
}

function movement(
  chequeId: string,
  date: ISODate,
  action: string,
  extra: Partial<ChequeMovement> = {}
): ChequeMovement {
  return { id: uid(), chequeId, at: now(), date, action, ...extra };
}

/** A workflow result: the posting plus the updated cheque record. */
export interface WorkflowResult extends Posting {
  cheque: Cheque;
}

// ---------------------------------------------------------------------------
// Cheque endorsement / transfer to another party (spec §13)
// ---------------------------------------------------------------------------

export interface ChequeTransferInput {
  chequeId: string;
  toPartyId: string;
  date: ISODate;
  /** Amount to allocate. Must equal the full cheque unless partial is enabled. */
  amount: number;
  description?: string;
}

/**
 * Endorse a RECEIVED cheque over to another party as payment.
 *
 * Accounting: the cheque asset leaves our custody and settles what we owe the
 * new party, so:
 *   Dr New Party      (their payable drops)
 *   Cr Cheque custody (asset released)
 *
 * The original cheque record is reused — never duplicated.
 */
export function buildChequeTransfer(
  data: PdcDataSet,
  input: ChequeTransferInput
): WorkflowResult | { error: string } {
  const cheque = data.cheques.find((c) => c.id === input.chequeId);
  if (!cheque) return { error: 'Cheque not found.' };
  if (cheque.direction !== 'received') {
    return { error: 'Only a received cheque can be endorsed to another party.' };
  }
  if (cheque.partyId === input.toPartyId) {
    return { error: 'Cannot transfer a cheque back to the party it came from.' };
  }
  if (cheque.holder.kind === 'party' && cheque.holder.partyId === input.toPartyId) {
    return { error: 'This party already holds the cheque.' };
  }
  const statusError = validateStatusChange(cheque, 'transferred');
  // A partially-allocated cheque is still 'pending', so re-transfer is allowed
  // only when partial allocation is on and there is headroom left.
  if (statusError && !(data.settings.allowPartialAllocation && cheque.status === 'pending')) {
    return { error: statusError };
  }

  const amount = round2(input.amount);
  if (amount <= 0) return { error: 'Transfer amount must be greater than zero.' };

  const left = unallocated(cheque);
  if (!data.settings.allowPartialAllocation) {
    if (amount !== cheque.amount) {
      return {
        error:
          'Partial allocation is disabled — the whole cheque must be transferred. Enable it in Settings to split a cheque.',
      };
    }
  } else if (amount > left) {
    return { error: `Only ${left} remains unallocated on this cheque.` };
  }

  const txn = makeTxn(data, 'Cheque Endorsement', input.date, amount, {
    partyId: cheque.partyId,
    toPartyId: input.toPartyId,
    chequeId: cheque.id,
    description: input.description,
  });

  const toName = data.parties.find((p) => p.id === input.toPartyId)?.name ?? 'party';
  const desc =
    input.description || `Cheque ${cheque.chequeNumber} endorsed to ${toName}`;

  const lines = buildLines(txn, [
    {
      account: partyAcc(input.toPartyId),
      debit: amount,
      description: desc,
      chequeId: cheque.id,
      relatedPartyId: cheque.partyId,
      mainLedger: 'Transfers',
    },
    {
      account: chequeAcc(cheque.id, 'received'),
      credit: amount,
      description: desc,
      chequeId: cheque.id,
      relatedPartyId: input.toPartyId,
      mainLedger: 'PDC Received',
    },
  ]);

  const allocated = round2((cheque.allocatedAmount || 0) + amount);
  const fullyAllocated = allocated >= cheque.amount - 0.005;
  const toHolder: ChequeHolder = { kind: 'party', partyId: input.toPartyId };

  const updated: Cheque = {
    ...cheque,
    // Only a fully-allocated cheque leaves our books as 'transferred'.
    status: fullyAllocated ? 'transferred' : cheque.status,
    holder: fullyAllocated ? toHolder : cheque.holder,
    allocatedAmount: allocated,
    updatedAt: now(),
  };

  return {
    txn,
    lines,
    cheque: updated,
    movements: [
      movement(cheque.id, input.date, 'Transferred to party', {
        fromStatus: cheque.status,
        toStatus: updated.status,
        fromHolder: cheque.holder,
        toHolder: updated.holder,
        fromPartyId: cheque.partyId,
        toPartyId: input.toPartyId,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Deposit a received cheque into a bank account
// ---------------------------------------------------------------------------

export interface DepositInput {
  chequeId: string;
  bankAccountId: string;
  date: ISODate;
  description?: string;
}

/** Marks the cheque deposited. No cash moves until it clears. */
export function buildChequeDeposit(
  data: PdcDataSet,
  input: DepositInput
): WorkflowResult | { error: string } {
  const cheque = data.cheques.find((c) => c.id === input.chequeId);
  if (!cheque) return { error: 'Cheque not found.' };
  if (cheque.direction !== 'received') {
    return { error: 'Only a received cheque can be deposited.' };
  }
  const err = validateStatusChange(cheque, 'deposited');
  if (err) return { error: err };

  const txn = makeTxn(data, 'Cheque Deposited', input.date, cheque.amount, {
    partyId: cheque.partyId,
    chequeId: cheque.id,
    toBankAccountId: input.bankAccountId,
    description: input.description,
  });
  const desc = input.description || `Cheque ${cheque.chequeNumber} deposited`;

  // Status-only move: no balanced money movement yet, so no ledger lines. The
  // bank is debited when the cheque clears.
  const updated: Cheque = {
    ...cheque,
    status: 'deposited',
    bankAccountId: input.bankAccountId,
    holder: { kind: 'bank', bankAccountId: input.bankAccountId },
    updatedAt: now(),
  };

  return {
    txn,
    lines: [],
    cheque: updated,
    movements: [
      movement(cheque.id, input.date, 'Deposited to bank', {
        fromStatus: cheque.status,
        toStatus: 'deposited',
        fromHolder: cheque.holder,
        toHolder: updated.holder,
        bankAccountId: input.bankAccountId,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Clear a cheque — the moment money actually moves
// ---------------------------------------------------------------------------

export interface ClearInput {
  chequeId: string;
  date: ISODate;
  /** Bank account the funds land in / leave from. */
  bankAccountId?: string;
  description?: string;
}

/**
 * Clearing converts the cheque into real bank money.
 *   Received: Dr Bank, Cr Cheque custody (asset realised)
 *   Issued:   Dr Cheque custody (liability discharged), Cr Bank
 */
export function buildChequeClear(
  data: PdcDataSet,
  input: ClearInput
): WorkflowResult | { error: string } {
  const cheque = data.cheques.find((c) => c.id === input.chequeId);
  if (!cheque) return { error: 'Cheque not found.' };
  const err = validateStatusChange(cheque, 'cleared');
  if (err) return { error: err };

  const accountId = input.bankAccountId || cheque.bankAccountId;
  if (!accountId) {
    return { error: 'Select the bank account this cheque cleared through.' };
  }
  // A cheque endorsed away is cleared in the holder's hands — it must not
  // credit our bank, because we never banked it.
  if (cheque.status === 'transferred') {
    return {
      error:
        'This cheque was endorsed to another party. It clears in their hands — reverse the endorsement first if it came back.',
    };
  }

  const amount = cheque.amount;
  const txn = makeTxn(data, 'Cheque Cleared', input.date, amount, {
    partyId: cheque.partyId,
    chequeId: cheque.id,
    toBankAccountId: cheque.direction === 'received' ? accountId : undefined,
    fromBankAccountId: cheque.direction === 'issued' ? accountId : undefined,
    description: input.description,
  });
  const desc = input.description || `Cheque ${cheque.chequeNumber} cleared`;

  const lines =
    cheque.direction === 'received'
      ? buildLines(txn, [
          { account: bankAcc(accountId), debit: amount, description: desc, chequeId: cheque.id, relatedPartyId: cheque.partyId },
          { account: chequeAcc(cheque.id, 'received'), credit: amount, description: desc, chequeId: cheque.id, mainLedger: 'PDC Received' },
        ])
      : buildLines(txn, [
          { account: chequeAcc(cheque.id, 'issued'), debit: amount, description: desc, chequeId: cheque.id, mainLedger: 'PDC Issued' },
          { account: bankAcc(accountId), credit: amount, description: desc, chequeId: cheque.id, relatedPartyId: cheque.partyId },
        ]);

  const updated: Cheque = {
    ...cheque,
    status: 'cleared',
    bankAccountId: accountId,
    holder: { kind: 'bank', bankAccountId: accountId },
    updatedAt: now(),
  };

  return {
    txn,
    lines,
    cheque: updated,
    movements: [
      movement(cheque.id, input.date, 'Cleared', {
        fromStatus: cheque.status,
        toStatus: 'cleared',
        fromHolder: cheque.holder,
        toHolder: updated.holder,
        bankAccountId: accountId,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Bounce (spec §19)
// ---------------------------------------------------------------------------

export interface BounceInput {
  chequeId: string;
  date: ISODate;
  reason: string;
  description?: string;
}

/**
 * A bounce restores the ORIGINAL debt — it is never a status flip alone.
 * Received: Dr Party (their receivable comes back), Cr cheque custody.
 * Issued:   Dr cheque custody (liability released), Cr Party (payable returns).
 * Any bank movement from an earlier clearance is undone by reversing that
 * clearance transaction first.
 */
export function buildChequeBounce(
  data: PdcDataSet,
  input: BounceInput
): WorkflowResult | { error: string } {
  const cheque = data.cheques.find((c) => c.id === input.chequeId);
  if (!cheque) return { error: 'Cheque not found.' };
  const err = validateStatusChange(cheque, 'bounced');
  if (err) return { error: err };
  if (!input.reason?.trim()) return { error: 'A bounce reason is required.' };

  const amount = cheque.amount;
  const txn = makeTxn(data, 'Cheque Bounced', input.date, amount, {
    partyId: cheque.partyId,
    chequeId: cheque.id,
    description: input.description || input.reason,
  });
  const desc = `Cheque ${cheque.chequeNumber} bounced — ${input.reason}`;

  // Restore the debt against whoever currently holds the exposure: for an
  // endorsed cheque that is the party we endorsed it to.
  const exposedParty =
    cheque.direction === 'received' && cheque.holder.kind === 'party'
      ? cheque.holder.partyId
      : cheque.partyId;

  const lines =
    cheque.direction === 'received'
      ? buildLines(txn, [
          { account: partyAcc(exposedParty), debit: amount, description: desc, chequeId: cheque.id, mainLedger: 'Parties' },
          { account: chequeAcc(cheque.id, 'received'), credit: amount, description: desc, chequeId: cheque.id, mainLedger: 'PDC Received' },
        ])
      : buildLines(txn, [
          { account: chequeAcc(cheque.id, 'issued'), debit: amount, description: desc, chequeId: cheque.id, mainLedger: 'PDC Issued' },
          { account: partyAcc(cheque.partyId), credit: amount, description: desc, chequeId: cheque.id, mainLedger: 'Parties' },
        ]);

  const updated: Cheque = {
    ...cheque,
    status: 'bounced',
    bouncedOn: input.date,
    bounceReason: input.reason,
    holder: { kind: 'business' },
    updatedAt: now(),
  };

  return {
    txn,
    lines,
    cheque: updated,
    movements: [
      movement(cheque.id, input.date, 'Bounced', {
        fromStatus: cheque.status,
        toStatus: 'bounced',
        fromHolder: cheque.holder,
        toHolder: updated.holder,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Return (spec §17)
// ---------------------------------------------------------------------------

export interface ReturnInput {
  chequeId: string;
  date: ISODate;
  reason?: string;
  description?: string;
}

/**
 * Hand a cheque back without presenting it — the party asks for it, the
 * details are wrong, and so on.
 *
 * Accounting-wise this is the same restoration as a bounce: the debt the
 * cheque had settled comes back. It is a separate status because the CAUSE
 * differs, and reports and cheque history should say which happened.
 */
export function buildChequeReturn(
  data: PdcDataSet,
  input: ReturnInput
): WorkflowResult | { error: string } {
  const cheque = data.cheques.find((c) => c.id === input.chequeId);
  if (!cheque) return { error: 'Cheque not found.' };
  const err = validateStatusChange(cheque, 'returned');
  if (err) return { error: err };

  const amount = cheque.amount;
  const txn = makeTxn(data, 'Cheque Returned', input.date, amount, {
    partyId: cheque.partyId,
    chequeId: cheque.id,
    description: input.description || input.reason,
  });
  const desc = input.reason
    ? `Cheque ${cheque.chequeNumber} returned — ${input.reason}`
    : `Cheque ${cheque.chequeNumber} returned`;

  // Whoever currently holds the cheque carries the exposure, exactly as with a
  // bounce: if it was endorsed onward, the debt reverts to the endorsee.
  const exposedParty =
    cheque.direction === 'received' && cheque.holder.kind === 'party'
      ? cheque.holder.partyId
      : cheque.partyId;

  const lines =
    cheque.direction === 'received'
      ? buildLines(txn, [
          { account: partyAcc(exposedParty), debit: amount, description: desc, chequeId: cheque.id, mainLedger: 'Parties' },
          { account: chequeAcc(cheque.id, 'received'), credit: amount, description: desc, chequeId: cheque.id, mainLedger: 'PDC Received' },
        ])
      : buildLines(txn, [
          { account: chequeAcc(cheque.id, 'issued'), debit: amount, description: desc, chequeId: cheque.id, mainLedger: 'PDC Issued' },
          { account: partyAcc(cheque.partyId), credit: amount, description: desc, chequeId: cheque.id, mainLedger: 'Parties' },
        ]);

  const updated: Cheque = {
    ...cheque,
    status: 'returned',
    holder: { kind: 'business' },
    updatedAt: now(),
  };

  return {
    txn,
    lines,
    cheque: updated,
    movements: [
      movement(cheque.id, input.date, 'Returned', {
        fromStatus: cheque.status,
        toStatus: 'returned',
        fromHolder: cheque.holder,
        toHolder: updated.holder,
        txnId: txn.id,
        reference: txn.reference,
        description: desc,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Replacement cheque (spec §19)
// ---------------------------------------------------------------------------

export interface ReplacementLink {
  originalChequeId: string;
  replacementChequeId: string;
  date: ISODate;
}

/**
 * Link a new cheque to the bounced one it replaces. Both records are updated so
 * the history stays navigable in either direction; the bounced cheque is NEVER
 * deleted (spec §19: "keep the bounced cheque in history").
 */
export function linkReplacement(
  data: PdcDataSet,
  input: ReplacementLink
): { original: Cheque; replacement: Cheque; movements: ChequeMovement[] } | { error: string } {
  const original = data.cheques.find((c) => c.id === input.originalChequeId);
  const replacement = data.cheques.find((c) => c.id === input.replacementChequeId);
  if (!original) return { error: 'Original cheque not found.' };
  if (!replacement) return { error: 'Replacement cheque not found.' };
  if (original.id === replacement.id) {
    return { error: 'A cheque cannot replace itself.' };
  }
  if (original.status !== 'bounced' && original.status !== 'returned') {
    return { error: 'Only a bounced or returned cheque can be replaced.' };
  }
  if (original.replacedByChequeId) {
    return { error: 'This cheque has already been replaced.' };
  }

  return {
    original: { ...original, status: 'replaced', replacedByChequeId: replacement.id, updatedAt: now() },
    replacement: { ...replacement, replacesChequeId: original.id, updatedAt: now() },
    movements: [
      movement(original.id, input.date, 'Replaced by new cheque', {
        fromStatus: original.status,
        toStatus: 'replaced',
        description: `Replaced by cheque ${replacement.chequeNumber}`,
      }),
      movement(replacement.id, input.date, 'Issued as replacement', {
        description: `Replaces bounced cheque ${original.chequeNumber}`,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Reversal (spec §26)
// ---------------------------------------------------------------------------

/**
 * Build the mirror posting that undoes a transaction. Debits become credits and
 * vice versa, so the pair nets to zero while BOTH stay visible in history.
 */
export function buildReversal(
  data: PdcDataSet,
  txnId: string,
  date: ISODate,
  reason?: string
): { txn: PdcTransaction; lines: PdcLedgerEntry[] } | { error: string } {
  const original = data.transactions.find((t) => t.id === txnId);
  if (!original) return { error: 'Transaction not found.' };
  if (original.reversed) return { error: 'This transaction has already been reversed.' };
  if (original.type === 'Reversal') return { error: 'A reversal cannot itself be reversed.' };

  const originalLines = data.ledger.filter((l) => l.txnId === txnId);
  if (originalLines.length === 0) {
    // Status-only transactions (e.g. a deposit) have no lines; reversing them
    // is still valid and just restores the previous cheque state.
    const txn = makeTxn(data, 'Reversal', date, original.amount, {
      reversesTxnId: txnId,
      chequeId: original.chequeId,
      partyId: original.partyId,
      description: reason || `Reversal of ${original.reference}`,
    });
    return { txn, lines: [] };
  }

  const txn = makeTxn(data, 'Reversal', date, original.amount, {
    reversesTxnId: txnId,
    chequeId: original.chequeId,
    partyId: original.partyId,
    toPartyId: original.toPartyId,
    fromBankAccountId: original.fromBankAccountId,
    toBankAccountId: original.toBankAccountId,
    description: reason || `Reversal of ${original.reference}`,
  });

  const desc = reason || `Reversal of ${original.reference}`;
  const lines = buildLines(
    txn,
    originalLines.map((l) => ({
      account: l.account,
      // Swap the sides to undo the original effect.
      debit: l.credit,
      credit: l.debit,
      description: desc,
      chequeId: l.chequeId,
      relatedPartyId: l.relatedPartyId,
      relatedBankAccountId: l.relatedBankAccountId,
      mainLedger: l.mainLedger,
    }))
  );

  return { txn, lines };
}

// ---------------------------------------------------------------------------
// Validation shared by the entry forms (spec §28)
// ---------------------------------------------------------------------------

/**
 * Duplicate cheque numbers are rejected per bank account (spec §28). For a
 * received cheque there is no account of ours, so the drawer's bank is used.
 */
export function isDuplicateCheque(
  data: PdcDataSet,
  candidate: { chequeNumber: string; bankId: string; bankAccountId?: string; direction: string },
  ignoreChequeId?: string
): boolean {
  const num = candidate.chequeNumber.trim().toLowerCase();
  if (!num) return false;
  return data.cheques.some((c) => {
    if (c.id === ignoreChequeId) return false;
    if (c.chequeNumber.trim().toLowerCase() !== num) return false;
    if (c.direction !== candidate.direction) return false;
    return candidate.bankAccountId
      ? c.bankAccountId === candidate.bankAccountId
      : c.bankId === candidate.bankId;
  });
}

/** Full cheque timeline, oldest first (spec §18). */
export function chequeTimeline(data: PdcDataSet, chequeId: string): ChequeMovement[] {
  return data.movements
    .filter((m) => m.chequeId === chequeId)
    .sort((a, b) => a.at - b.at);
}
