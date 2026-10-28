import React, { useCallback, useEffect, useState } from 'react'
import { formatEther, parseEther, type Address } from 'viem'
import './index.css'
import { useAuctionStore } from './utils/store'
import {
  CHAIN_ID,
  CONTRACT_ADDRESS,
  RPC_URL,
  getUnlockedAccounts,
  makeWalletClient,
  publicClient,
  readAuction,
  writeAuction,
} from './utils/contract'

function stateName(state: number): string {
  switch (state) {
    case 0: return 'Created'
    case 1: return 'Commitment'
    case 2: return 'Reveal'
    case 3: return 'Settling'
    case 4: return 'Settled'
    default: return 'Unknown'
  }
}

const errorText = (err: unknown): string => {
  const e = err as { shortMessage?: string; message?: string }
  return e?.shortMessage || e?.message || String(err)
}

const inputVal = (id: string): string =>
  (document.getElementById(id) as HTMLInputElement | null)?.value || ''

function App() {
  const store = useAuctionStore()
  const { account, connected, networkId, state, minBid, revealDeadline, highestBid,
    highestBidder, bidderDeposit, auctionIdCounter, seller, updateState } = store

  const [accounts, setAccounts] = useState<Address[]>([])
  const [balance, setBalance] = useState<bigint>(0n)
  const [chainOk, setChainOk] = useState<boolean | null>(null)
  const [, setTick] = useState(0)
  const [busy, setBusy] = useState(false)

  const now = Math.floor(Date.now() / 1000)
  const deadline = Number(revealDeadline)
  const beforeDeadline = deadline > 0 && now < deadline
  const afterDeadline = deadline > 0 && now >= deadline
  const isSeller = !!account && !!seller && account.toLowerCase() === seller.toLowerCase()

  const refresh = useCallback(async () => {
    try {
      const [stateRaw, minBidV, deadlineV, highestV, highestAddr, counterV, sellerAddr] =
        await Promise.all([
          readAuction<number | bigint>('state'),
          readAuction<bigint>('minBid'),
          readAuction<bigint>('revealDeadline'),
          readAuction<bigint>('highestBid'),
          readAuction<Address>('highestBidder'),
          readAuction<bigint>('auctionIdCounter'),
          readAuction<Address>('seller'),
        ])
      const deposit = account
        ? await readAuction<bigint>('bidderDeposits', [account])
        : 0n
      updateState({
        state: Number(stateRaw),
        minBid: minBidV,
        revealDeadline: deadlineV,
        highestBid: highestV,
        highestBidder: highestAddr,
        auctionIdCounter: counterV,
        seller: sellerAddr,
        bidderDeposit: deposit,
      })
    } catch (err) {
      console.error('Failed to read contract state:', err)
    }
  }, [account, updateState])

  // Load unlocked local accounts, verify chain, read contract state
  useEffect(() => {
    ;(async () => {
      try {
        const [list, chainId] = await Promise.all([
          getUnlockedAccounts(),
          publicClient.getChainId(),
        ])
        setAccounts(list)
        setChainOk(chainId === CHAIN_ID)
        updateState({ networkId: chainId })
      } catch (err) {
        console.error('Failed to reach local RPC:', err)
        setChainOk(false)
      }
      await refresh()
    })()
  }, [refresh, updateState])

  // Balance for the connected account
  useEffect(() => {
    if (!account) {
      setBalance(0n)
      return
    }
    publicClient
      .getBalance({ address: account as Address })
      .then(setBalance)
      .catch(() => setBalance(0n))
  }, [account, connected])

  // Re-render every second so deadline-based controls appear on time
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const connectWallet = async (address: Address) => {
    try {
      updateState({ account: address, connected: true, networkId: CHAIN_ID })
      await refresh()
    } catch (err) {
      alert(`Wallet connection failed: ${errorText(err)}`)
    }
  }

  const disconnectWallet = () => {
    updateState({
      account: undefined,
      connected: false,
      networkId: undefined,
      bidderDeposit: 0n,
    })
  }

  const requireSetup = (): boolean => {
    if (!connected || !account) {
      alert('Please connect a wallet first')
      return false
    }
    if (chainOk === false) {
      alert(`Wrong chain: expected ${CHAIN_ID} (Anvil)`)
      return false
    }
    return true
  }

  const afterTx = async () => {
    await refresh()
    if (account) {
      const bal = await publicClient.getBalance({ address: account as Address }).catch(() => 0n)
      setBalance(bal)
    }
  }

  const handleCreateAuction = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!requireSetup() || !isSeller) return
    const minutes = Math.max(1, Number(inputVal('create-deadline')) || 10)
    const deadlineTs = BigInt(now + minutes * 60)
    setBusy(true)
    try {
      const wallet = makeWalletClient(account as Address)
      const tx = await writeAuction(wallet, 'createAuction', [deadlineTs])
      await publicClient.waitForTransactionReceipt({ hash: tx })
      await afterTx()
      alert(`Auction created! Deadline in ${minutes} minutes (${new Date(Number(deadlineTs) * 1000).toLocaleString()})`)
    } catch (err) {
      alert(`Create auction failed: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleCommitBid = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!requireSetup()) return
    let bidAmount: bigint
    try {
      bidAmount = parseEther(inputVal('bid-amount') || '0')
    } catch {
      alert('Invalid bid amount')
      return
    }
    const nonce = Number(inputVal('commit-nonce')) || 0
    if (bidAmount <= 0n) {
      alert('Bid amount must be greater than 0')
      return
    }
    if (nonce <= 0) {
      alert('Nonce must be a non-zero number')
      return
    }
    const auctionId = Number(auctionIdCounter)
    setBusy(true)
    try {
      const wallet = makeWalletClient(account as Address)
      const tx = await writeAuction(wallet, 'commit', [BigInt(auctionId), bidAmount, BigInt(nonce)], bidAmount)
      await publicClient.waitForTransactionReceipt({ hash: tx })
      await afterTx()
      alert(`Bid committed! Auction #${auctionId}, bid ${formatEther(bidAmount)} ETH, nonce ${nonce}. Keep these for the reveal.`)
    } catch (err) {
      alert(`Commit bid failed: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRevealBid = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!requireSetup()) return
    let bidAmount: bigint
    try {
      bidAmount = parseEther(inputVal('reveal-bid-amount') || '0')
    } catch {
      alert('Invalid bid amount')
      return
    }
    const nonce = Number(inputVal('reveal-nonce')) || 0
    if (bidAmount <= 0n || nonce <= 0) {
      alert('Enter the exact bid amount and nonce you committed with')
      return
    }
    const auctionId = Number(auctionIdCounter)
    setBusy(true)
    try {
      const wallet = makeWalletClient(account as Address)
      const tx = await writeAuction(wallet, 'reveal', [BigInt(auctionId), bidAmount, BigInt(nonce)])
      await publicClient.waitForTransactionReceipt({ hash: tx })
      await afterTx()
      alert(`Bid revealed! ${formatEther(bidAmount)} ETH (nonce ${nonce})`)
    } catch (err) {
      alert(`Reveal bid failed: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSettle = async () => {
    if (!requireSetup()) return
    setBusy(true)
    try {
      const wallet = makeWalletClient(account as Address)
      const tx = await writeAuction(wallet, 'settle')
      await publicClient.waitForTransactionReceipt({ hash: tx })
      await afterTx()
      alert('Auction settled!')
    } catch (err) {
      alert(`Settle failed: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRefund = async () => {
    if (!requireSetup()) return
    setBusy(true)
    try {
      const wallet = makeWalletClient(account as Address)
      const tx = await writeAuction(wallet, 'refund')
      await publicClient.waitForTransactionReceipt({ hash: tx })
      await afterTx()
      alert('Refund received!')
    } catch (err) {
      alert(`Refund failed: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    if (!requireSetup()) return
    setBusy(true)
    try {
      const wallet = makeWalletClient(account as Address)
      const tx = await writeAuction(wallet, 'cancel')
      await publicClient.waitForTransactionReceipt({ hash: tx })
      await afterTx()
      alert('Auction cancelled')
    } catch (err) {
      alert(`Cancel failed: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const accountLabel = (addr: Address, index: number): string => {
    if (seller && addr.toLowerCase() === seller.toLowerCase()) return 'Seller (deployer)'
    return `Local account ${index + 1}`
  }

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-100 p-4 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-bold mb-2">BlockShield: Auction Security Lab</h1>
        <p className="text-sm">Commit-Reveal Auction Protocol Demonstration</p>
      </header>

      {chainOk === false && (
        <div className="bg-red-100 border border-red-400 text-red-700 rounded p-3 mb-4">
          Not connected to local Anvil (expected chain ID {CHAIN_ID} at {RPC_URL}).
        </div>
      )}

      {/* Connection panel */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
        <h2 className="text-xl font-bold mb-4">Connection</h2>
        <div className="space-y-3 text-sm">
          <p>Chain: <code>{networkId ? `#${networkId}` : '—'}</code> {chainOk === true && '(Anvil ✓)'}</p>
          <p>RPC: <code>{RPC_URL}</code></p>
          <p>Contract: <code className="break-all">{CONTRACT_ADDRESS}</code></p>
          {seller && <p>Seller: <code>{seller}</code></p>}

          {accounts.length > 0 && (
            <div className="flex gap-2 items-center flex-wrap">
              <select
                id="account-select"
                className="border rounded p-2 bg-white text-gray-800"
                defaultValue=""
              >
                <option value="" disabled>Select a local account…</option>
                {accounts.map((addr, i) => (
                  <option key={addr} value={addr}>{accountLabel(addr, i)} — {addr.slice(0, 8)}…</option>
                ))}
              </select>
              <button
                onClick={() => {
                  const sel = document.getElementById('account-select') as HTMLSelectElement | null
                  if (sel?.value) connectWallet(sel.value as Address)
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Connect
              </button>
              <button
                onClick={disconnectWallet}
                className="px-4 py-2 bg-gray-400 text-white rounded hover:bg-gray-500"
                disabled={!connected}
              >
                Disconnect
              </button>
            </div>
          )}
          {accounts.length === 0 && (
            <p className="text-orange-600">No unlocked accounts found on {RPC_URL}. Is Anvil running?</p>
          )}

          {connected && account && (
            <div className="border-t pt-2 mt-2 space-y-1">
              <p>Account: <code className="break-all">{account}</code></p>
              <p>Role: <strong>{isSeller ? 'Seller' : 'Bidder'}</strong></p>
              <p>Balance: {formatEther(balance)} ETH</p>
            </div>
          )}
        </div>
      </div>

      {/* Auction state display */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
        <h2 className="text-xl font-bold mb-4">Auction State</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p>State: <span className="font-mono">{stateName(state)}</span> ({state})</p>
            <p>Auction #: <span className="font-mono">{auctionIdCounter.toString()}</span></p>
            <p>Min Bid: <span className="font-mono">{formatEther(minBid)} ETH</span></p>
            <p>Reveal Deadline:{' '}
              <span className="font-mono">
                {deadline ? new Date(deadline * 1000).toLocaleString() : 'pending'}
              </span>
              {deadline > 0 && (beforeDeadline ? ' (open)' : ' (passed)')}
            </p>
          </div>
          <div>
            <p>Highest Bid: <span className="font-mono">{formatEther(highestBid)} ETH</span></p>
            <p>Highest Bidder: <span className="font-mono break-all">{highestBidder}</span></p>
            <p>Your Deposit: <span className="font-mono">{formatEther(bidderDeposit)} ETH</span></p>
          </div>
        </div>
      </div>

      {/* Creation form (seller only) */}
      {connected && isSeller && state === 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-4">Create Auction (Seller)</h2>
          <form onSubmit={handleCreateAuction} className="space-y-3">
            <div>
              <label htmlFor="create-deadline" className="block text-sm mb-2">
                Reveal deadline (minutes from now)
              </label>
              <input
                type="number"
                id="create-deadline"
                min="1"
                defaultValue={10}
                className="w-full p-2 border rounded text-gray-800"
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                Bids must be committed and revealed before this timestamp.
              </p>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
            >
              Create Auction
            </button>
          </form>
        </div>
      )}

      {/* Bid commitment form (bidder) */}
      {connected && (state === 0 || state === 1) && beforeDeadline && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-4">Commit Bid {isSeller ? '(you are the seller — bids are allowed)' : '(Bidder)'}</h2>
          <form onSubmit={handleCommitBid} className="space-y-3">
            <div>
              <label htmlFor="bid-amount" className="block text-sm mb-2">Bid Amount (ETH)</label>
              <input
                type="number"
                step="0.0001"
                min="0"
                id="bid-amount"
                className="w-full p-2 border rounded text-gray-800"
                required
              />
            </div>
            <div>
              <label htmlFor="commit-nonce" className="block text-sm mb-2">Nonce (secret random number)</label>
              <input
                type="number"
                min="1"
                id="commit-nonce"
                defaultValue={Math.floor(Math.random() * 1_000_000) + 1}
                className="w-full p-2 border rounded text-gray-800"
                required
              />
              <p className="text-xs text-gray-500">
                Unique per bid. You will need the exact nonce (and amount) when revealing.
              </p>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              Commit Bid
            </button>
          </form>
        </div>
      )}

      {/* Bid reveal form (bidder) */}
      {connected && (state === 1 || state === 2) && beforeDeadline && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-4">Reveal Bid (Bidder)</h2>
          <form onSubmit={handleRevealBid} className="space-y-3">
            <div>
              <label htmlFor="reveal-bid-amount" className="block text-sm mb-2">Bid Amount (ETH)</label>
              <input
                type="number"
                step="0.0001"
                min="0"
                id="reveal-bid-amount"
                className="w-full p-2 border rounded text-gray-800"
                required
              />
            </div>
            <div>
              <label htmlFor="reveal-nonce" className="block text-sm mb-2">Nonce</label>
              <input
                type="number"
                min="1"
                id="reveal-nonce"
                className="w-full p-2 border rounded text-gray-800"
                required
              />
              <p className="text-xs text-gray-500">Must match the values used when committing.</p>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
            >
              Reveal Bid
            </button>
          </form>
        </div>
      )}

      {/* Pre-deadline controls */}
      {connected && beforeDeadline && (state === 0 || state === 1) && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-2">Auction Controls</h2>
          <button
            onClick={handleCancel}
            disabled={busy}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50"
          >
            Cancel Auction
          </button>
          <p className="text-xs text-gray-500 mt-2">
            Cancelling refunds your deposit and settles the auction as unsuccessful.
          </p>
        </div>
      )}

      {/* Settlement controls */}
      {connected && state === 2 && afterDeadline && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-4">Settlement Controls</h2>
          <p className="text-sm mb-3">Reveal deadline passed — ready to settle.</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handleSettle}
              disabled={busy}
              className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
            >
              Settle Auction
            </button>
            {bidderDeposit > 0n && account !== highestBidder && (
              <button
                onClick={handleRefund}
                disabled={busy}
                className="px-4 py-2 bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
              >
                Refund Bid
              </button>
            )}
          </div>
          <p className="text-xs text-orange-600 mt-3">
            Known contract issue: settle() also requires block.number &gt;= revealDeadline (a
            timestamp), which can never hold on a local chain — expect it to revert with
            "Deadline not reached". Commit/reveal flows are unaffected.
          </p>
        </div>
      )}

      {/* Refund after deadline (even if settle impossible) */}
      {connected && afterDeadline && state !== 4 && bidderDeposit > 0n && !(state === 2 && afterDeadline) && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-2">Refund</h2>
          <button
            onClick={handleRefund}
            disabled={busy}
            className="px-4 py-2 bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
          >
            Claim Refund ({formatEther(bidderDeposit)} ETH)
          </button>
        </div>
      )}

      {/* Post-settlement results */}
      {state === 4 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-6 shadow">
          <h2 className="text-xl font-bold mb-4">Auction Results</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p>Winner: <span className="font-mono break-all">{highestBidder}</span></p>
              <p>Winning Bid: <span className="font-mono">{formatEther(highestBid)} ETH</span></p>
            </div>
            <div>
              <p>Seller: <span className="font-mono break-all">{seller || '—'}</span></p>
              <p>Settlement: <span className="font-mono">Completed</span></p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
