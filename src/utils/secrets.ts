import { isAddress, isHex, type Address, type Hash } from 'viem'

/**
 * Local persistence for sealed-bid secrets (bid amount, nonce, hash).
 * Scoped to the exact (chainId, contract, bidder) triple so a record saved
 * for one deployment/account can never silently apply to another.
 *
 * NEVER store private keys or seed phrases here — only reveal-material.
 */

export interface SavedBidSecrets {
  version: 1
  bidder: Address
  chainId: number
  contract: Address
  /** decimal wei string (bigint is not JSON-safe) */
  bidAmountWei: string
  /** decimal string */
  nonce: string
  commitmentHash: Hash
  savedAt: number
}

const PREFIX = 'blockshield.bid.v1'

export const secretsKey = (chainId: number, contract: Address, bidder: Address): string =>
  `${PREFIX}:${chainId}:${contract.toLowerCase()}:${bidder.toLowerCase()}`

function storage(): Storage {
  const s = globalThis.localStorage
  if (!s) throw new Error('localStorage is unavailable in this environment')
  return s
}

export interface SaveBidInput {
  bidder: Address
  chainId: number
  contract: Address
  bidAmountWei: bigint
  nonce: bigint
  commitmentHash: Hash
}

export function saveBidSecrets(input: SaveBidInput): SavedBidSecrets {
  const record: SavedBidSecrets = {
    version: 1,
    bidder: input.bidder,
    chainId: input.chainId,
    contract: input.contract,
    bidAmountWei: input.bidAmountWei.toString(),
    nonce: input.nonce.toString(),
    commitmentHash: input.commitmentHash,
    savedAt: Date.now(),
  }
  storage().setItem(secretsKey(input.chainId, input.contract, input.bidder), JSON.stringify(record))
  return record
}

function isValidRecord(value: unknown): value is SavedBidSecrets {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    r.version === 1 &&
    typeof r.bidder === 'string' &&
    isAddress(r.bidder) &&
    typeof r.chainId === 'number' &&
    Number.isInteger(r.chainId) &&
    typeof r.contract === 'string' &&
    isAddress(r.contract) &&
    typeof r.bidAmountWei === 'string' &&
    /^\d+$/.test(r.bidAmountWei) &&
    typeof r.nonce === 'string' &&
    /^\d+$/.test(r.nonce) &&
    typeof r.commitmentHash === 'string' &&
    isHex(r.commitmentHash) &&
    r.commitmentHash.length === 66 &&
    typeof r.savedAt === 'number'
  )
}

/**
 * Load secrets for the exact scope. Returns null when nothing is saved, the
 * record is corrupt, or the stored scope fields do not match the request
 * (e.g. after a redeploy to the same address pattern or an account switch).
 */
export function loadBidSecrets(
  chainId: number,
  contract: Address,
  bidder: Address,
): SavedBidSecrets | null {
  let raw: string | null
  try {
    raw = storage().getItem(secretsKey(chainId, contract, bidder))
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isValidRecord(parsed)) return null
  if (
    parsed.chainId !== chainId ||
    parsed.contract.toLowerCase() !== contract.toLowerCase() ||
    parsed.bidder.toLowerCase() !== bidder.toLowerCase()
  ) {
    return null
  }
  return parsed
}

export function deleteBidSecrets(chainId: number, contract: Address, bidder: Address): void {
  try {
    storage().removeItem(secretsKey(chainId, contract, bidder))
  } catch {
    /* ignore */
  }
}

/** Pretty JSON for clipboard/file backup. */
export function exportBidSecretsJson(record: SavedBidSecrets): string {
  return JSON.stringify(record, null, 2)
}

/** The only keys a backup may ever contain — used by tests to enforce scope. */
export const ALLOWED_SECRET_FIELDS = [
  'version',
  'bidder',
  'chainId',
  'contract',
  'bidAmountWei',
  'nonce',
  'commitmentHash',
  'savedAt',
] as const
