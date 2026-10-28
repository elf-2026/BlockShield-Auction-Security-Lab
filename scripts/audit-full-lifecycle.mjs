// Full-lifecycle browser audit (Scope A): real Chromium drives the complete
// auction through the UI against a LIVE fresh deployment — two bidders commit,
// switch accounts (secrets stay scoped per chain·contract·account in
// localStorage), reveal with saved values auto-retrieved after the commit
// deadline, verify the winner, settle after the reveal deadline, withdraw
// every claim, and prove a repeated withdrawal is refused both by the UI
// (disabled with an explicit reason) and on-chain (a raw second withdraw tx
// reverts, receipt status 0x0).
//
// Preconditions (enforced with clear errors):
//   * fresh stack: npm run dev:local   (deployment in COMMIT phase)
//   * Vite at AUDIT_URL (default http://localhost:5173), Anvil at :8545
//
// This script warps chain time via evm_setNextBlockTimestamp so no wall-clock
// waiting is needed. That consumes the deployment's phases permanently — re-run
// npm run dev:local afterwards for a clean rehearsal or presentation.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.AUDIT_URL || 'http://localhost:5173'
const RPC = process.env.AUDIT_RPC || 'http://127.0.0.1:8545'
const OUT = process.env.AUDIT_OUT || path.join(ROOT, 'audit-artifacts')
mkdirSync(OUT, { recursive: true })

const failures = []
const checks = []
const ok = (name, detail = '') => {
  checks.push(name)
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
const fail = (msg) => {
  failures.push(msg)
  console.log(`  ✗ ${msg}`)
}

const envTxt = readFileSync(path.join(ROOT, '.env.local'), 'utf8')
const CONTRACT = envTxt.match(/VITE_CONTRACT_ADDRESS=(0x[0-9a-fA-F]{40})/)[1]
const EXPECTED_CHAIN = Number(envTxt.match(/VITE_CHAIN_ID=(\d+)/)?.[1] ?? 31337)

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

const art = JSON.parse(
  readFileSync(path.join(ROOT, 'out/CommitRevealAuction.sol/CommitRevealAuction.json'), 'utf8'),
)
const MID = art.methodIdentifiers
const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0')
const hexq = (n) => BigInt(n).toString(16).padStart(64, '0')
const numHex = (n) => '0x' + BigInt(n).toString(16)
// 'pending' block tag: under automining, 'latest' only advances when a tx
// mines, so its timestamp (and derived phase()) can lag wall-clock reality
// while execution runs at the real pending time — same desync this app
// fixed in src/utils/contract.ts (blockTag: 'pending').
const call = async (sig, ...hexArgs) =>
  rpc('eth_call', [{ to: CONTRACT, data: MID[sig] + hexArgs.join('') }, 'pending'])
const phaseNum = async () => Number(BigInt(await call('phase()')))
const boolLast = (v) => v.toLowerCase().endsWith('01')

async function warpTo(ts) {
  await rpc('evm_setNextBlockTimestamp', [numHex(ts)])
  await rpc('evm_mine', [])
}

async function receiptFor(hash, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const rec = await rpc('eth_getTransactionReceipt', [hash])
    if (rec) return rec
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

const ETH = 10n ** 18n
const B_A = (4n * ETH) / 10n // 0.4
const B_B = (9n * ETH) / 10n // 0.9

async function main() {
  console.log(`\n=== BlockShield full-lifecycle browser audit ===`)
  console.log(`app ${BASE} · rpc ${RPC} · contract ${CONTRACT}`)

  // ---- preconditions ------------------------------------------------------
  const chainId = Number(BigInt(await rpc('eth_chainId')))
  if (chainId !== EXPECTED_CHAIN) {
    fail(`chain id ${chainId} != expected ${EXPECTED_CHAIN}`)
    return
  }
  const code = await rpc('eth_getCode', [CONTRACT, 'latest'])
  if (!code || code === '0x') {
    fail(`no code at ${CONTRACT} — run: npm run dev:local`)
    return
  }
  const ph0 = await phaseNum()
  if (ph0 !== 0) {
    fail(
      `auction not in commit phase (phase=${ph0}) — this audit needs a FRESH deployment: npm run dev:local`,
    )
    return
  }
  ok('preconditions: fresh deployment in commit phase')

  const accounts = await rpc('eth_accounts')
  const [SELLER, A, B] = accounts
  const commitDL = Number(BigInt(await call('commitDeadline()')))
  const revealDL = Number(BigInt(await call('revealDeadline()')))

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('#account-select', { timeout: 15000 })

  // status banner persists across actions — wait for its TEXT to change and
  // match, instead of poking React-owned DOM directly
  const bannerText = async () =>
    (await page.textContent('[data-testid="status-banner"]').catch(() => null)) || ''
  const waitBanner = async (pattern, before, label) => {
    try {
      await page.waitForFunction(
        ([re, prev]) => {
          const el = document.querySelector('[data-testid="status-banner"]')
          const t = el ? el.textContent || '' : ''
          return t !== prev && new RegExp(re).test(t)
        },
        [pattern, before],
        { timeout: 30000 },
      )
      return null
    } catch {
      return `${label}: banner did not update to /${pattern}/ — now="${await bannerText()}" before="${before}"`
    }
  }
  const bal = async (addr) => BigInt(await rpc('eth_getBalance', [addr, 'pending']))
  const pollBal = async (addr, predicate, timeoutMs = 20000) => {
    const t0 = Date.now()
    for (;;) {
      const b = await bal(addr)
      if (predicate(b)) return b
      if (Date.now() - t0 > timeoutMs) return b
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  // option order: [0 placeholder, 1 seller, 2 account1, 3 account2]
  const selectAcct = async (index) => {
    await page.selectOption('#account-select', { index })
    await page.waitForTimeout(4500) // App refresh interval is 4s — let one full poll land
  }

  // ---- 1. two bidders commit (sealed escrow, CSPRNG nonce shown by UI) ----
  const commitAs = async (index, amount, who) => {
    await selectAcct(index)
    await page.fill('#bid-amount', amount)
    await page.waitForTimeout(300)
    const nonce = ((await page.textContent('[data-testid="nonce-display"]')) || '').trim()
    if (!/^\d+$/.test(nonce)) {
      fail(`${who}: nonce display missing/invalid`)
      return null
    }
    const btn = page.getByTestId('action-commit')
    if (await btn.isDisabled()) {
      fail(`${who}: commit disabled (${await btn.getAttribute('title')})`)
      return null
    }
    const before = await bannerText()
    await btn.click()
    const err = await waitBanner('Committed', before, `${who} commit`)
    if (err) {
      fail(`${err} chainPhase=${await phaseNum()}`)
      return null
    }
    ok(`${who} committed ${amount} ETH sealed`)
    const addr = who === 'A' ? A : B
    const stored = await call('commitmentHash(address)', pad(addr))
    if (BigInt(stored) === 0n) fail(`${who}: no commitment hash stored on-chain`)
    else ok(`${who}: commitment hash stored on-chain`)
    return nonce
  }

  const nonceA = await commitAs(2, '0.4', 'A')
  const nonceB = await commitAs(3, '0.9', 'B')
  if (!nonceA || !nonceB) {
    await browser.close()
    return
  }

  // account-switch secret isolation: connected as B, A's nonce must not prefill
  const prefillAsB = ((await page.inputValue('#reveal-nonce').catch(() => '')) || '').trim()
  if (prefillAsB && prefillAsB === String(nonceA))
    fail('B sees A’s saved nonce (secret leak across accounts)')
  else ok('account switch does not expose the other bidder’s saved secret')

  // ---- 2. warp past commit deadline -> reveal phase, both reveal ----------
  console.log('\n-- warping past commit deadline --')
  await warpTo(commitDL + 2)
  await page.waitForTimeout(5000)
  if ((await phaseNum()) !== 1) fail('expected phase 1 (reveal) after warp')
  else ok('phase advanced to Reveal (chain confirms)')

  const revealAs = async (index, addr, who, amount, nonce) => {
    await selectAcct(index)
    // saved secret must auto-retrieve into the reveal inputs
    const preAmt = ((await page.inputValue('#reveal-amount')) || '').trim()
    const preNon = ((await page.inputValue('#reveal-nonce')) || '').trim()
    if (preAmt !== amount) fail(`${who}: reveal amount prefill "${preAmt}" != "${amount}"`)
    else if (preNon !== String(nonce))
      fail(`${who}: reveal nonce prefill "${preNon}" != saved "${nonce}"`)
    else ok(`${who}: saved bid amount + nonce auto-retrieved from localStorage`)
    const btn = page.getByTestId('action-reveal')
    if (await btn.isDisabled()) {
      fail(`${who}: reveal disabled (${await btn.getAttribute('title')})`)
      return
    }
    const beforeR = await bannerText()
    await btn.click()
    const errR = await waitBanner('Revealed', beforeR, `${who} reveal`)
    if (errR) fail(errR)
    else ok(`${who} revealed ${amount} ETH`)
    const rev = await call('revealed(address)', pad(addr))
    if (!boolLast(rev)) fail(`${who}: revealed() still false on-chain`)
  }
  await revealAs(2, A, 'A', '0.4', nonceA)
  await revealAs(3, B, 'B', '0.9', nonceB)

  // ---- 3. verify the winner ------------------------------------------------
  const hi = BigInt(await call('highestBid()'))
  const hiAddr = '0x' + (await call('highestBidder()')).slice(-40)
  if (hi !== B_B) fail(`highestBid on-chain = ${hi}, expected ${B_B} (0.9 ETH)`)
  else if (hiAddr.toLowerCase() !== B.toLowerCase())
    fail(`highestBidder = ${hiAddr}, expected B ${B}`)
  else ok('on-chain winner = B at 0.9 ETH')
  // UI polls every 4s — wait for the "Highest bid" stat to reflect 0.9
  const readStat = () =>
    page.evaluate(() => {
      const label = [...document.querySelectorAll('p')].find(
        (p) => p.textContent?.trim() === 'Highest bid',
      )
      const valueEl = label?.parentElement?.querySelector('p:nth-child(2)')
      return valueEl ? valueEl.textContent.trim() : null
    })
  try {
    await page.waitForFunction(
      () => {
        const label = [...document.querySelectorAll('p')].find(
          (p) => p.textContent?.trim() === 'Highest bid',
        )
        const valueEl = label?.parentElement?.querySelector('p:nth-child(2)')
        return valueEl ? /^0\.9/.test(valueEl.textContent.trim()) : false
      },
      null,
      { timeout: 12000 },
    )
    ok('UI "Highest bid" stat shows 0.9 ETH (winner B)')
  } catch {
    fail(`UI "Highest bid" stat = "${await readStat()}", expected 0.9 ETH`)
  }

  // duplicate reveal must fail: A already revealed. UI: reveal controls gone
  // or disabled; chain: a raw reveal(0.4, nonceA) from A must revert.
  await selectAcct(2)
  const revBtn = page.getByTestId('action-reveal')
  if (await revBtn.count()) {
    if (await revBtn.isDisabled()) ok('double reveal blocked in UI (disabled)')
    else fail('reveal button still enabled after A already revealed')
  } else ok('reveal controls removed from UI after reveal')
  const dupRevealTx = await rpc('eth_sendTransaction', [
    {
      from: A,
      to: CONTRACT,
      data: MID['reveal(uint256,uint256)'] + hexq('400000000000000000') + hexq(BigInt(nonceA)),
      gas: '0x30d40',
    },
  ])
  const dupRec = await receiptFor(dupRevealTx)
  if (!dupRec) fail('double-reveal tx not mined')
  else if (dupRec.status !== '0x0')
    fail(`double reveal SUCCEEDED on-chain (status ${dupRec.status})`)
  else ok('raw double reveal() reverted on-chain (receipt status 0x0)')

  // ---- 4. warp past reveal deadline -> settle ------------------------------
  console.log('\n-- warping past reveal deadline --')
  await warpTo(revealDL + 2)
  await page.waitForTimeout(5000)
  if ((await phaseNum()) !== 2) fail('expected phase 2 (settle) after warp')
  else ok('phase advanced to Settle')

  const settleBtn = page.getByTestId('action-settle')
  if (await settleBtn.isDisabled())
    fail(`settle disabled (${await settleBtn.getAttribute('title')})`)
  else {
    const beforeS = await bannerText()
    await settleBtn.click()
    const errS = await waitBanner('Settled', beforeS, 'settle')
    if (errS) fail(errS)
    else ok('settled via UI by current bidder account')
  }
  if (!boolLast(await call('settled()'))) fail('settled() false on-chain after UI settle')
  else ok('settled()==true on-chain')

  // winner named in ended banner
  const winnerDom = await page.textContent('[data-testid="winner-address"]').catch(() => null)
  if (!winnerDom || winnerDom.trim().toLowerCase() !== B.toLowerCase())
    fail(`ended-banner winner "${winnerDom}" != B ${B}`)
  else ok('ended banner names winner B')

  // ---- 5. withdrawals ------------------------------------------------------
  await selectAcct(2) // A (loser): escrow 0.4 refund
  const wA = BigInt(await call('withdrawable(address)', pad(A)))
  if (wA !== B_A) fail(`A withdrawable ${wA}, expected 0.4 ETH`)
  else ok('A claim = 0.4 ETH via withdrawable()')
  const aBefore = await bal(A)
  const wBtnA = page.getByTestId('action-withdraw')
  if (await wBtnA.isDisabled()) fail(`A withdraw disabled: ${await wBtnA.getAttribute('title')}`)
  else {
    const beforeWA = await bannerText()
    await wBtnA.click()
    const errWA = await waitBanner('Withdrew', beforeWA, 'A withdraw')
    if (errWA) fail(errWA)
    else ok('A withdrew via UI')
  }
  const aAfter = await pollBal(A, (b) => b > aBefore)
  if (aAfter - aBefore < (B_A * 9n) / 10n)
    fail(`A balance rose only ${aAfter - aBefore} wei (expected ~0.4 ETH minus gas)`)
  else ok(`A balance increased ~0.4 ETH minus gas (${aAfter - aBefore} wei)`)

  // ---- 6. repeated withdrawal refused (UI + chain) -------------------------
  await page.waitForTimeout(5000) // poll refreshes withdrawable() -> 0
  const wBtn2 = page.getByTestId('action-withdraw')
  const title2 = (await wBtn2.getAttribute('title')) || ''
  if (await wBtn2.isEnabled())
    fail('second withdraw button still ENABLED (would pay the claim twice)')
  else if (!/nothing to withdraw/i.test(title2))
    fail(`second withdraw disabled without a clear reason: "${title2}"`)
  else ok('second withdraw blocked in UI: ' + title2)

  const txHash = await rpc('eth_sendTransaction', [
    { from: A, to: CONTRACT, data: MID['withdraw()'], gas: '0x30d40' },
  ])
  const rec = await receiptFor(txHash)
  if (!rec) fail('double-withdraw tx not mined')
  else if (rec.status !== '0x0')
    fail(`double withdraw SUCCEEDED on-chain (status ${rec.status}) — claim paid twice!`)
  else ok('raw second withdraw() reverted on-chain (receipt status 0x0)')

  // winner B paid exactly the bid: nothing further to withdraw
  const wB = BigInt(await call('withdrawable(address)', pad(B)))
  if (wB !== 0n) fail(`B withdrawable ${wB}, expected 0 (winner's escrow IS the price)`)
  else ok('winner B cannot also drain escrow (withdrawable()==0)')

  // seller withdraws proceeds (0.9 = winner bid + forfeits)
  await selectAcct(1)
  const wS = BigInt(await call('withdrawable(address)', pad(SELLER)))
  if (wS !== B_B) fail(`seller withdrawable ${wS}, expected 0.9 ETH proceeds`)
  else {
    const sBefore = await bal(SELLER)
    const wBtnS = page.getByTestId('action-withdraw')
    if (await wBtnS.isDisabled())
      fail(`seller withdraw disabled: ${await wBtnS.getAttribute('title')}`)
    else {
      const beforeWS = await bannerText()
      await wBtnS.click()
      const errWS = await waitBanner('Withdrew', beforeWS, 'seller withdraw')
      if (errWS) fail(errWS)
      else ok('seller withdrew 0.9 ETH proceeds via UI')
    }
    const sAfter = await bal(SELLER)
    if (sAfter - sBefore < (B_B * 9n) / 10n) fail(`seller balance rose only ${sAfter - sBefore}`)
    else ok('seller balance increased ~0.9 ETH minus gas')
  }

  // ---- accounting end-state: nothing left in the contract -------------------
  const contractBal = BigInt(await rpc('eth_getBalance', [CONTRACT, 'latest']))
  if (contractBal !== 0n) fail(`contract holds ${contractBal} wei after full withdraw — expected 0`)
  else ok('solvency end-state: contract drained to 0 once every claim was pulled')

  await page.screenshot({ path: path.join(OUT, 'lifecycle-settled-withdrawn.png'), fullPage: true })
  await ctx.close()
  await browser.close()
}

main()
  .catch((e) => fail(`fatal: ${e.stack || e.message}`))
  .finally(() => {
    console.log(`\n======== FULL-LIFECYCLE AUDIT ========`)
    console.log(`checks passed: ${checks.length}`)
    if (failures.length) {
      console.log(`\nFAILURES (${failures.length}):`)
      failures.forEach((f) => console.log(' * ' + f))
      process.exit(1)
    }
    console.log('\nALL PASS — complete browser lifecycle verified')
  })
