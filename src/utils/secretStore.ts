import { useSyncExternalStore } from 'react'
import type { Address } from 'viem'
import { loadBidSecrets, secretsKey, type SavedBidSecrets } from './secrets'

/**
 * React view over localStorage bid secrets via useSyncExternalStore, so the
 * UI never has to mirror storage into useState with a set-state-in-effect
 * cascade. save/delete call bumpSecretStore(); cross-tab updates arrive via
 * the storage event. getSnapshot returns a cached record keyed by storage
 * key + version, so React's identity check stays stable.
 */

let version = 0
const listeners = new Set<() => void>()

export function bumpSecretStore(): void {
  version += 1
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith('blockshield.bid')) cb()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

let cache: { key: string; version: number; record: SavedBidSecrets | null } | null = null

function getSnapshotFor(
  chainId: number,
  contract: Address,
  bidder: Address,
): SavedBidSecrets | null {
  const key = secretsKey(chainId, contract, bidder)
  if (cache && cache.key === key && cache.version === version) return cache.record
  const record = loadBidSecrets(chainId, contract, bidder)
  cache = { key, version, record }
  return record
}

/** Returns the saved secrets for this exact scope, or null (reactive). */
export function useSavedBidSecrets(
  chainId: number,
  contract: Address,
  bidder: Address | undefined,
): SavedBidSecrets | null {
  return useSyncExternalStore(
    subscribe,
    () => (bidder ? getSnapshotFor(chainId, contract, bidder) : null),
    () => null,
  )
}
