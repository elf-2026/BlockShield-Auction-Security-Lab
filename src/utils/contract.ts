import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  isAddress,
  type Abi,
  type Address,
  type Hash,
  type WalletClient,
} from 'viem'
import auctionArtifact from '../CommitRevealAuction.json'

export const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) || 'http://127.0.0.1:8545'

/**
 * Resolve the expected chain id from VITE_CHAIN_ID, falling back to the
 * Anvil default (31337) when unset, blank, or malformed. Only plain decimal
 * integers are accepted (no hex '0x…', exponent, or float forms) and values
 * must be safe integers. Kept pure so the unit tests can pin the precedence
 * rules without touching import.meta.
 */
export const resolveChainId = (raw: string | undefined): number => {
  const s = (raw ?? '').trim()
  if (!/^\d+$/.test(s)) return 31337
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : 31337
}

export const CHAIN_ID = resolveChainId(import.meta.env.VITE_CHAIN_ID as string | undefined)

const envAddress = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined

/** True when a usable contract address came from the environment (dev.sh injects the fresh deployment). */
export const isContractConfigured = (): boolean => !!envAddress && isAddress(envAddress)

/** Zero address sentinel when nothing is configured — App must gate on isContractConfigured(). */
export const CONTRACT_ADDRESS = (
  isContractConfigured() ? (envAddress as Address) : '0x0000000000000000000000000000000000000000'
) as Address

export const anvilChain = defineChain({
  id: CHAIN_ID,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})

// experimental_blockTag 'pending' keeps reads consistent with execution: under
// automining, the 'latest' block only updates when a tx mines, so its
// timestamp (and thus the derived phase()) can lag wall-clock reality while
// eth_estimateGas and sends execute at the real pending time. That desync made
// the UI happily enable "Commit" while every commit tx reverted "Wrong phase".
export const publicClient = createPublicClient({
  chain: anvilChain,
  transport: http(RPC_URL),
  experimental_blockTag: 'pending',
})

interface ArtifactShape {
  abi: Abi
  bytecode: { object: string }
}

const artifact = auctionArtifact as unknown as ArtifactShape
export const abi = artifact.abi
export const creationBytecode = artifact.bytecode.object
export const address = CONTRACT_ADDRESS

export type AuctionWallet = WalletClient

/** On-chain snapshot consumed by the UI (single refresh). */
export interface AuctionSnapshot {
  phase: number
  commitDeadline: bigint
  revealDeadline: bigint
  seller: Address
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
}

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const

// Accounts returned by the local node are unlocked Anvil dev accounts; they
// sign via eth_sendTransaction, so no private key ever reaches the browser.
export const getUnlockedAccounts = (): Promise<Address[]> =>
  (publicClient.request as unknown as (args: { method: string }) => Promise<Address[]>)({
    method: 'eth_accounts',
  })

// ---------------------------------------------------------------------------
// Injected wallets (MetaMask & other EIP-1193 providers)
// ---------------------------------------------------------------------------

export type WalletMode = 'local' | 'injected'

export interface InjectedProvider {
  request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (payload: unknown) => void) => void
}

/** The page's EIP-1193 provider, if an extension wallet is present. */
export const getInjectedProvider = (): InjectedProvider | null => {
  const eth = (globalThis as { window?: { ethereum?: InjectedProvider } }).window?.ethereum
  return eth && typeof eth.request === 'function' ? eth : null
}

export const requestInjectedAccounts = async (provider: InjectedProvider): Promise<Address[]> =>
  (await provider.request({ method: 'eth_requestAccounts' })) as Address[]

export const injectedChainId = async (provider: InjectedProvider): Promise<number> => {
  const raw = (await provider.request({ method: 'eth_chainId' })) as string
  return Number(BigInt(raw))
}

/** Ask the wallet to switch to our configured chain (best effort — the user can reject). */
export const switchInjectedChain = async (provider: InjectedProvider, chainId: number) => {
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${chainId.toString(16)}` }],
  })
}

export const makeWalletClient = (account: Address, mode: WalletMode = 'local'): AuctionWallet => {
  if (mode === 'injected') {
    const provider = getInjectedProvider()
    if (!provider) throw new Error('No injected wallet available')
    return createWalletClient({
      account: { address: account, type: 'json-rpc' },
      chain: anvilChain,
      transport: custom(provider),
    })
  }
  return createWalletClient({
    account: { address: account, type: 'json-rpc' },
    chain: anvilChain,
    transport: http(RPC_URL),
  })
}

/**
 * Combine the two chain checks that gate transactions:
 *  - rpcOk:  the RPC node the UI READS from reports the expected chain, and
 *  - walletOk (injected mode only): the connected wallet is on the expected
 *    chain too — otherwise a read could show state that the wallet's tx
 *    would land on a different chain.
 * Unknown (null) is never optimistic: it blocks actions until both checks
 * return true, so gating never proceeds on partial information.
 */
export const combineChainOk = (
  mode: WalletMode,
  rpcOk: boolean | null,
  walletOk: boolean | null,
): boolean | null => {
  if (rpcOk === false || walletOk === false) return false
  if (mode === 'local') return rpcOk
  return rpcOk === true && walletOk === true ? true : null
}

export const readAuction = <T = unknown>(
  functionName: string,
  args?: readonly unknown[],
): Promise<T> =>
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
  value?: bigint,
): Promise<`0x${string}`> => {
  // Estimate with the typed contract path and send an explicit gas limit.
  // Relying on the node's eth_sendTransaction auto-estimation under-provides
  // gas on refund-heavy txs (anvil returns a post-refund number), which makes
  // reveal()/withdraw() revert with OutOfGas. A 50% + 21k buffer is safe and
  // does not change verification: the receipt status is still checked by the
  // caller. Estimation reverts (wrong phase, mismatched commitment, ...) are
  // surfaced here as pre-flight errors with their revert reason.
  const account = wallet.account?.address as Address
  const est = await publicClient.estimateContractGas({
    address,
    abi,
    functionName,
    args,
    account,
    ...(value !== undefined ? { value } : {}),
  } as Parameters<typeof publicClient.estimateContractGas>[0])
  const gas = est + est / 2n + 21_000n
  return wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    gas,
    ...(value !== undefined ? { value } : {}),
  } as Parameters<AuctionWallet['writeContract']>[0])
}

export const waitForTx = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash })

/** Check that real contract code exists at the configured address. */
export const hasContractCode = async (): Promise<boolean> => {
  const code = await publicClient.getCode({ address })
  return !!code && code !== '0x'
}

const asAddress = (value: unknown): Address => value as Address

/** Read the full auction snapshot (global + per-account) in parallel. */
export const fetchAuctionSnapshot = async (account?: Address): Promise<AuctionSnapshot> => {
  const globalReads = Promise.all([
    readAuction<number | bigint>('phase'),
    readAuction<bigint>('commitDeadline'),
    readAuction<bigint>('revealDeadline'),
    readAuction<Address>('seller'),
    readAuction<boolean>('settled'),
    readAuction<boolean>('canceled'),
    readAuction<bigint>('highestBid'),
    readAuction<Address>('highestBidder'),
    readAuction<bigint>('totalDeposits'),
    readAuction<bigint>('sellerProceeds'),
  ])
  const accountReads = account
    ? Promise.all([
        readAuction<Hash>('commitmentHash', [account]),
        readAuction<bigint>('bidderDeposits', [account]),
        readAuction<boolean>('revealed', [account]),
        readAuction<bigint>('withdrawable', [account]),
      ])
    : Promise.resolve([ZERO_HASH, 0n, false, 0n] as const)

  const [g, a] = await Promise.all([globalReads, accountReads])
  const [
    phaseRaw,
    commitDeadline,
    revealDeadline,
    seller,
    settled,
    canceled,
    highestBid,
    highestBidder,
    totalDeposits,
    sellerProceeds,
  ] = g
  const [commitment, deposit, revealed, withdrawable] = a

  return {
    phase: Number(phaseRaw),
    commitDeadline,
    revealDeadline,
    seller: asAddress(seller),
    settled,
    canceled,
    highestBid,
    highestBidder: asAddress(highestBidder),
    totalDeposits,
    sellerProceeds,
    myCommitment: commitment === ZERO_HASH ? null : commitment,
    myDeposit: deposit,
    myRevealed: revealed,
    myWithdrawable: withdrawable,
  }
}

export type ClassifiedErrorKind =
  'rejected' | 'wrong-chain' | 'no-code' | 'revert' | 'rpc' | 'unknown'

export interface ClassifiedError {
  kind: ClassifiedErrorKind
  message: string
}

/** Map viem/RPC failures to actionable user-facing messages. */
export const classifyError = (err: unknown): ClassifiedError => {
  const e = err as {
    name?: string
    shortMessage?: string
    message?: string
    cause?: { name?: string; shortMessage?: string; message?: string; data?: unknown }
    details?: string
  }
  const name = e?.name || ''
  const causeName = e?.cause?.name || ''
  const raw =
    e?.cause?.shortMessage ||
    e?.shortMessage ||
    e?.cause?.message ||
    e?.message ||
    e?.details ||
    String(err)

  if (
    name === 'UserRejectedRequestError' ||
    causeName === 'UserRejectedRequestError' ||
    /user rejected/i.test(raw)
  ) {
    return { kind: 'rejected', message: 'Transaction rejected in the wallet' }
  }
  if (/chain( id)? (mismatch|does not match)/i.test(raw) || /expected chain/i.test(raw)) {
    return { kind: 'wrong-chain', message: `Wrong chain: expected chain ID ${CHAIN_ID}` }
  }
  if (
    name === 'ContractFunctionExecutionError' &&
    /code/i.test(raw) &&
    /not found|empty/i.test(raw)
  ) {
    return {
      kind: 'no-code',
      message: 'No contract code at the configured address — redeploy with npm run dev:local',
    }
  }
  if (
    name === 'ContractFunctionRevertedError' ||
    /reverted|Wrong phase|Active commitment|Bid must equal|Nothing to withdraw|Seller only/i.test(
      raw,
    )
  ) {
    const reason = (e?.cause as { reason?: string } | undefined)?.reason
    return {
      kind: 'revert',
      message: reason ? `Contract reverted: ${reason}` : `Contract reverted: ${raw}`,
    }
  }
  if (/fetch|ECONNREFUSED|network|socket/i.test(raw)) {
    return { kind: 'rpc', message: `RPC unreachable at ${RPC_URL} — is Anvil running?` }
  }
  return { kind: 'unknown', message: raw }
}

export const errorMessage = (err: unknown): string => classifyError(err).message
