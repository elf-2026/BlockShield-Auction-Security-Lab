import { useMemo } from 'react'
import { formatEther, type Address, type Hash } from 'viem'
import { Badge, Card, HexChip, cardCls } from './ui'
import { fmtEth } from '../utils/format'
import { PHASE_COMMIT, PHASE_ENDED, PHASE_REVEAL, PHASE_SETTLE } from '../utils/gating'

/** Live countdown to a unix deadline. */
export function Countdown({
  deadline,
  label = '',
  now,
}: {
  deadline: bigint
  label?: string
  now: number
}) {
  if (deadline <= 0n) return <span className="font-mono">—</span>
  const secs = Number(deadline) - now
  if (secs <= 0)
    return (
      <span className="font-mono text-red-600 dark:text-red-400">
        {label && `${label}: `}passed
      </span>
    )
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return (
    <span className="font-mono" data-testid="countdown">
      {label && `${label}: `}
      {m > 0 ? `${m}m ` : ''}
      {s}s
    </span>
  )
}

/** Phase lifecycle — horizontal on wide screens, vertical timeline on mobile. */
export function PhaseStepper({
  phase,
  commitDeadline,
  revealDeadline,
  settled,
  canceled,
  now,
}: {
  phase: number
  commitDeadline: bigint
  revealDeadline: bigint
  settled: boolean
  canceled: boolean
  now: number
}) {
  const steps = [
    { id: PHASE_COMMIT, label: 'Commit', hint: 'Sealed bids', deadline: commitDeadline },
    { id: PHASE_REVEAL, label: 'Reveal', hint: 'Open bids', deadline: revealDeadline },
    { id: PHASE_SETTLE, label: 'Settle', hint: 'Crystallize claims', deadline: null },
    { id: PHASE_ENDED, label: 'Ended', hint: 'Withdrawals', deadline: null },
  ]
  const stateOf = (id: number): 'done' | 'current' | 'upcoming' => {
    if (canceled) return id <= PHASE_COMMIT ? 'done' : id === PHASE_ENDED ? 'current' : 'upcoming'
    if (settled) return 'done'
    return id < phase ? 'done' : id === phase ? 'current' : 'upcoming'
  }
  return (
    <ol
      className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-0"
      data-testid="phase-stepper"
    >
      {steps.map((s, i) => {
        const st = stateOf(s.id)
        return (
          <li
            key={s.id}
            className={`flex flex-1 items-center gap-3 rounded-lg border px-3 py-2.5 sm:border-0 sm:px-2 ${
              st === 'current'
                ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/50'
                : 'border-gray-200 dark:border-gray-800'
            }`}
          >
            <span
              aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                st === 'done'
                  ? 'bg-emerald-500 text-white'
                  : st === 'current'
                    ? 'bg-indigo-600 text-white ring-4 ring-indigo-200 dark:ring-indigo-900'
                    : 'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
              }`}
            >
              {st === 'done' ? '✓' : i + 1}
            </span>
            <div className="min-w-0 text-xs leading-tight">
              <p
                className={`font-semibold ${st === 'upcoming' ? 'text-gray-500 dark:text-gray-400' : ''}`}
              >
                {s.label}
              </p>
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {st === 'current' && s.deadline !== null ? (
                  <Countdown deadline={s.deadline} label="ends in" now={now} />
                ) : (
                  s.hint
                )}
              </p>
            </div>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className="ml-auto hidden text-gray-300 sm:block sm:px-2 dark:text-gray-700"
              >
                →
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ---- activity feed --------------------------------------------------------

export interface FeedEvent {
  id: string
  ts: number
  kind:
    | 'created'
    | 'committed'
    | 'revealed'
    | 'settled'
    | 'canceled'
    | 'refunded'
    | 'withdrawn'
    | 'tx'
    | 'error'
  actor?: Address
  amount?: bigint
  hash?: Hash
  note?: string
}

const feedMeta: Record<
  FeedEvent['kind'],
  { label: string; tone: Parameters<typeof Badge>[0]['tone'] }
> = {
  created: { label: 'Auction created', tone: 'indigo' },
  committed: { label: 'Bid committed', tone: 'purple' },
  revealed: { label: 'Bid revealed', tone: 'amber' },
  settled: { label: 'Settled', tone: 'emerald' },
  canceled: { label: 'Canceled', tone: 'red' },
  refunded: { label: 'Refunded', tone: 'gray' },
  withdrawn: { label: 'Withdrawal', tone: 'emerald' },
  tx: { label: 'Transaction', tone: 'gray' },
  error: { label: 'Error', tone: 'red' },
}

export function ActivityFeed({ events }: { events: FeedEvent[] }) {
  const sorted = useMemo(() => [...events].sort((a, b) => b.ts - a.ts), [events])
  return (
    <Card title="Activity" subtitle="On-chain events for this deployment">
      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No events yet.</p>
      ) : (
        <ul
          className="max-h-80 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-800"
          data-testid="activity-feed"
        >
          {sorted.map((e) => {
            const meta = feedMeta[e.kind]
            return (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5 text-xs sm:flex-nowrap"
              >
                <span className="font-mono text-gray-400 dark:text-gray-500">
                  {new Date(e.ts * 1000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                {e.actor && <HexChip value={e.actor} className="min-w-0" />}
                {e.amount !== undefined && e.amount > 0n && (
                  <span className="font-mono">{formatEther(e.amount)} ETH</span>
                )}
                {e.note && (
                  <span className="min-w-0 basis-full text-gray-500 dark:text-gray-400 sm:basis-auto">
                    {e.note}
                  </span>
                )}
                {e.hash && <HexChip value={e.hash} className="min-w-0" />}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

// ---- security lab ---------------------------------------------------------

/**
 * Live invariant checks computed from real chain state — no simulated values.
 * I1 solvency: contract balance >= totalDeposits (excess = force-fed ETH,
 * which is deliberately NOT claimable by anyone).
 */
export function SecurityLab({
  contractBalance,
  totalDeposits,
  sellerProceeds,
  claimsLedger,
  now,
}: {
  contractBalance: bigint
  totalDeposits: bigint
  sellerProceeds: bigint
  claimsLedger: { label: string; value: bigint }[]
  now: number
}) {
  const excess = contractBalance > totalDeposits ? contractBalance - totalDeposits : 0n
  const solvencyOk = contractBalance >= totalDeposits
  return (
    <Card
      title="Security Lab"
      subtitle="Live audit view of the contract's accounting invariants"
      id="lab"
      actions={
        <Badge tone={solvencyOk ? 'emerald' : 'red'}>
          {solvencyOk ? 'I1 holds' : 'I1 VIOLATION'}
        </Badge>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className={`${cardCls} p-4`}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            I1 · Solvency
          </p>
          <p className="mt-1 font-mono text-sm">
            balance {formatEther(contractBalance)} ≥ escrow {formatEther(totalDeposits)}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {excess > 0n
              ? `Excess ${formatEther(excess)} ETH detected (self-destruct / force-send). Excess is locked forever — withdrawable() ignores it.`
              : 'Every wei in the contract has exactly one claimant.'}
          </p>
        </div>
        <div className={`${cardCls} p-4`}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            I3 · Claims ledger
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs">
            {claimsLedger.map((c) => (
              <li key={c.label} className="flex justify-between gap-2">
                <span className="text-gray-500 dark:text-gray-400">{c.label}</span>
                <span>{fmtEth(c.value)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-2 border-t pt-1 dark:border-gray-800">
              <span className="text-gray-500 dark:text-gray-400">Seller proceeds</span>
              <span>{fmtEth(sellerProceeds)}</span>
            </li>
          </ul>
        </div>
        <div className={`${cardCls} p-4`}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Design notes
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-gray-600 dark:text-gray-300">
            <li>Commitments bind chain id + contract (replay-safe)</li>
            <li>Settle performs no external calls (no blockage)</li>
            <li>CEI + nonReentrant on every ETH transfer</li>
            <li>Unrevealed escrow forfeits to seller at settlement</li>
          </ul>
          <p className="mt-2 text-[11px] text-gray-400">
            checked {new Date(now * 1000).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </Card>
  )
}
