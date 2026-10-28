/**
 * Live-chain integration check — runs only against a fresh local deployment:
 *
 *   INTEGRATION_RPC_URL=http://127.0.0.1:8545 \
 *   INTEGRATION_CONTRACT=0x... \
 *   npx vitest run src/integration
 *
 * Verifies:
 *   1. frontend computeCommitmentHash == on-chain computeCommitmentHash
 *   2. commit/reveal/refund/settle/withdraw succeed with the exact V2
 *      signatures through the same viem writeContract path the app uses
 */
import { describe, expect, it } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hash,
} from 'viem'
import { abi, creationBytecode } from '../utils/contract'
import { computeCommitmentHash, generateNonce } from '../utils/commitment'

const RPC_URL = process.env.INTEGRATION_RPC_URL
const CONTRACT = process.env.INTEGRATION_CONTRACT as Address | undefined
const enabled = !!(RPC_URL && CONTRACT && isAddress(CONTRACT))

const chain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL || 'http://127.0.0.1:8545'] } },
})

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) })
const wallet = (account: Address) =>
  createWalletClient({
    account: { address: account, type: 'json-rpc' },
    chain,
    transport: http(RPC_URL),
  })

const SELLER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
const BIDDER1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const BIDDER2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address

const read = <T>(functionName: string, args?: readonly unknown[]): Promise<T> =>
  publicClient.readContract({ address: CONTRACT as Address, abi, functionName, args }) as Promise<T>

const warpTo = async (timestamp: bigint | number) => {
  await publicClient.request({
    method: 'evm_setNextBlockTimestamp',
    params: [typeof timestamp === 'bigint' ? timestamp : BigInt(timestamp)],
  } as never)
  await publicClient.request({ method: 'evm_mine', params: [] } as never)
}

/** Deploy a fresh instance so each lifecycle test starts at phase 0. */
async function deployInstance(commitDuration: bigint, revealDuration: bigint) {
  const deployHash = (await wallet(SELLER).deployContract({
    abi,
    bytecode: creationBytecode as `0x${string}`,
    args: [commitDuration, revealDuration],
  })) as Hash
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error('integration deploy failed')
  }
  const addr = receipt.contractAddress
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    publicClient.readContract({ address: addr, abi, functionName, args }) as Promise<T>
  const send = async (
    account: Address,
    functionName: string,
    args: readonly unknown[] = [],
    value?: bigint,
  ) => {
    // Mirror the app's write path: typed gas estimate + explicit buffer
    // (Anvil's eth_sendTransaction auto-estimation under-provides gas when
    // SSTORE refunds are in play, which OOGs reveal/withdraw).
    const est = await publicClient.estimateContractGas({
      address: addr,
      abi,
      functionName,
      args,
      account,
      ...(value !== undefined ? { value } : {}),
    } as never)
    const h = await wallet(account).writeContract({
      address: addr,
      abi,
      functionName,
      args,
      gas: est + est / 2n + 21_000n,
      ...(value !== undefined ? { value } : {}),
    } as never)
    const r = await publicClient.waitForTransactionReceipt({ hash: h })
    if (r.status !== 'success') {
      throw new Error(`tx ${functionName} reverted (${h})`)
    }
    return r
  }
  return { addr, read, send }
}

describe.runIf(enabled)('live integration vs deployed CommitRevealAuction', () => {
  it('frontend hash matches computeCommitmentHash() on-chain for multiple inputs', async () => {
    const cases = [
      { bidder: BIDDER1, bidAmount: parseEther('1'), nonce: generateNonce() },
      { bidder: BIDDER2, bidAmount: parseEther('0.5'), nonce: generateNonce() },
      { bidder: SELLER, bidAmount: parseEther('2.25'), nonce: 1n },
    ]
    for (const c of cases) {
      const local = computeCommitmentHash({
        ...c,
        chainId: 31337,
        contractAddress: CONTRACT as Address,
      })
      const onchain = await read<Hash>('computeCommitmentHash', [c.bidder, c.bidAmount, c.nonce])
      expect(onchain).toBe(local)
    }
  }, 30_000)

  it('full lifecycle: commit -> early refund -> reveal -> settle -> withdraw', async () => {
    const { addr, read: readI, send: sendI } = await deployInstance(60n, 60n)

    const phase0 = Number(await readI<bigint>('phase'))
    expect(phase0).toBe(0)

    const nonce1 = generateNonce()
    const nonce2 = generateNonce()
    const bid1 = parseEther('1')
    const bid2 = parseEther('2')

    const hash1 = computeCommitmentHash({
      bidder: BIDDER1,
      bidAmount: bid1,
      nonce: nonce1,
      chainId: 31337,
      contractAddress: addr,
    })
    const hash2 = computeCommitmentHash({
      bidder: BIDDER2,
      bidAmount: bid2,
      nonce: nonce2,
      chainId: 31337,
      contractAddress: addr,
    })

    // 1. both commit with the exact V2 signature: commit(bytes32) payable
    await sendI(BIDDER1, 'commit', [hash1], bid1)
    await sendI(BIDDER2, 'commit', [hash2], bid2)
    expect(await readI<Hash>('commitmentHash', [BIDDER1])).toBe(hash1)
    expect(await readI<bigint>('totalDeposits')).toBe(bid1 + bid2)

    // 2. bidder2 changes mind: early refund during commit phase
    await sendI(BIDDER2, 'refund')
    expect(await readI<Hash>('commitmentHash', [BIDDER2])).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(await readI<bigint>('bidderDeposits', [BIDDER2])).toBe(0n)
    expect(await readI<bigint>('totalDeposits')).toBe(bid1)

    // 3. re-commit with a fresh secret
    const nonce2b = generateNonce()
    const hash2b = computeCommitmentHash({
      bidder: BIDDER2,
      bidAmount: bid2,
      nonce: nonce2b,
      chainId: 31337,
      contractAddress: addr,
    })
    await sendI(BIDDER2, 'commit', [hash2b], bid2)

    // 4. enter reveal phase
    const commitDeadline = await readI<bigint>('commitDeadline')
    await warpTo(commitDeadline + 1n)
    expect(Number(await readI<bigint>('phase'))).toBe(1)

    // 5. reveal(uint256,uint256) — escrow must equal bid
    await sendI(BIDDER1, 'reveal', [bid1, nonce1])
    await sendI(BIDDER2, 'reveal', [bid2, nonce2b])
    expect(await readI<boolean>('revealed', [BIDDER1])).toBe(true)
    expect(await readI<Address>('highestBidder')).toBe(BIDDER2)
    expect(await readI<bigint>('highestBid')).toBe(bid2)

    // 6. settle phase
    const revealDeadline = await readI<bigint>('revealDeadline')
    await warpTo(revealDeadline + 1n)
    expect(Number(await readI<bigint>('phase'))).toBe(2)
    await sendI(SELLER, 'settle')
    expect(await readI<boolean>('settled')).toBe(true)
    expect(await readI<bigint>('sellerProceeds')).toBe(bid2)

    // 7. pull-based withdrawals; contract must end exactly empty (no forced ETH here)
    expect(await readI<bigint>('withdrawable', [BIDDER1])).toBe(bid1) // loser refund
    expect(await readI<bigint>('withdrawable', [BIDDER2])).toBe(0n) // winner: escrow == bid
    expect(await readI<bigint>('withdrawable', [SELLER])).toBe(bid2)

    await sendI(BIDDER1, 'withdraw')
    await sendI(SELLER, 'withdraw')
    expect(await publicClient.getBalance({ address: addr })).toBe(0n)
    expect(await readI<bigint>('totalDeposits')).toBe(0n)
  }, 60_000)

  it('seller-as-bidder withdraws escrow and proceeds in one call', async () => {
    const { addr, read: readI, send: sendI } = await deployInstance(60n, 60n)

    // Seller bids on their own auction.
    const bid = parseEther('1')
    const nonce = generateNonce()
    const commitment = computeCommitmentHash({
      bidder: SELLER,
      bidAmount: bid,
      nonce,
      chainId: 31337,
      contractAddress: addr,
    })
    expect(await readI<Hash>('computeCommitmentHash', [SELLER, bid, nonce])).toBe(commitment)
    await sendI(SELLER, 'commit', [commitment], bid)

    await warpTo((await readI<bigint>('commitDeadline')) + 1n)
    await sendI(SELLER, 'reveal', [bid, nonce])

    await warpTo((await readI<bigint>('revealDeadline')) + 1n)
    await sendI(SELLER, 'settle')

    // Seller's claim = sellerProceeds (their own winning bid), escrow bucket is 0.
    const claim = await readI<bigint>('withdrawable', [SELLER])
    expect(claim).toBe(bid)
    const before = await publicClient.getBalance({ address: SELLER })
    await sendI(SELLER, 'withdraw')
    const after = await publicClient.getBalance({ address: SELLER })
    expect(after > before).toBe(true)
    expect(await publicClient.getBalance({ address: addr })).toBe(0n)
  }, 60_000)
})
