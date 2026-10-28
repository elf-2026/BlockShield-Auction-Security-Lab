import { useSyncExternalStore } from 'react'

export interface AuctionStateValues {
  account: string | undefined
  connected: boolean
  networkId: number | undefined
  state: number
  minBid: bigint
  revealDeadline: bigint
  highestBid: bigint
  highestBidder: string
  bidderDeposit: bigint
  auctionIdCounter: bigint
  seller: string | undefined
}

export interface AuctionStore extends AuctionStateValues {
  updateState: (partial: Partial<AuctionStateValues>) => void
  reset: () => void
}

const defaults: AuctionStateValues = {
  account: undefined,
  connected: false,
  networkId: undefined,
  state: 0, // AuctionState.Created
  minBid: 0n,
  revealDeadline: 0n,
  highestBid: 0n,
  highestBidder: '0x0000000000000000000000000000000000000000',
  bidderDeposit: 0n,
  auctionIdCounter: 1n,
  seller: undefined,
}

const listeners = new Set<() => void>()

const updateState = (partial: Partial<AuctionStateValues>) => {
  snapshot = { ...snapshot, ...partial }
  listeners.forEach((listener) => listener())
}

const reset = () => updateState(defaults)

let snapshot: AuctionStore = { ...defaults, updateState, reset }

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => snapshot

export const useAuctionStore = (): AuctionStore =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
