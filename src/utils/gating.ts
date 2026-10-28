/**
 * Pure phase/account gating for every contract action. Each gate returns a
 * user-facing reason string when the action is not currently valid, so the UI
 * can disable controls and explain why without duplicating rule logic.
 * Mirrors the require() conditions of CommitRevealAuction.sol.
 */

export const PHASE_COMMIT = 0
export const PHASE_REVEAL = 1
export const PHASE_SETTLE = 2
export const PHASE_ENDED = 3

export function phaseName(phase: number): string {
  switch (phase) {
    case PHASE_COMMIT:
      return 'Commit'
    case PHASE_REVEAL:
      return 'Reveal'
    case PHASE_SETTLE:
      return 'Settle'
    case PHASE_ENDED:
      return 'Ended'
    default:
      return 'Unknown'
  }
}

export interface Gate {
  allowed: boolean
  reason: string | null
}

const allow: Gate = { allowed: true, reason: null }
const block = (reason: string): Gate => ({ allowed: false, reason })

export interface ActionContext {
  phase: number
  connected: boolean
  chainOk: boolean | null
  hasCode: boolean | null
  settled: boolean
  canceled: boolean
  commitmentActive: boolean
  revealed: boolean
  withdrawable: bigint
  balance: bigint
  isSeller: boolean
  /** Expected chain id (from VITE_CHAIN_ID, default Anvil 31337) for messaging. */
  expectedChainId?: number
}

function baseChecks(ctx: ActionContext): Gate | null {
  if (!ctx.connected) return block('Connect an account first')
  if (ctx.chainOk === false)
    return block(`Wrong chain: expected chain ID ${ctx.expectedChainId ?? 31337}`)
  if (ctx.chainOk === null) return block('RPC unreachable — is the local node running?')
  if (ctx.hasCode === false)
    return block('No contract code at the configured address — redeploy with npm run dev:local')
  if (ctx.hasCode === null) return block('Contract not checked yet')
  return null
}

export function gateCommit(ctx: ActionContext, bidAmountWei: bigint): Gate {
  const base = baseChecks(ctx)
  if (base) return base
  if (ctx.phase !== PHASE_COMMIT) {
    return block(
      ctx.phase === PHASE_ENDED
        ? 'Auction has ended'
        : 'Committing is only available during the commit phase',
    )
  }
  if (ctx.commitmentActive)
    return block('You already have an active commitment — refund it first to commit again')
  if (bidAmountWei <= 0n) return block('Enter a bid amount greater than 0')
  if (ctx.balance < bidAmountWei) return block('Insufficient balance to cover the bid escrow')
  return allow
}

export interface RevealCheckInputs {
  hashMatchesStored: boolean
  amountMatchesEscrow: boolean
  hasSavedSecrets: boolean
}

export function gateReveal(ctx: ActionContext, inputs: RevealCheckInputs): Gate {
  const base = baseChecks(ctx)
  if (base) return base
  if (ctx.phase !== PHASE_REVEAL)
    return block('Revealing is only available during the reveal phase')
  if (!ctx.commitmentActive) return block('No active commitment to reveal')
  if (ctx.revealed) return block('Bid already revealed')
  if (!inputs.hasSavedSecrets && !inputs.hashMatchesStored)
    return block('Enter the exact bid amount and nonce you committed with')
  if (!inputs.hashMatchesStored)
    return block('Bid values do not match the on-chain commitment hash — fix amount/nonce')
  if (!inputs.amountMatchesEscrow)
    return block('Bid amount must equal the escrowed deposit (commit escrow rule)')
  return allow
}

export function gateRefund(ctx: ActionContext): Gate {
  const base = baseChecks(ctx)
  if (base) return base
  if (ctx.phase !== PHASE_COMMIT)
    return block('Early refund is only available during the commit phase')
  if (!ctx.commitmentActive) return block('No active commitment to refund')
  if (ctx.revealed) return block('Already revealed — refund no longer applies')
  return allow
}

export function gateCancel(ctx: ActionContext): Gate {
  const base = baseChecks(ctx)
  if (base) return base
  if (ctx.phase !== PHASE_COMMIT)
    return block('Cancellation is only available during the commit phase')
  if (!ctx.isSeller) return block('Only the seller can cancel this auction')
  return allow
}

export function gateSettle(ctx: ActionContext): Gate {
  const base = baseChecks(ctx)
  if (base) return base
  if (ctx.settled) return block('Already settled')
  if (ctx.canceled) return block('Auction was cancelled — withdraw refunds instead')
  if (ctx.phase !== PHASE_SETTLE) return block('Settlement unlocks once the reveal deadline passes')
  return allow
}

export function gateWithdraw(ctx: ActionContext): Gate {
  const base = baseChecks(ctx)
  if (base) return base
  if (!ctx.settled && !ctx.canceled)
    return block('Withdrawals open after settlement or cancellation')
  if (ctx.withdrawable <= 0n) return block('Nothing to withdraw for this account')
  return allow
}
