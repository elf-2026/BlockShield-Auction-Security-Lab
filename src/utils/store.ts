import { useSyncExternalStore } from 'react'
import type { Address, Hash } from 'viem'

export interface AuctionStateValues {
  account: Address | undefined
  connected: boolean
  networkId: number | undefined
  /** null = RPC unreachable / not yet checked */
  chainOk: boolean | null
  /** null = not yet checked */
  hasCode: boolean | null
  phase: number
  commitDeadline: bigint
  revealDeadline: bigint
  seller: Address | undefined
  settled: boolean
  canceled: boolean
  highestBid: bigint
  highestBidder: Address
  totalDeposits: bigint
  sellerProceeds: bigint
  myCommitment: Hash | null
  myDeposit: bigint
  myRevealed: boolean
  myWithdrawable: bigint
  readError: string | undefined
}

export interface AuctionStore extends AuctionStateValues {
  updateState: (partial: Partial<AuctionStateValues>) => void
  reset: () => void
}

const defaults: AuctionStateValues = {
  account: undefined,
  connected: false,
  networkId: undefined,
  chainOk: null,
  hasCode: null,
  phase: 0,
  commitDeadline: 0n,
  revealDeadline: 0n,
  seller: undefined,
  settled: false,
  canceled: false,
  highestBid: 0n,
  highestBidder: '0x0000000000000000000000000000000000000000',
  totalDeposits: 0n,
  sellerProceeds: 0n,
  myCommitment: null,
  myDeposit: 0n,
  myRevealed: false,
  myWithdrawable: 0n,
  readError: undefined,
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
