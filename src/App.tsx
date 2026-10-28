import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodeEventLog, formatEther, parseEther, type Address, type Hash } from 'viem'
import './index.css'
import { useAuctionStore } from './utils/store'
import {
  CHAIN_ID,
  CONTRACT_ADDRESS,
  RPC_URL,
  abi,
  classifyError,
  combineChainOk,
  errorMessage,
  fetchAuctionSnapshot,
  getInjectedProvider,
  getUnlockedAccounts,
  hasContractCode,
  injectedChainId,
  isContractConfigured,
  makeWalletClient,
  publicClient,
  requestInjectedAccounts,
  switchInjectedChain,
  waitForTx,
  writeAuction,
  type WalletMode,
} from './utils/contract'
import { computeCommitmentHash, generateNonce } from './utils/commitment'
import { deleteBidSecrets, exportBidSecretsJson, saveBidSecrets } from './utils/secrets'
import {
  PHASE_REVEAL,
  gateCancel,
  gateCommit,
  gateRefund,
  gateReveal,
  gateSettle,
  gateWithdraw,
  phaseName,
  type ActionContext,
} from './utils/gating'
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Field,
  HexChip,
  StatCard,
  ToastStack,
  inputCls,
  type Toast,
} from './components/ui'
import {
  ActivityFeed,
  Countdown,
  PhaseStepper,
  SecurityLab,
  type FeedEvent,
} from './components/panels'
import { useNowTick, nextToastId } from './utils/hooks'
import { fmtEth } from './utils/format'
import { bumpSecretStore, useSavedBidSecrets } from './utils/secretStore'

type Status = { kind: 'ok' | 'error'; text: string } | null

const MAX_UINT256 = 2n ** 256n - 1n
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address

const NAV = [
  { href: '#overview', label: 'Overview' },
  { href: '#lifecycle', label: 'Lifecycle' },
  { href: '#activity', label: 'Activity' },
  { href: '#lab', label: 'Security Lab' },
]

function useTheme(): ['light' | 'dark', () => void] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved =
      typeof localStorage !== 'undefined' ? localStorage.getItem('blockshield.theme') : null
    if (saved === 'dark' || saved === 'light') return saved
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('blockshield.theme', theme)
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}

const ShieldMark = () => (
  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow">
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M12 2l8 3.5v5.1c0 5-3.4 9.5-8 11.4-4.6-1.9-8-6.4-8-11.4v-5.1L12 2zm0 4.2L7.5 8v2.6c0 3.4 1.8 6.6 4.5 8.3 2.7-1.7 4.5-4.9 4.5-8.3V8L12 6.2zm1.8 3.9l1.6 1.6-4 4-2.8-2.8 1.6-1.6 1.2 1.2 2.4-2.4z" />
    </svg>
  </span>
)

function App() {
  const store = useAuctionStore()
  const {
    account,
    connected,
    networkId,
    chainOk,
    hasCode,
    phase,
    commitDeadline,
    revealDeadline,
    seller,
    settled,
    canceled,
    highestBid,
    highestBidder,
    totalDeposits,
    sellerProceeds,
    myCommitment,
    myDeposit,
    myRevealed,
    myWithdrawable,
    readError,
    updateState,
  } = store

  const configured = isContractConfigured()
  const [theme, toggleTheme] = useTheme()
  const [accounts, setAccounts] = useState<Address[]>([])
  const [balance, setBalance] = useState<bigint>(0n)
  const [contractBalance, setContractBalance] = useState<bigint>(0n)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const now = useNowTick()
  const pendingSeq = useRef(0)

  // Injected wallet (MetaMask et al.). The local Anvil dropdown remains the
  // default; the extension button only appears when window.ethereum exists.
  const injectedProvider = useMemo(() => getInjectedProvider(), [])
  const [walletMode, setWalletMode] = useState<WalletMode>('local')
  const [walletChainOk, setWalletChainOk] = useState<boolean | null>(null)
  const [walletChainId, setWalletChainId] = useState<number | null>(null)

  const walletFor = useCallback((addr: Address) => makeWalletClient(addr, walletMode), [walletMode])

  const [bidAmountInput, setBidAmountInput] = useState('')
  const [generatedNonce, setGeneratedNonce] = useState<bigint>(() => generateNonce())
  const [revealAmountInput, setRevealAmountInput] = useState('')
  const [revealNonceInput, setRevealNonceInput] = useState('')
  // false: reveal inputs follow the saved secret (during reveal phase);
  // true: the user typed their own values. Reset on account/flow changes.
  const [revealTouched, setRevealTouched] = useState(false)
  const savedSecrets = useSavedBidSecrets(
    CHAIN_ID,
    CONTRACT_ADDRESS,
    configured ? account : undefined,
  )

  const isSeller = !!account && !!seller && account.toLowerCase() === seller.toLowerCase()

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = nextToastId()
    setToasts((t) => [...t.slice(-2), { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
  }, [])

  // Optimistic pending event until the chain scan confirms it (same tx hash id).
  const addPending = useCallback((e: Omit<FeedEvent, 'id' | 'ts'>) => {
    const key = `pending-${++pendingSeq.current}`
    setEvents((prev) => [...prev, { ...e, id: key, ts: Math.floor(Date.now() / 1000) }])
    return key
  }, [])

  const ctx: ActionContext = {
    phase,
    connected,
    chainOk: combineChainOk(walletMode, chainOk, walletChainOk),
    hasCode,
    settled,
    canceled,
    commitmentActive: myCommitment !== null,
    revealed: myRevealed,
    withdrawable: myWithdrawable,
    balance,
    isSeller,
    expectedChainId: CHAIN_ID,
  }

  // ---- parsing ------------------------------------------------------------
  const parseEth = (value: string): bigint | null => {
    try {
      const v = parseEther(value || '0')
      return v >= 0n ? v : null
    } catch {
      return null
    }
  }
  const commitAmountWei = parseEth(bidAmountInput) ?? -1n
  // Prefill is DERIVED from the saved secret (not mirrored via effects):
  // active only while in the reveal phase and until the user edits a field.
  const prefillActive = !!savedSecrets && phase === PHASE_REVEAL && !myRevealed
  const revealAmountValue = revealTouched
    ? revealAmountInput
    : prefillActive && savedSecrets
      ? formatEther(BigInt(savedSecrets.bidAmountWei))
      : ''
  const revealNonceValue = revealTouched
    ? revealNonceInput
    : prefillActive && savedSecrets
      ? savedSecrets.nonce
      : ''
  const revealAmountWei = parseEth(revealAmountValue) ?? -1n
  const revealNonce: bigint | null = /^\d+$/.test(revealNonceValue.trim())
    ? (() => {
        const n = BigInt(revealNonceValue.trim())
        return n <= MAX_UINT256 ? n : null
      })()
    : null

  const previewHash: Hash | null = useMemo(() => {
    if (!account || commitAmountWei <= 0n) return null
    return computeCommitmentHash({
      bidder: account,
      bidAmount: commitAmountWei,
      nonce: generatedNonce,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
    })
  }, [account, commitAmountWei, generatedNonce])

  const revealHash: Hash | null = useMemo(() => {
    if (!account || revealAmountWei <= 0n || revealNonce === null) return null
    return computeCommitmentHash({
      bidder: account,
      bidAmount: revealAmountWei,
      nonce: revealNonce,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
    })
  }, [account, revealAmountWei, revealNonce])

  const hashMatchesStored = !!revealHash && !!myCommitment && revealHash === myCommitment
  const amountMatchesEscrow =
    revealAmountWei >= 0n && myDeposit > 0n && revealAmountWei === myDeposit

  const revealGate = gateReveal(ctx, {
    hashMatchesStored,
    amountMatchesEscrow,
    hasSavedSecrets: savedSecrets !== null,
  })
  const commitGate = gateCommit(ctx, commitAmountWei)
  const refundGate = gateRefund(ctx)
  const cancelGate = gateCancel(ctx)
  const settleGate = gateSettle(ctx)
  const withdrawGate = gateWithdraw(ctx)

  // ---- data loading -------------------------------------------------------
  const refreshBalance = useCallback(
    async (acct?: Address) => {
      const who = acct ?? account
      if (!who) {
        setBalance(0n)
        return
      }
      try {
        setBalance(await publicClient.getBalance({ address: who }))
      } catch {
        setBalance(0n)
      }
    },
    [account],
  )

  const refresh = useCallback(
    async (acct?: Address) => {
      if (!configured) return
      const who = acct ?? account
      try {
        const snap = await fetchAuctionSnapshot(who)
        updateState({ ...snap, readError: undefined })
        setContractBalance(await publicClient.getBalance({ address: CONTRACT_ADDRESS }))
      } catch (err) {
        const classified = classifyError(err)
        updateState({ readError: classified.message })
        console.error('Failed to read auction state:', err)
      }
    },
    [account, configured, updateState],
  )

  const scanEvents = useCallback(async () => {
    if (!configured) return
    try {
      const logs = await publicClient.getLogs({
        address: CONTRACT_ADDRESS,
        fromBlock: 'earliest',
        toBlock: 'latest',
      })
      const blocks = new Map<string, number>()
      const parsed: FeedEvent[] = []
      for (const log of logs) {
        const key = log.blockNumber.toString()
        let ts = blocks.get(key)
        if (ts === undefined) {
          const block = await publicClient.getBlock({ blockNumber: log.blockNumber })
          ts = Number(block.timestamp)
          blocks.set(key, ts)
        }
        let decoded: { eventName: string; args: Record<string, unknown> }
        try {
          decoded = decodeEventLog({
            abi,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          }) as unknown as { eventName: string; args: Record<string, unknown> }
        } catch {
          continue
        }
        const id = `${log.transactionHash ?? 'n'}-${log.logIndex ?? 0}`
        const a = decoded.args ?? {}
        switch (decoded.eventName) {
          case 'AuctionCreated':
            parsed.push({
              id,
              ts,
              kind: 'created',
              actor: a.seller as Address,
              note: `commit ${new Date(Number(a.commitDeadline) * 1000).toLocaleTimeString()} · reveal ${new Date(Number(a.revealDeadline) * 1000).toLocaleTimeString()}`,
            })
            break
          case 'BidCommitted':
            parsed.push({
              id,
              ts,
              kind: 'committed',
              actor: a.bidder as Address,
              note: 'sealed (escrowed)',
            })
            break
          case 'BidRevealed':
            parsed.push({
              id,
              ts,
              kind: 'revealed',
              actor: a.bidder as Address,
              amount: a.bidAmount as bigint,
            })
            break
          case 'AuctionSettled':
            parsed.push({
              id,
              ts,
              kind: 'settled',
              actor: a.winner as Address,
              amount: a.winningBid as bigint,
              note: a.hasWinner
                ? 'winner takes bid + forfeited escrow'
                : 'no bids revealed — full unwind',
            })
            break
          case 'AuctionCanceled':
            parsed.push({ id, ts, kind: 'canceled', note: 'bidders pull refunds via withdraw()' })
            break
          case 'BidRefunded':
            parsed.push({
              id,
              ts,
              kind: 'refunded',
              actor: a.bidder as Address,
              amount: a.amount as bigint,
            })
            break
          case 'Withdrawal':
            parsed.push({
              id,
              ts,
              kind: 'withdrawn',
              actor: a.account as Address,
              amount: a.amount as bigint,
            })
            break
        }
      }
      setEvents(parsed.slice(-40))
    } catch (err) {
      console.error('event scan failed:', err)
    }
  }, [configured])

  useEffect(() => {
    ;(async () => {
      if (!configured) {
        updateState({ chainOk: null, hasCode: null })
        return
      }
      try {
        const [list, chainId, code] = await Promise.all([
          getUnlockedAccounts(),
          publicClient.getChainId(),
          hasContractCode().catch(() => false),
        ])
        setAccounts(list)
        updateState({ networkId: chainId, chainOk: chainId === CHAIN_ID, hasCode: code })
      } catch (err) {
        console.error('Failed to reach local RPC:', err)
        updateState({ chainOk: false, hasCode: null, readError: classifyError(err).message })
      }
      await refresh()
      await refreshBalance()
      await scanEvents()
    })()
  }, [configured, refresh, refreshBalance, scanEvents, updateState])

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh()
      void refreshBalance()
      void scanEvents()
    }, 4000)
    return () => clearInterval(timer)
  }, [refresh, refreshBalance, scanEvents])

  // ---- actions ------------------------------------------------------------
  const runTx = async (
    send: () => Promise<Hash>,
    okText: string,
    feed: Omit<FeedEvent, 'id' | 'ts'>,
  ): Promise<boolean> => {
    setBusy(true)
    setStatus(null)
    let pendingKey: string | null = null
    try {
      const hash = await send()
      pendingKey = addPending({ ...feed, hash })
      const receipt = await waitForTx(hash)
      const success = receipt.status === 'success'
      if (!success) {
        setStatus({ kind: 'error', text: `Transaction reverted on-chain (${hash.slice(0, 14)}…).` })
        pushToast('error', 'Transaction reverted on-chain')
      } else {
        setStatus({ kind: 'ok', text: okText })
        pushToast('success', okText)
      }
      await refresh()
      await refreshBalance()
      await scanEvents()
      return success
    } catch (err) {
      setStatus({ kind: 'error', text: errorMessage(err) })
      pushToast('error', errorMessage(err))
      addPending({ kind: 'error', note: errorMessage(err) })
      return false
    } finally {
      if (pendingKey) setEvents((prev) => prev.filter((p) => p.id !== pendingKey))
      setBusy(false)
    }
  }

  const requireAccount = (): Address | null => {
    if (!account) {
      setStatus({ kind: 'error', text: 'Connect an account first' })
      return null
    }
    return account
  }

  const handleCommit = async (e: React.FormEvent) => {
    e.preventDefault()
    const bidder = requireAccount()
    if (!bidder) return
    if (!commitGate.allowed) {
      setStatus({ kind: 'error', text: commitGate.reason || 'Commit not allowed' })
      return
    }
    const hash = computeCommitmentHash({
      bidder,
      bidAmount: commitAmountWei,
      nonce: generatedNonce,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
    })
    const ok = await runTx(
      () => writeAuction(walletFor(bidder), 'commit', [hash], commitAmountWei),
      `Committed ${formatEther(commitAmountWei)} ETH sealed. Backup your nonce — losing it means the bid can never be revealed.`,
      { kind: 'committed', actor: bidder, note: 'sealed (escrowed)' },
    )
    if (ok) {
      try {
        saveBidSecrets({
          bidder,
          chainId: CHAIN_ID,
          contract: CONTRACT_ADDRESS,
          bidAmountWei: commitAmountWei,
          nonce: generatedNonce,
          commitmentHash: hash,
        })
        bumpSecretStore()
        setRevealTouched(false)
      } catch {
        setStatus({
          kind: 'error',
          text: 'Committed on-chain, but localStorage failed — copy the backup values now or the bid cannot be revealed.',
        })
      }
      setBidAmountInput('')
      setGeneratedNonce(generateNonce())
    }
  }

  const handleReveal = async (e: React.FormEvent) => {
    e.preventDefault()
    const bidder = requireAccount()
    if (!bidder) return
    if (revealAmountWei <= 0n || revealNonce === null) {
      setStatus({ kind: 'error', text: 'Enter a valid bid amount and nonce' })
      return
    }
    if (!revealGate.allowed) {
      setStatus({ kind: 'error', text: revealGate.reason || 'Reveal not allowed' })
      return
    }
    await runTx(
      () => writeAuction(walletFor(bidder), 'reveal', [revealAmountWei, revealNonce]),
      `Revealed ${formatEther(revealAmountWei)} ETH.`,
      { kind: 'revealed', actor: bidder, amount: revealAmountWei },
    )
  }

  const handleRefund = async () => {
    const bidder = requireAccount()
    if (!bidder) return
    if (!refundGate.allowed) {
      setStatus({ kind: 'error', text: refundGate.reason || 'Refund not allowed' })
      return
    }
    const amount = myDeposit
    await runTx(
      () => writeAuction(walletFor(bidder), 'refund'),
      `Refunded ${formatEther(amount)} ETH.`,
      { kind: 'refunded', actor: bidder, amount },
    )
    deleteBidSecrets(CHAIN_ID, CONTRACT_ADDRESS, bidder)
    bumpSecretStore()
    setRevealTouched(false)
    setRevealAmountInput('')
    setRevealNonceInput('')
  }

  const handleCancel = async () => {
    const bidder = requireAccount()
    if (!bidder) return
    if (!cancelGate.allowed) {
      setStatus({ kind: 'error', text: cancelGate.reason || 'Cancel not allowed' })
      return
    }
    if (
      !window.confirm(
        'Cancel this auction?\n\nNo funds move here. Every bidder (including you, if you also bid) must separately withdraw their escrow after cancellation.',
      )
    )
      return
    await runTx(
      () => writeAuction(walletFor(bidder), 'cancel'),
      'Auction cancelled. Bidders pull their refunds individually via Withdraw.',
      { kind: 'canceled', note: 'bidders pull refunds via withdraw()' },
    )
  }

  const handleSettle = async () => {
    const bidder = requireAccount()
    if (!bidder) return
    if (!settleGate.allowed) {
      setStatus({ kind: 'error', text: settleGate.reason || 'Settle not allowed' })
      return
    }
    await runTx(
      () => writeAuction(walletFor(bidder), 'settle'),
      highestBid > 0n
        ? `Settled — winner ${highestBidder.slice(0, 10)}… at ${formatEther(highestBid)} ETH. Proceeds and refunds are now claimable.`
        : 'Settled with no revealed bids — every escrow is now refundable.',
      { kind: 'settled', actor: highestBidder, amount: highestBid },
    )
  }

  const handleWithdraw = async () => {
    const bidder = requireAccount()
    if (!bidder) return
    if (!withdrawGate.allowed) {
      setStatus({ kind: 'error', text: withdrawGate.reason || 'Withdraw not allowed' })
      return
    }
    await runTx(
      () => writeAuction(walletFor(bidder), 'withdraw'),
      `Withdrew ${formatEther(myWithdrawable)} ETH.`,
      { kind: 'withdrawn', actor: bidder, amount: myWithdrawable },
    )
  }

  const backupJson = savedSecrets ? exportBidSecretsJson(savedSecrets) : null

  const handleCopyBackup = async () => {
    if (!backupJson) return
    try {
      await navigator.clipboard.writeText(backupJson)
      pushToast('success', 'Backup copied to clipboard.')
    } catch {
      pushToast('info', 'Clipboard unavailable — use the download button.')
    }
  }

  const handleDownloadBackup = () => {
    if (!backupJson || !account) return
    const blob = new Blob([backupJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `blockshield-bid-${CHAIN_ID}-${account.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const connectWallet = (addr: Address, mode: WalletMode = 'local') => {
    setWalletMode(mode)
    if (mode === 'local') {
      setWalletChainOk(null)
      setWalletChainId(null)
    }
    updateState({
      account: addr,
      connected: true,
      myCommitment: null,
      myDeposit: 0n,
      myRevealed: false,
      myWithdrawable: 0n,
    })
    setMenuOpen(false)
    setRevealTouched(false)
    setRevealAmountInput('')
    setRevealNonceInput('')
    // Pass the new address explicitly: the closure's `account` is still stale
    // this render, so refreshing without it left balance 0n until the next poll
    // and wrongly disabled Commit ("Insufficient balance").
    void refresh(addr)
    void refreshBalance(addr)
  }

  /** Injected wallet (MetaMask et al.): request accounts, verify chain, connect. */
  const connectInjected = async () => {
    if (!injectedProvider) return
    try {
      const list = await requestInjectedAccounts(injectedProvider)
      const cid = await injectedChainId(injectedProvider)
      setWalletChainId(cid)
      setWalletChainOk(cid === CHAIN_ID)
      if (list.length === 0) {
        setStatus({ kind: 'error', text: 'No accounts shared by the injected wallet' })
        return
      }
      connectWallet(list[0], 'injected')
      pushToast(
        'info',
        `Connected wallet on chain #${cid}${
          cid === CHAIN_ID ? '' : ` — WRONG chain, switch to ${CHAIN_ID}`
        }`,
      )
    } catch (err) {
      setStatus({ kind: 'error', text: errorMessage(err) })
    }
  }

  /** Re-check the wallet chain when MetaMask emits chainChanged. */
  useEffect(() => {
    if (!injectedProvider?.on) return
    const handler = (payload: unknown) => {
      const hex = typeof payload === 'string' ? payload : String(payload)
      try {
        const cid = Number(BigInt(hex))
        setWalletChainId(cid)
        setWalletChainOk(cid === CHAIN_ID)
      } catch {
        /* ignore malformed payloads */
      }
    }
    injectedProvider.on('chainChanged', handler)
    return () =>
      (injectedProvider as { removeListener?: (e: string, h: unknown) => void }).removeListener?.(
        'chainChanged',
        handler,
      )
  }, [injectedProvider])

  const disconnectWallet = () => {
    updateState({
      account: undefined,
      connected: false,
      myCommitment: null,
      myDeposit: 0n,
      myRevealed: false,
      myWithdrawable: 0n,
    })
    setBalance(0n)
    setRevealTouched(false)
    setWalletMode('local')
    setWalletChainOk(null)
    setWalletChainId(null)
  }

  // ---- derived display ----------------------------------------------------
  const effectiveChainOk = combineChainOk(walletMode, chainOk, walletChainOk)
  const liveSnapshot = configured && effectiveChainOk === true && hasCode === true && !readError
  const snapshotIssue = !configured
    ? 'No contract address configured. Start the stack with: npm run dev:local'
    : chainOk === false
      ? `Wrong chain: got ${networkId ?? 'unknown'}, expected ${CHAIN_ID}.`
      : effectiveChainOk === false
        ? `Wallet is on chain ${walletChainId ?? 'unknown'} — expected ${CHAIN_ID}. Switch the wallet network before acting.`
        : hasCode === false
          ? `No contract code at ${CONTRACT_ADDRESS}. The deployment is stale — re-run npm run dev:local.`
          : readError
            ? `Contract reads failed: ${readError}`
            : null

  const phaseTone = ['indigo', 'amber', 'purple', 'emerald'] as const

  return (
    <div
      className="min-h-screen bg-gray-100 text-gray-800 dark:bg-gray-950 dark:text-gray-100"
      data-testid="app"
    >
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/85 backdrop-blur dark:border-gray-800 dark:bg-gray-950/85">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-3 sm:px-6">
          <ShieldMark />
          <div className="min-w-0 flex-1">
            <h1 className="min-w-0 truncate text-base font-extrabold leading-tight sm:text-lg">
              BlockShield: Auction Security Lab
            </h1>
            <p className="hidden truncate text-[11px] text-gray-500 sm:block dark:text-gray-400">
              Sealed-bid commit–reveal auction · Security Lab
            </p>
          </div>
          {liveSnapshot && (
            <Badge tone={phaseTone[phase] ?? 'gray'} className="hidden sm:inline-flex">
              {phaseName(phase)} phase
            </Badge>
          )}
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 lg:inline-flex lg:min-h-[44px] lg:items-center dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {n.label}
              </a>
            ))}
          </nav>
          <button
            type="button"
            data-testid="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            type="button"
            data-testid="mobile-menu"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lg text-gray-500 hover:bg-gray-100 lg:hidden dark:text-gray-400 dark:hover:bg-gray-800"
          >
            ☰
          </button>
        </div>
        {menuOpen && (
          <nav
            className="border-t border-gray-200 px-4 py-2 lg:hidden dark:border-gray-800"
            aria-label="Mobile"
          >
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                onClick={() => setMenuOpen(false)}
                className="block min-h-[44px] rounded-lg px-3 py-3 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {n.label}
              </a>
            ))}
            <button
              type="button"
              onClick={toggleTheme}
              className="block min-h-[44px] w-full rounded-lg px-3 py-3 text-left text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Theme: {theme === 'dark' ? '☾ dark' : '☀ light'} — switch
            </button>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 sm:py-6">
        {status && (
          <div
            role="alert"
            data-testid="status-banner"
            className={`rounded-lg border px-4 py-3 text-sm ${
              status.kind === 'ok'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                : 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
            }`}
          >
            <span className="hex-break break-words">{status.text}</span>
          </div>
        )}

        {/* Connection */}
        <Card
          id="overview"
          title="Connection"
          subtitle={configured ? `Local lab · chain #${CHAIN_ID}` : 'No contract configured'}
          actions={
            liveSnapshot ? (
              <Badge tone="emerald">Chain #{networkId} ✓</Badge>
            ) : (
              <Badge tone="amber">not live</Badge>
            )
          }
        >
          {!liveSnapshot ? (
            <div
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
              data-testid="connection-problem"
              role="status"
            >
              <p className="font-semibold">Not showing live contract state</p>
              <p className="hex-break mt-1 break-words">{snapshotIssue}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div className="min-w-0">
                <p className="text-xs text-gray-500 dark:text-gray-400">RPC</p>
                <HexChip value={RPC_URL} />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-gray-500 dark:text-gray-400">Contract</p>
                <HexChip value={CONTRACT_ADDRESS} />
              </div>
              {seller && (
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Seller</p>
                  <HexChip value={seller} />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-xs text-gray-500 dark:text-gray-400">Account</p>
                {account ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    <HexChip value={account} />
                    <Badge tone={isSeller ? 'indigo' : 'gray'}>
                      {isSeller ? 'Seller' : 'Bidder'}
                    </Badge>
                  </span>
                ) : (
                  <span className="text-xs text-gray-500 dark:text-gray-400">not connected</span>
                )}
              </div>
              {account && (
                <p className="font-mono text-sm sm:col-span-2 xl:col-span-3">
                  Balance: {fmtEth(balance)}
                </p>
              )}
            </div>
          )}

          {(accounts.length > 0 || injectedProvider) && (
            <div className="mt-4 flex flex-col gap-2 border-t border-gray-100 pt-4 sm:flex-row dark:border-gray-800">
              {accounts.length > 0 && (
                <>
                  <label htmlFor="account-select" className="sr-only">
                    Select local account
                  </label>
                  <select
                    id="account-select"
                    className={inputCls}
                    defaultValue=""
                    onChange={(e) => e.target.value && connectWallet(e.target.value as Address)}
                  >
                    <option value="" disabled>
                      Connect a local account…
                    </option>
                    {accounts.map((addr, i) => (
                      <option key={addr} value={addr}>
                        {seller && addr.toLowerCase() === seller.toLowerCase()
                          ? 'Seller (deployer)'
                          : `Account ${i + 1}`}{' '}
                        — {addr.slice(0, 10)}…{addr.slice(-4)}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {injectedProvider && (
                <Button
                  tone="neutral"
                  onClick={connectInjected}
                  data-testid="connect-injected"
                  disabled={connected && walletMode === 'injected'}
                >
                  {walletMode === 'injected' && connected
                    ? `Wallet connected (#${walletChainId ?? '?'})`
                    : 'Connect browser wallet'}
                </Button>
              )}
              {connected && (
                <Button tone="neutral" onClick={disconnectWallet} data-testid="account-disconnect">
                  Disconnect
                </Button>
              )}
            </div>
          )}
          {accounts.length === 0 && !injectedProvider && configured && (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
              No unlocked accounts on {RPC_URL} and no injected wallet detected. Start Anvil with{' '}
              <code className="font-mono">npm run dev:local</code>.
            </p>
          )}
          {walletMode === 'injected' && walletChainOk === false && (
            <div className="mt-3">
              <Button
                tone="warn"
                onClick={() =>
                  injectedProvider &&
                  switchInjectedChain(injectedProvider, CHAIN_ID)
                    .then(() => {
                      setWalletChainOk(true)
                      setWalletChainId(CHAIN_ID)
                      pushToast('success', `Wallet switched to chain #${CHAIN_ID}.`)
                    })
                    .catch((err) => setStatus({ kind: 'error', text: errorMessage(err) }))
                }
                data-testid="switch-chain"
              >
                Switch wallet to chain #{CHAIN_ID}
              </Button>
            </div>
          )}
        </Card>

        {liveSnapshot && (
          <>
            {/* Lifecycle stepper */}
            <Card
              title="Auction lifecycle"
              subtitle={
                canceled
                  ? 'Canceled — withdrawals open'
                  : settled
                    ? 'Settled — withdrawals open'
                    : `Phase: ${phaseName(phase)}`
              }
            >
              <PhaseStepper
                phase={phase}
                commitDeadline={commitDeadline}
                revealDeadline={revealDeadline}
                settled={settled}
                canceled={canceled}
                now={now}
              />
            </Card>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" id="stats">
              <StatCard
                label="Phase"
                value={phaseName(phase)}
                sub={canceled ? 'canceled' : settled ? 'settled' : undefined}
                tone={settled || canceled ? 'good' : 'default'}
              />
              <StatCard
                label="Commit ends"
                value={<Countdown deadline={commitDeadline} now={now} />}
                sub={
                  commitDeadline > 0n
                    ? new Date(Number(commitDeadline) * 1000).toLocaleTimeString()
                    : '—'
                }
              />
              <StatCard
                label="Reveal ends"
                value={<Countdown deadline={revealDeadline} now={now} />}
                tone={
                  Number(revealDeadline) - now <= 60 && !settled && !canceled ? 'warn' : 'default'
                }
                sub={
                  revealDeadline > 0n
                    ? new Date(Number(revealDeadline) * 1000).toLocaleTimeString()
                    : '—'
                }
              />
              <StatCard
                label="Highest bid"
                value={highestBid > 0n ? formatEther(highestBid) : '—'}
                sub={
                  highestBidder !== ZERO_ADDR ? <HexChip value={highestBidder} /> : 'none revealed'
                }
              />
              <StatCard
                label="Total escrow"
                value={formatEther(totalDeposits)}
                sub={`contract holds ${formatEther(contractBalance)}`}
              />
              <StatCard
                label="Your claim"
                value={formatEther(myWithdrawable)}
                sub={
                  connected && account
                    ? myRevealed
                      ? 'revealed'
                      : myCommitment
                        ? 'committed · sealed'
                        : 'no active bid'
                    : 'connect an account'
                }
                tone={myWithdrawable > 0n ? 'good' : 'default'}
              />
            </div>

            {/* Actions + sidebar */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3" id="lifecycle">
              <div className="space-y-5 lg:col-span-2">
                {/* Commit */}
                <Card
                  title="1 · Commit bid"
                  subtitle="Only the hash + escrow go on-chain; the amount stays sealed"
                >
                  {myCommitment ? (
                    <div className="space-y-2 text-sm">
                      <p className="font-medium text-emerald-700 dark:text-emerald-300">
                        Active commitment on-chain (sealed).
                      </p>
                      <div className="flex flex-wrap items-center gap-1 text-xs">
                        Hash: <HexChip value={myCommitment} />
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-xs">
                        Escrow: <span className="font-mono">{fmtEth(myDeposit)}</span>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Duplicate commits are rejected by design — use Early refund (commit phase
                        only) and then commit again.
                      </p>
                    </div>
                  ) : (
                    <form onSubmit={handleCommit} className="grid grid-cols-1 gap-4">
                      <Field id="bid-amount" label="Bid amount (ETH)">
                        <input
                          id="bid-amount"
                          inputMode="decimal"
                          value={bidAmountInput}
                          onChange={(e) => setBidAmountInput(e.target.value)}
                          className={inputCls}
                          placeholder="1.0"
                        />
                      </Field>
                      <Field
                        id="bid-nonce"
                        label="Secret nonce (auto-generated)"
                        hint="From crypto.getRandomValues. WARNING: losing this nonce means the bid can never be revealed."
                      >
                        <div className="flex items-center gap-2">
                          <code
                            data-testid="nonce-display"
                            className="hex-break min-w-0 flex-1 rounded-lg bg-gray-100 px-3 py-2 text-xs dark:bg-gray-950"
                          >
                            {generatedNonce.toString()}
                          </code>
                          <CopyButton text={generatedNonce.toString()} label="" />
                          <Button
                            tone="neutral"
                            type="button"
                            onClick={() => setGeneratedNonce(generateNonce())}
                          >
                            ↻ New
                          </Button>
                        </div>
                      </Field>
                      {previewHash && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Commitment hash (V2 · chain #{CHAIN_ID} · this contract):{' '}
                          <span className="inline-block align-middle">
                            <HexChip value={previewHash} />
                          </span>
                        </p>
                      )}
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Button
                          type="submit"
                          tone="primary"
                          block
                          disabled={busy || !commitGate.allowed}
                          data-testid="action-commit"
                          title={commitGate.reason || undefined}
                        >
                          Commit{' '}
                          {commitAmountWei > 0n
                            ? `(${formatEther(commitAmountWei)} ETH escrow)`
                            : ''}
                        </Button>
                        {commitGate.reason && (
                          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                            {commitGate.reason}
                          </p>
                        )}
                      </div>
                    </form>
                  )}
                </Card>

                {/* Reveal */}
                <Card title="2 · Reveal bid" subtitle="Opens when the commit deadline passes">
                  {myRevealed ? (
                    <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                      Bid revealed: {fmtEth(myDeposit)}.
                    </p>
                  ) : (
                    <form onSubmit={handleReveal} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field
                        id="reveal-amount"
                        label="Bid amount (ETH)"
                        hint={
                          myDeposit > 0n
                            ? `must equal your escrow (${formatEther(myDeposit)})`
                            : 'the exact amount you committed'
                        }
                      >
                        <input
                          id="reveal-amount"
                          inputMode="decimal"
                          value={revealAmountValue}
                          onChange={(e) => {
                            setRevealTouched(true)
                            setRevealAmountInput(e.target.value)
                          }}
                          className={inputCls}
                          placeholder={myDeposit > 0n ? formatEther(myDeposit) : '1.0'}
                        />
                      </Field>
                      <Field
                        id="reveal-nonce"
                        label="Secret nonce"
                        hint="Prefilled from your local backup when available"
                      >
                        <input
                          id="reveal-nonce"
                          inputMode="numeric"
                          value={revealNonceValue}
                          onChange={(e) => {
                            setRevealTouched(true)
                            setRevealNonceInput(e.target.value)
                          }}
                          className={inputCls}
                        />
                      </Field>
                      {myCommitment && !myRevealed && (
                        <div className="flex flex-wrap items-center gap-2 text-xs sm:col-span-2">
                          {revealHash && (
                            <>
                              Recomputed: <HexChip value={revealHash} />{' '}
                              <Badge tone={hashMatchesStored ? 'emerald' : 'red'}>
                                {hashMatchesStored
                                  ? 'matches on-chain commitment'
                                  : 'does NOT match on-chain commitment'}
                              </Badge>
                            </>
                          )}
                          {myDeposit > 0n && revealAmountWei > 0n && (
                            <Badge tone={amountMatchesEscrow ? 'emerald' : 'amber'}>
                              {amountMatchesEscrow ? 'amount = escrow' : 'amount ≠ escrow'}
                            </Badge>
                          )}
                          {!revealHash && (
                            <span className="text-gray-500 dark:text-gray-400">
                              Enter your sealed amount + nonce (or restore the backup) to check
                              against the commitment.
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center">
                        <Button
                          type="submit"
                          tone="primary"
                          block
                          disabled={busy || !revealGate.allowed}
                          data-testid="action-reveal"
                          title={revealGate.reason || undefined}
                        >
                          Reveal Bid
                        </Button>
                        {revealGate.reason && (
                          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                            {revealGate.reason}
                          </p>
                        )}
                      </div>
                    </form>
                  )}
                  {backupJson && (
                    <div className="mt-4 space-y-2 border-t border-gray-100 pt-4 dark:border-gray-800">
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                        Backup warning: without this nonce + amount the escrow cannot be revealed
                        and forfeits at settlement.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          tone="neutral"
                          type="button"
                          onClick={handleCopyBackup}
                          data-testid="backup-copy"
                        >
                          Copy backup JSON
                        </Button>
                        <Button
                          tone="neutral"
                          type="button"
                          onClick={handleDownloadBackup}
                          data-testid="backup-download"
                        >
                          Download .json
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>

                {/* Phase controls */}
                <Card
                  title="3 · Phase controls"
                  subtitle="Refund · Settle · Cancel — each explains when it is unavailable"
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                      <p className="text-sm font-semibold">Early refund</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Commit phase only, for your active commitment ({fmtEth(myDeposit)}).
                      </p>
                      <Button
                        tone="neutral"
                        block
                        disabled={busy || !refundGate.allowed}
                        onClick={handleRefund}
                        data-testid="action-refund"
                        title={refundGate.reason || undefined}
                      >
                        Refund commitment
                      </Button>
                      {refundGate.reason && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {refundGate.reason}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                      <p className="text-sm font-semibold">Settle</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Crystallizes claims once the reveal deadline passes. No ETH moves.
                      </p>
                      <Button
                        tone="primary"
                        block
                        disabled={busy || !settleGate.allowed}
                        onClick={handleSettle}
                        data-testid="action-settle"
                        title={settleGate.reason || undefined}
                      >
                        Settle auction
                      </Button>
                      {settleGate.reason && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {settleGate.reason}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2 rounded-lg border border-gray-200 p-3 sm:col-span-2 dark:border-gray-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">Cancel auction</p>
                        {seller && !isSeller && (
                          <Badge tone="gray">seller-only · {seller.slice(0, 8)}…</Badge>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Seller-only, commit phase only. Cancel moves no funds: every bidder
                        (including a bidding seller) withdraws their refund individually afterwards.
                      </p>
                      <Button
                        tone="danger"
                        block
                        disabled={busy || !cancelGate.allowed}
                        onClick={handleCancel}
                        data-testid="action-cancel"
                        title={cancelGate.reason || undefined}
                      >
                        Cancel auction
                      </Button>
                      {cancelGate.reason && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {cancelGate.reason}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>

                {/* Withdraw */}
                <Card
                  title="4 · Withdraw"
                  subtitle="Pull-based payout after settle or cancel"
                  actions={
                    myWithdrawable > 0n ? (
                      <Badge tone="emerald">{fmtEth(myWithdrawable)} claimable</Badge>
                    ) : undefined
                  }
                >
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    Your claim via <code className="font-mono">withdrawable()</code>:{' '}
                    <span className="font-mono">{fmtEth(myWithdrawable)}</span>
                    {isSeller && settled && sellerProceeds > 0n && (
                      <>
                        {' '}
                        — includes seller proceeds {fmtEth(sellerProceeds)} (seller-as-bidder: one
                        call pays proceeds + surplus escrow).
                      </>
                    )}
                    {settled && highestBid === 0n && myDeposit > 0n && (
                      <> — zero-reveal settle: full unwind, your escrow is refundable.</>
                    )}
                  </p>
                  <div className="mt-3">
                    <Button
                      tone="success"
                      block
                      disabled={busy || !withdrawGate.allowed}
                      onClick={handleWithdraw}
                      data-testid="action-withdraw"
                      title={withdrawGate.reason || undefined}
                    >
                      Withdraw
                    </Button>
                    {withdrawGate.reason && (
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        {withdrawGate.reason}
                      </p>
                    )}
                  </div>
                </Card>
              </div>

              {/* Sidebar */}
              <div className="space-y-5">
                <div id="activity" className="scroll-mt-24">
                  <ActivityFeed events={events} />
                </div>
                <Card
                  title="My bid secrets"
                  subtitle="localStorage · scoped to chain · contract · account"
                >
                  {savedSecrets ? (
                    <ul className="space-y-2 font-mono text-xs" data-testid="secrets-panel">
                      <li className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-gray-500 dark:text-gray-400">amount</span>
                        <span>
                          {formatEther(BigInt(savedSecrets.bidAmountWei))}{' '}
                          <CopyButton text={savedSecrets.bidAmountWei} label="" />
                        </span>
                      </li>
                      <li className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-gray-500 dark:text-gray-400">nonce</span>
                        <span className="hex-break">
                          <span className="break-all">{savedSecrets.nonce}</span>{' '}
                          <CopyButton text={savedSecrets.nonce} label="" />
                        </span>
                      </li>
                      <li className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-gray-500 dark:text-gray-400">hash</span>
                        <HexChip value={savedSecrets.commitmentHash} />
                      </li>
                      <li className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-gray-500 dark:text-gray-400">scope</span>
                        <span>
                          #{savedSecrets.chainId} · {savedSecrets.contract.slice(0, 8)}… ·{' '}
                          {savedSecrets.bidder.slice(0, 8)}…
                        </span>
                      </li>
                      <li className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-gray-500 dark:text-gray-400">saved</span>
                        <span>{new Date(savedSecrets.savedAt).toLocaleString()}</span>
                      </li>
                    </ul>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      No saved secrets for this account + deployment. After committing, the bid
                      amount and nonce are stored here (never private keys).
                    </p>
                  )}
                </Card>
              </div>
            </div>

            <div id="lab" className="scroll-mt-24">
              <SecurityLab
                contractBalance={contractBalance}
                totalDeposits={totalDeposits}
                sellerProceeds={sellerProceeds}
                claimsLedger={[
                  { label: 'contract balance', value: contractBalance },
                  { label: 'totalDeposits', value: totalDeposits },
                  ...(account
                    ? [
                        { label: 'your escrow', value: myDeposit },
                        { label: 'your claim', value: myWithdrawable },
                      ]
                    : []),
                ]}
                now={now}
              />
            </div>

            {(settled || canceled) && (
              <div
                className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                data-testid="ended-banner"
              >
                <p className="font-semibold hex-break break-words">
                  {settled ? (
                    highestBid > 0n ? (
                      <>
                        Settled — winner{' '}
                        <span className="font-mono" data-testid="winner-address">
                          {highestBidder}
                        </span>{' '}
                        at {formatEther(highestBid)} ETH. Seller proceeds{' '}
                        {formatEther(sellerProceeds)}.
                      </>
                    ) : (
                      <>Settled — no bids revealed. Every escrow is refundable via withdraw().</>
                    )
                  ) : (
                    <>Auction canceled. Bidders withdraw their escrow individually.</>
                  )}
                </p>
              </div>
            )}
          </>
        )}
      </main>

      <ToastStack toasts={toasts} />
    </div>
  )
}

export default App
