/**
 * Scope-A tests: environment-driven chain configuration, injected-wallet
 * detection/signing mode selection, and the combined RPC+wallet chain gate.
 * These are the pure/unit-level halves of the wallet work; the interactive
 * half lives in the full-lifecycle browser audit (scripts/audit-full-lifecycle.mjs).
 */
import { describe, expect, it } from 'vitest'
import { combineChainOk, getInjectedProvider, makeWalletClient, resolveChainId } from './contract'

describe('resolveChainId (VITE_CHAIN_ID precedence)', () => {
  it('defaults to the Anvil chain (31337) when unset or blank', () => {
    expect(resolveChainId(undefined)).toBe(31337)
    expect(resolveChainId('')).toBe(31337)
  })

  it('accepts a valid decimal chain id', () => {
    expect(resolveChainId('11155111')).toBe(11155111)
    expect(resolveChainId('31337')).toBe(31337)
    expect(resolveChainId('1')).toBe(1)
  })

  it('falls back to 31337 for malformed values (never NaN, never 0, never negative)', () => {
    for (const bad of ['abc', '0x7a69', '-4', '0', '1.5', '1e3', '  ', '31337 ']) {
      expect(resolveChainId(bad)).toBe(31337)
    }
  })

  it('rejects huge non-integers beyond safe range', () => {
    expect(resolveChainId('99999999999999999999999999')).toBe(31337)
  })
})

describe('combineChainOk (read-side + wallet-side chain gating)', () => {
  it('local mode mirrors the RPC chain check exactly', () => {
    expect(combineChainOk('local', true, null)).toBe(true)
    expect(combineChainOk('local', false, null)).toBe(false)
    expect(combineChainOk('local', null, null)).toBe(null)
    // a stale wallet flag must not override local mode
    expect(combineChainOk('local', true, false)).toBe(false) // explicit wallet mismatch still blocks
  })

  it('injected mode requires BOTH checks true — never optimistic', () => {
    expect(combineChainOk('injected', true, true)).toBe(true)
    expect(combineChainOk('injected', true, false)).toBe(false)
    expect(combineChainOk('injected', false, true)).toBe(false)
    expect(combineChainOk('injected', true, null)).toBe(null)
    expect(combineChainOk('injected', null, true)).toBe(null)
    expect(combineChainOk('injected', null, null)).toBe(null)
  })

  it('any explicit false dominates unknowns (fail-closed)', () => {
    expect(combineChainOk('injected', false, null)).toBe(false)
    expect(combineChainOk('local', false, true)).toBe(false)
  })
})

describe('injected wallet detection & signing mode', () => {
  const fakeWindow = (ethereum: unknown) => {
    ;(globalThis as { window?: unknown }).window = ethereum
  }
  it('returns null without window.ethereum (plain browser / node)', () => {
    fakeWindow(undefined)
    expect(getInjectedProvider()).toBeNull()
  })

  it('ignores a window.ethereum without a request function (non-EIP-1193 object)', () => {
    fakeWindow({ ethereum: { notALive: true } })
    expect(getInjectedProvider()).toBeNull()
    fakeWindow(undefined)
  })

  it('accepts a proper EIP-1193 provider', () => {
    fakeWindow({ ethereum: { request: async () => [] } })
    expect(getInjectedProvider()).not.toBeNull()
    fakeWindow(undefined)
  })

  it('makeWalletClient(injected) with no provider fails loudly instead of silently falling back to the local node', () => {
    fakeWindow(undefined)
    expect(() =>
      makeWalletClient('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 'injected'),
    ).toThrowError(/No injected wallet/)
  })

  it('makeWalletClient(local) never requires a provider', () => {
    expect(() =>
      makeWalletClient('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 'local'),
    ).not.toThrow()
    // and mode defaults to local for callers that omit it
    expect(() => makeWalletClient('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).not.toThrow()
  })
})

describe('gating wrong-chain message is env-driven', () => {
  it('uses the configured expectedChainId in the block reason', async () => {
    const { gateCommit } = await import('./gating')
    const ctx = {
      phase: 0,
      connected: true,
      chainOk: false,
      hasCode: true,
      settled: false,
      canceled: false,
      commitmentActive: false,
      revealed: false,
      withdrawable: 0n,
      balance: 1n,
      isSeller: false,
      expectedChainId: 11155111,
    }
    const gate = gateCommit(ctx, 1n)
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/11155111/)
    // default remains the Anvil chain id
    delete (ctx as { expectedChainId?: number }).expectedChainId
    expect(gateCommit(ctx, 1n).reason).toMatch(/31337/)
  })
})
