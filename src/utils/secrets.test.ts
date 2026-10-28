import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hash } from 'viem'
import { computeCommitmentHash, generateNonce } from './commitment'
import {
  ALLOWED_SECRET_FIELDS,
  deleteBidSecrets,
  exportBidSecretsJson,
  loadBidSecrets,
  saveBidSecrets,
  secretsKey,
} from './secrets'

const CHAIN = 31337
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address
const BIDDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
const OTHER_BIDDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const OTHER_CHAIN = 1
const OTHER_CONTRACT = '0x000000000000000000000000000000000000dEaD' as Address

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

const sampleInput = () => {
  const nonce = 42n
  const bidAmountWei = 10n ** 18n
  return {
    bidder: BIDDER,
    chainId: CHAIN,
    contract: CONTRACT,
    bidAmountWei,
    nonce,
    commitmentHash: computeCommitmentHash({
      bidder: BIDDER,
      bidAmount: bidAmountWei,
      nonce,
      chainId: CHAIN,
      contractAddress: CONTRACT,
    }),
  }
}

describe('save/load roundtrip', () => {
  it('persists and restores the exact bid secrets', () => {
    const input = sampleInput()
    saveBidSecrets(input)
    const loaded = loadBidSecrets(CHAIN, CONTRACT, BIDDER)
    expect(loaded).not.toBeNull()
    expect(loaded?.bidAmountWei).toBe(input.bidAmountWei.toString())
    expect(loaded?.nonce).toBe('42')
    expect(loaded?.commitmentHash).toBe(input.commitmentHash)
    expect(loaded?.bidder.toLowerCase()).toBe(BIDDER.toLowerCase())
    expect(loaded?.chainId).toBe(CHAIN)
    expect(loaded?.contract.toLowerCase()).toBe(CONTRACT.toLowerCase())
  })

  it('returns null when nothing is saved', () => {
    expect(loadBidSecrets(CHAIN, CONTRACT, BIDDER)).toBeNull()
  })
})

describe('scoping: exact bidder + chain + contract only', () => {
  it('scopes the storage key to all three components', () => {
    expect(secretsKey(CHAIN, CONTRACT, BIDDER)).not.toBe(secretsKey(CHAIN, CONTRACT, OTHER_BIDDER))
    expect(secretsKey(CHAIN, CONTRACT, BIDDER)).not.toBe(secretsKey(OTHER_CHAIN, CONTRACT, BIDDER))
    expect(secretsKey(CHAIN, CONTRACT, BIDDER)).not.toBe(secretsKey(CHAIN, OTHER_CONTRACT, BIDDER))
  })

  it('address case does not leak across scopes (case-insensitive match)', () => {
    saveBidSecrets(sampleInput())
    const upper = CONTRACT.toUpperCase().replace('0X', '0x') as Address
    expect(loadBidSecrets(CHAIN, upper, BIDDER)).not.toBeNull()
  })

  it('does not return a record for a different bidder', () => {
    saveBidSecrets(sampleInput())
    expect(loadBidSecrets(CHAIN, CONTRACT, OTHER_BIDDER)).toBeNull()
  })

  it('does not return a record for a different chain id', () => {
    saveBidSecrets(sampleInput())
    expect(loadBidSecrets(OTHER_CHAIN, CONTRACT, BIDDER)).toBeNull()
  })

  it('does not return a record for a different contract (redeployed instance)', () => {
    saveBidSecrets(sampleInput())
    expect(loadBidSecrets(CHAIN, OTHER_CONTRACT, BIDDER)).toBeNull()
  })

  it('deletion only removes the exact scope', () => {
    saveBidSecrets(sampleInput())
    saveBidSecrets({ ...sampleInput(), bidder: OTHER_BIDDER })
    deleteBidSecrets(CHAIN, CONTRACT, BIDDER)
    expect(loadBidSecrets(CHAIN, CONTRACT, BIDDER)).toBeNull()
    expect(loadBidSecrets(CHAIN, CONTRACT, OTHER_BIDDER)).not.toBeNull()
  })
})

describe('backup export safety', () => {
  it('exports JSON containing only allowed reveal-material fields (no key material)', () => {
    saveBidSecrets(sampleInput())
    const loaded = loadBidSecrets(CHAIN, CONTRACT, BIDDER)
    expect(loaded).not.toBeNull()
    const parsed = JSON.parse(exportBidSecretsJson(loaded as NonNullable<typeof loaded>)) as Record<
      string,
      unknown
    >
    expect(Object.keys(parsed).sort()).toEqual([...ALLOWED_SECRET_FIELDS].sort())
    for (const banned of ['privateKey', 'private_key', 'seed', 'mnemonic', 'secretKey']) {
      expect(Object.keys(parsed)).not.toContain(banned)
    }
  })

  it('round-trips through export JSON with all values intact', () => {
    const input = sampleInput()
    saveBidSecrets(input)
    const exported = exportBidSecretsJson(loadBidSecrets(CHAIN, CONTRACT, BIDDER) as never)
    const restored = JSON.parse(exported) as { bidAmountWei: string; nonce: string }
    expect(BigInt(restored.bidAmountWei)).toBe(input.bidAmountWei)
    expect(BigInt(restored.nonce)).toBe(input.nonce)
  })
})

describe('corrupt or tampered records are rejected', () => {
  it('rejects non-JSON payloads', () => {
    localStorage.setItem(secretsKey(CHAIN, CONTRACT, BIDDER), '{nope')
    expect(loadBidSecrets(CHAIN, CONTRACT, BIDDER)).toBeNull()
  })

  it('rejects records missing required fields', () => {
    localStorage.setItem(
      secretsKey(CHAIN, CONTRACT, BIDDER),
      JSON.stringify({ version: 1, bidder: BIDDER }),
    )
    expect(loadBidSecrets(CHAIN, CONTRACT, BIDDER)).toBeNull()
  })

  it('rejects records whose scope fields were tampered', () => {
    const record = {
      ...sampleInput(),
      bidAmountWei: '1',
      nonce: '1',
      commitmentHash: '0x' + '11'.repeat(32),
    }
    saveBidSecrets(record as never)
    const raw = JSON.parse(
      localStorage.getItem(secretsKey(CHAIN, CONTRACT, BIDDER)) as string,
    ) as Record<string, unknown>
    raw.contract = OTHER_CONTRACT
    localStorage.setItem(secretsKey(CHAIN, CONTRACT, BIDDER), JSON.stringify(raw))
    expect(loadBidSecrets(CHAIN, CONTRACT, BIDDER)).toBeNull()
  })
})

describe('nonce generation is cryptographic', () => {
  it('produces unique bigints within uint256', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 32; i++) {
      const n = generateNonce()
      expect(n > 0n).toBe(true)
      expect(n < 2n ** 256n).toBe(true)
      seen.add(n.toString())
    }
    expect(seen.size).toBe(32)
  })

  it('stored secrets always carry a commitment hash of the right shape', () => {
    saveBidSecrets(sampleInput())
    const loaded = loadBidSecrets(CHAIN, CONTRACT, BIDDER)
    expect(loaded?.commitmentHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
    const asHash = loaded?.commitmentHash as Hash
    expect(asHash.length).toBe(66)
  })
})
