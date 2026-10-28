import { describe, expect, it, vi } from 'vitest'
import { keccak256, stringToHex } from 'viem'
import { COMMITMENT_DOMAIN_TAG, computeCommitmentHash, generateNonce } from './commitment'

/**
 * Golden vectors — expected values were produced by the Solidity
 * implementation itself:
 *   - vec1/vec2/vec3: cast call <deployed> computeCommitmentHash(...) on a
 *     fresh Anvil deployment (chainId 31337, CREATE address from account 0).
 *   - vecChain1/vecDead: built from the verified abi.encodePacked layout
 *     (20-byte addresses) and hashed with `cast keccak`.
 * The live integration test re-verifies local == on-chain on a running node.
 */

const ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const
const BIDDER_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const BIDDER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const DEAD_CONTRACT = '0x000000000000000000000000000000000000dEaD' as const
const ONE_ETH = 10n ** 18n
const TWO_ETH = 2n * 10n ** 18n

const base = {
  bidder: BIDDER_A,
  bidAmount: ONE_ETH,
  nonce: 123456789n,
  chainId: 31337,
  contractAddress: ADDR,
}

describe('commitment domain tag', () => {
  it('equals keccak256 of the Solidity domain string', () => {
    expect(COMMITMENT_DOMAIN_TAG).toBe(keccak256(stringToHex('BlockShield.CommitReveal.V2')))
    expect(COMMITMENT_DOMAIN_TAG).toBe(
      '0x185d1493f458411625d2ea6eacf72346ed9f7200d3f104d52be28ab6289489de',
    )
  })
})

describe('computeCommitmentHash golden vectors (from Solidity)', () => {
  it('vec1: bidder A, 1 ETH, nonce 123456789', () => {
    expect(computeCommitmentHash(base)).toBe(
      '0xf92886231495998687d578bd109bad68c70bed8665ab1059129d40b127db3b2a',
    )
  })

  it('vec2: bidder B, 1 ETH, nonce 123456789 (bidder change)', () => {
    expect(computeCommitmentHash({ ...base, bidder: BIDDER_B })).toBe(
      '0x83c22c59a9d2c832b6b42a0617ae90707df87275099dfb291e573b4ca8011216',
    )
  })

  it('vec3: bidder A, 2 ETH, nonce 1 (amount + nonce change)', () => {
    expect(computeCommitmentHash({ ...base, bidAmount: TWO_ETH, nonce: 1n })).toBe(
      '0x04045e5eb08db7b831e6d768985b9c910b4387301e11de4718d693e9b38e8db8',
    )
  })

  it('vecChain1: chainId 1 instead of 31337', () => {
    expect(computeCommitmentHash({ ...base, chainId: 1 })).toBe(
      '0x493591c75e9da6ab6f6c9e7d74d95e15613ded31f13d50eb11bacd39c46a729a',
    )
  })

  it('vecDead: different contract address', () => {
    expect(computeCommitmentHash({ ...base, contractAddress: DEAD_CONTRACT })).toBe(
      '0x04699bf34ffa07647a436ed7d58151eab5375436063d459cfa24b935a7a9bc6f',
    )
  })
})

describe('hash sensitivity (every field binds the commitment)', () => {
  const reference = computeCommitmentHash(base)

  it('changes when amount changes', () => {
    expect(computeCommitmentHash({ ...base, bidAmount: ONE_ETH + 1n })).not.toBe(reference)
    expect(computeCommitmentHash({ ...base, bidAmount: TWO_ETH })).not.toBe(reference)
  })

  it('changes when nonce changes', () => {
    expect(computeCommitmentHash({ ...base, nonce: 123456788n })).not.toBe(reference)
    expect(computeCommitmentHash({ ...base, nonce: 0n })).not.toBe(reference)
  })

  it('changes when bidder changes', () => {
    expect(computeCommitmentHash({ ...base, bidder: BIDDER_B })).not.toBe(reference)
  })

  it('changes when chainId changes', () => {
    expect(computeCommitmentHash({ ...base, chainId: 1 })).not.toBe(reference)
    expect(computeCommitmentHash({ ...base, chainId: 31338 })).not.toBe(reference)
  })

  it('changes when contract address changes', () => {
    expect(computeCommitmentHash({ ...base, contractAddress: DEAD_CONTRACT })).not.toBe(reference)
  })

  it('accepts chainId as bigint or number identically', () => {
    expect(computeCommitmentHash({ ...base, chainId: 31337n })).toBe(reference)
  })
})

describe('generateNonce (CSPRNG)', () => {
  it('returns distinct positive bigints', () => {
    const a = generateNonce()
    const b = generateNonce()
    expect(typeof a).toBe('bigint')
    expect(a > 0n).toBe(true)
    expect(b > 0n).toBe(true)
    expect(a).not.toBe(b)
  })

  it('uses crypto.getRandomValues, never Math.random', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    generateNonce()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
