import { describe, expect, it } from 'vitest'
import {
  PHASE_COMMIT,
  PHASE_ENDED,
  PHASE_REVEAL,
  PHASE_SETTLE,
  gateCancel,
  gateCommit,
  gateRefund,
  gateReveal,
  gateSettle,
  gateWithdraw,
  phaseName,
  type ActionContext,
} from './gating'

const WEI = (n: number) => BigInt(n) * 10n ** 18n

const baseCtx = (over: Partial<ActionContext> = {}): ActionContext => ({
  phase: PHASE_COMMIT,
  connected: true,
  chainOk: true,
  hasCode: true,
  settled: false,
  canceled: false,
  commitmentActive: false,
  revealed: false,
  withdrawable: 0n,
  balance: WEI(10),
  isSeller: false,
  ...over,
})

describe('environment gates (apply to every action)', () => {
  it('blocks when not connected', () => {
    expect(gateCommit(baseCtx({ connected: false }), 1n).allowed).toBe(false)
    expect(gateReveal(baseCtx({ connected: false }), alwaysAllowReveal()).allowed).toBe(false)
    expect(gateRefund(baseCtx({ connected: false })).allowed).toBe(false)
    expect(gateCancel(baseCtx({ connected: false })).allowed).toBe(false)
    expect(gateSettle(baseCtx({ connected: false })).allowed).toBe(false)
    expect(gateWithdraw(baseCtx({ connected: false })).allowed).toBe(false)
  })

  it('blocks wrong chain with an explanatory reason', () => {
    const gate = gateCommit(baseCtx({ chainOk: false }), WEI(1))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/chain/i)
  })

  it('blocks when RPC is unreachable (chainOk unknown)', () => {
    expect(gateSettle(baseCtx({ chainOk: null })).allowed).toBe(false)
  })

  it('blocks when no contract code is deployed at the address', () => {
    const gate = gateWithdraw(baseCtx({ hasCode: false, settled: true, withdrawable: WEI(1) }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/no contract code/i)
  })
})

function alwaysAllowReveal() {
  return { hashMatchesStored: true, amountMatchesEscrow: true, hasSavedSecrets: true }
}

describe('commit gating', () => {
  it('allows a funded commit during the commit phase', () => {
    expect(gateCommit(baseCtx(), WEI(1)).allowed).toBe(true)
  })

  it('blocks outside the commit phase', () => {
    expect(gateCommit(baseCtx({ phase: PHASE_REVEAL }), WEI(1)).allowed).toBe(false)
    expect(gateCommit(baseCtx({ phase: PHASE_SETTLE }), WEI(1)).allowed).toBe(false)
    expect(gateCommit(baseCtx({ phase: PHASE_ENDED }), WEI(1)).allowed).toBe(false)
  })

  it('blocks when an active commitment exists (must refund first)', () => {
    const gate = gateCommit(baseCtx({ commitmentActive: true }), WEI(1))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/refund it first/i)
  })

  it('blocks empty or negative bids', () => {
    expect(gateCommit(baseCtx(), 0n).allowed).toBe(false)
    expect(gateCommit(baseCtx(), -1n).allowed).toBe(false)
  })

  it('blocks when balance cannot cover the escrow', () => {
    const gate = gateCommit(baseCtx({ balance: WEI(1) }), WEI(2))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/balance/i)
  })
})

describe('reveal gating', () => {
  it('allows only in the reveal phase with a matching commitment and escrow', () => {
    expect(
      gateReveal(baseCtx({ phase: PHASE_REVEAL, commitmentActive: true }), alwaysAllowReveal())
        .allowed,
    ).toBe(true)
  })

  it('blocks during commit / settle / ended phases', () => {
    for (const phase of [PHASE_COMMIT, PHASE_SETTLE, PHASE_ENDED]) {
      expect(
        gateReveal(baseCtx({ phase, commitmentActive: true }), alwaysAllowReveal()).allowed,
      ).toBe(false)
    }
  })

  it('blocks without an active commitment', () => {
    expect(
      gateReveal(baseCtx({ phase: PHASE_REVEAL, commitmentActive: false }), alwaysAllowReveal())
        .allowed,
    ).toBe(false)
  })

  it('blocks when already revealed', () => {
    expect(
      gateReveal(
        baseCtx({ phase: PHASE_REVEAL, commitmentActive: true, revealed: true }),
        alwaysAllowReveal(),
      ).allowed,
    ).toBe(false)
  })

  it('blocks when the recomputed hash does not match the stored commitment', () => {
    const gate = gateReveal(baseCtx({ phase: PHASE_REVEAL, commitmentActive: true }), {
      hashMatchesStored: false,
      amountMatchesEscrow: true,
      hasSavedSecrets: true,
    })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/commitment hash/i)
  })

  it('blocks when the bid amount differs from the escrow', () => {
    const gate = gateReveal(baseCtx({ phase: PHASE_REVEAL, commitmentActive: true }), {
      hashMatchesStored: true,
      amountMatchesEscrow: false,
      hasSavedSecrets: true,
    })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/escrow/i)
  })
})

describe('refund gating (early exit, commit phase only)', () => {
  it('allows refund of an active unrevealed commitment during commit', () => {
    expect(gateRefund(baseCtx({ commitmentActive: true })).allowed).toBe(true)
  })

  it('blocks after the commit phase', () => {
    expect(gateRefund(baseCtx({ phase: PHASE_REVEAL, commitmentActive: true })).allowed).toBe(false)
  })

  it('blocks without a commitment or after reveal', () => {
    expect(gateRefund(baseCtx({ commitmentActive: false })).allowed).toBe(false)
    expect(gateRefund(baseCtx({ commitmentActive: true, revealed: true })).allowed).toBe(false)
  })
})

describe('cancel gating (seller-only, commit phase)', () => {
  it('allows the seller during commit', () => {
    expect(gateCancel(baseCtx({ isSeller: true })).allowed).toBe(true)
  })

  it('blocks non-sellers', () => {
    const gate = gateCancel(baseCtx({ isSeller: false }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/seller/i)
  })

  it('blocks outside the commit phase', () => {
    expect(gateCancel(baseCtx({ isSeller: true, phase: PHASE_REVEAL })).allowed).toBe(false)
  })
})

describe('settle gating', () => {
  it('allows settlement during the settle phase', () => {
    expect(gateSettle(baseCtx({ phase: PHASE_SETTLE })).allowed).toBe(true)
  })

  it('blocks before the reveal deadline', () => {
    expect(gateSettle(baseCtx({ phase: PHASE_COMMIT })).allowed).toBe(false)
    expect(gateSettle(baseCtx({ phase: PHASE_REVEAL })).allowed).toBe(false)
  })

  it('blocks when already settled or cancelled', () => {
    expect(gateSettle(baseCtx({ phase: PHASE_SETTLE, settled: true })).allowed).toBe(false)
    expect(gateSettle(baseCtx({ phase: PHASE_SETTLE, canceled: true })).allowed).toBe(false)
  })
})

describe('withdraw gating (pull-based claims)', () => {
  it('allows after settlement when a claim exists', () => {
    expect(gateWithdraw(baseCtx({ settled: true, withdrawable: WEI(1) })).allowed).toBe(true)
  })

  it('allows after cancellation', () => {
    expect(gateWithdraw(baseCtx({ canceled: true, withdrawable: WEI(1) })).allowed).toBe(true)
  })

  it('blocks while the auction is active (withdrawable preview is 0 then)', () => {
    expect(gateWithdraw(baseCtx({ phase: PHASE_REVEAL })).allowed).toBe(false)
  })

  it('blocks when the account has nothing to claim (incl. unrevealed bidders after settlement)', () => {
    const gate = gateWithdraw(baseCtx({ settled: true, withdrawable: 0n }))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/nothing to withdraw/i)
  })
})

describe('phaseName', () => {
  it('maps contract phase ids to labels', () => {
    expect(phaseName(PHASE_COMMIT)).toBe('Commit')
    expect(phaseName(PHASE_REVEAL)).toBe('Reveal')
    expect(phaseName(PHASE_SETTLE)).toBe('Settle')
    expect(phaseName(PHASE_ENDED)).toBe('Ended')
    expect(phaseName(99)).toBe('Unknown')
  })
})
