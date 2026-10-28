import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Abi,
  type Address,
  type WalletClient,
} from 'viem'
import auctionAbiJson from '../CommitRevealAuction.json'

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) || 'http://127.0.0.1:8545'
export const CHAIN_ID = 31337
export const CONTRACT_ADDRESS =
  (import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined) || '0xd65FA34582D6e0e030A6523a309E5E8DE3839aC1'

export const anvilChain = defineChain({
  id: CHAIN_ID,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})

export const publicClient = createPublicClient({
  chain: anvilChain,
  transport: http(RPC_URL),
})

export const abi = auctionAbiJson as unknown as Abi
export const address = CONTRACT_ADDRESS as Address

export type AuctionWallet = WalletClient

// Accounts returned by the local node are unlocked (Anvil dev accounts)
// or impersonated (seller) - they sign via eth_sendTransaction, so no
// private key ever reaches the browser.
export const getUnlockedAccounts = (): Promise<Address[]> =>
  (
    publicClient.request as unknown as (args: { method: string }) => Promise<Address[]>
  )({ method: 'eth_accounts' })

export const makeWalletClient = (account: Address): AuctionWallet =>
  createWalletClient({
    account: { address: account, type: 'json-rpc' },
    chain: anvilChain,
    transport: http(RPC_URL),
  })

export const readAuction = <T = unknown>(functionName: string, args?: readonly unknown[]): Promise<T> =>
  publicClient.readContract({
    address,
    abi,
    functionName,
    args,
  }) as Promise<T>

export const writeAuction = async (
  wallet: AuctionWallet,
  functionName: string,
  args: readonly unknown[] = [],
  value?: bigint
): Promise<`0x${string}`> =>
  wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    ...(value !== undefined ? { value } : {}),
  } as Parameters<AuctionWallet['writeContract']>[0])
