// Injected-wallet UI audit: a FAKE EIP-1193 provider is injected into the
// page before scripts run (no real wallet, no transactions). Verifies the
// MetaMask/extension path end-to-end in the UI:
//   1. the "Connect browser wallet" button appears when window.ethereum exists
//   2. connect() requests accounts + chainId and reports the WRONG chain loudly
//      (connection-problem banner; the whole action UI is gated off)
//   3. a wallet_switchEthereumChain prompt is raised by the Switch button
//   4. a wallet-emitted chainChanged event re-enables the UI live (no reload)
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.AUDIT_URL || 'http://localhost:5173'
const envTxt = readFileSync(path.join(ROOT, '.env.local'), 'utf8')
const ANVIL_ACCT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'

const failures = []
const checks = []
const ok = (n) => (checks.push(n), console.log(`  ✓ ${n}`))
const fail = (m) => (failures.push(m), console.log(`  ✗ ${m}`))

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((acct) => {
  const handlers = {}
  window.__ethHandlers = handlers
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return [acct]
      if (method === 'eth_chainId') return '0x1' // WRONG on purpose: mainnet
      if (method === 'wallet_switchEthereumChain') {
        window.__switchCalled = true
        throw new Error('user rejected') // simulate a rejected popup
      }
      throw new Error('fake provider: unhandled ' + method)
    },
    on: (event, cb) => ((handlers[event] ??= []).push(cb), handlers),
    removeListener: () => {},
  }
}, ANVIL_ACCT)
const page = await ctx.newPage()
page.on('pageerror', (e) => fail(`pageerror: ${e.message}`))

const main = async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // 1. button renders only because window.ethereum exists
  const btn = page.getByTestId('connect-injected')
  if (await btn.isVisible().catch(() => false))
    ok('“Connect browser wallet” renders for EIP-1193 provider')
  else fail('injected wallet button missing')

  // 2. connect -> accounts accepted, wrong-chain surfaced
  await btn.click()
  await page.waitForTimeout(4500)
  const problem =
    (await page.textContent('[data-testid="connection-problem"]').catch(() => '')) || ''
  if (/wallet is on chain 1/i.test(problem) && /expected 31337/.test(problem))
    ok('wrong wallet chain reported clearly: ' + problem.slice(0, 90))
  else fail(`connection problem banner missing/unclear: "${problem.slice(0, 120)}"`)
  const btnLabel = ((await btn.textContent()) || '').trim()
  if (/Wallet connected \(#1\)/.test(btnLabel))
    ok('connect() accepted injected accounts, injected mode active')
  else fail(`button label after connect: "${btnLabel}"`)
  // safety: the action UI (commit form / lifecycle) must be gated OFF
  const commitVisible = await page.locator('#bid-amount').count()
  if (commitVisible === 0)
    ok('wallet-on-wrong-chain: full lifecycle UI gated off (zero actions exposed)')
  else fail('commit form exposed while wallet chain is wrong')

  // 3. switch attempt -> prompt raised -> rejection surfaced, still gated
  const sw = page.getByTestId('switch-chain')
  if (await sw.isVisible().catch(() => false)) {
    await sw.click()
    await page.waitForTimeout(800)
    const called = await page.evaluate(() => window.__switchCalled === true)
    const banner = (await page.textContent('[data-testid="status-banner"]').catch(() => '')) || ''
    if (called) ok('wallet_switchEthereumChain prompted from UI')
    else fail('Switch button did not call wallet_switchEthereumChain')
    if (/rejected/i.test(banner)) ok('rejected switch surfaced as visible error')
    else fail(`switch rejection not surfaced: "${banner.slice(0, 80)}"`)
  } else fail('switch-chain button missing while wallet on wrong chain')

  // 4. wallet reports the right chain via chainChanged -> UI recovers live
  await page.evaluate(() => {
    const hs = window.__ethHandlers['chainChanged'] || []
    hs.forEach((f) => f('0x7a69')) // 31337
  })
  await page.waitForTimeout(5000)
  const commitAfter = await page.locator('#bid-amount').count()
  if (commitAfter > 0) ok('chainChanged -> wallet verified -> lifecycle UI re-enabled live')
  else fail('lifecycle UI still gated after wallet reported correct chain')
}

try {
  await main()
} catch (e) {
  fail(`fatal: ${e.message}`)
}
await browser.close()

console.log(`\nchecks passed: ${checks.length}`)
if (failures.length) {
  console.log(`FAILURES (${failures.length}):`)
  failures.forEach((f) => console.log(' * ' + f))
  process.exit(1)
}
console.log('ALL PASS — injected-wallet UI verified')
