// P1 responsive audit: real browser rendering at 390/834/1440, light+dark.
// Checks: no horizontal page overflow, no clipped panels, touch targets >= 44px,
// controls functional (E2E commit flow at 390px), screenshots for review.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AUDIT_URL || 'http://localhost:5173'
const RPC = 'http://127.0.0.1:8545'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = process.env.AUDIT_OUT || path.join(ROOT, 'audit-artifacts')
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
]
const THEMES = ['light', 'dark']
const MIN_TOUCH = 44
const failures = []
const results = []

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(JSON.stringify(j.error))
  return j.result
}

async function auditPage(page, vp, theme) {
  const report = { viewport: `${vp.name} ${vp.width}x${vp.height}`, theme, issues: [] }

  // 1. horizontal overflow of the document
  const metrics = await page.evaluate(() => {
    const de = document.documentElement
    const offenders = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1) {
        const path =
          el.tagName.toLowerCase() +
          (el.id ? `#${el.id}` : '') +
          (typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : '')
        offenders.push({ el: path, right: Math.round(r.right), w: Math.round(r.width) })
      }
      if (r.width > 0 && r.left < -2) {
        const path = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')
        offenders.push({ el: path, left: Math.round(r.left), w: Math.round(r.width) })
      }
    }
    return {
      docScrollW: de.scrollWidth,
      winW: window.innerWidth,
      bodyScrollW: document.body.scrollWidth,
      offenders: offenders.slice(0, 8),
    }
  })
  if (metrics.docScrollW > metrics.winW + 1) {
    report.issues.push(
      `horizontal page overflow: scrollWidth ${metrics.docScrollW} > ${metrics.winW} (offenders: ${JSON.stringify(metrics.offenders)})`,
    )
  }

  // 2. clipped containers (overflow hidden/clip with overflowing content)
  const clipped = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('*')) {
      if (el.classList.contains('sr-only')) continue // intentional screen-reader-only clip
      const cs = getComputedStyle(el)
      const ox = cs.overflowX
      // text-overflow: ellipsis truncation is a legitimate responsive pattern
      if (cs.textOverflow === 'ellipsis' && el.children.length === 0 && cs.whiteSpace === 'nowrap')
        continue
      if ((ox === 'hidden' || ox === 'clip') && el.scrollWidth > el.clientWidth + 4) {
        const path =
          el.tagName.toLowerCase() +
          (el.id ? `#${el.id}` : '') +
          (typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/)[0]}`
            : '')
        bad.push({ el: path, scrollW: el.scrollWidth, clientW: el.clientWidth })
      }
    }
    return bad.slice(0, 6)
  })
  if (clipped.length) report.issues.push(`clipped content: ${JSON.stringify(clipped)}`)

  // 3. touch targets >= 44px on all visible interactive elements
  const small = await page.evaluate((min) => {
    const sel = 'button, a[href], select, input, [role="button"]'
    const bad = []
    for (const el of document.querySelectorAll(sel)) {
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue // hidden
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.height < min - 1 || r.width < min - 1) {
        const label = (el.textContent || el.getAttribute('aria-label') || el.id || el.name || '')
          .trim()
          .slice(0, 30)
        bad.push({
          tag: el.tagName.toLowerCase(),
          label,
          w: Math.round(r.width),
          h: Math.round(r.height),
        })
      }
    }
    return bad.slice(0, 10)
  }, MIN_TOUCH)
  if (small.length) report.issues.push(`touch targets < ${MIN_TOUCH}px: ${JSON.stringify(small)}`)

  // 4. app rendered (no error boundaries)
  const appOk = await page
    .getByTestId('app')
    .isVisible()
    .catch(() => false)
  if (!appOk) report.issues.push('app root not visible')

  // 3b. navigation functional at this width: hamburger on <lg, full nav on lg+
  const menuBtn = page.getByTestId('mobile-menu')
  const menuVisible = await menuBtn.isVisible().catch(() => false)
  const desktopNavVisible = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]')
    return !!nav && nav.offsetParent !== null
  })
  if (vp.width >= 1024) {
    if (!desktopNavVisible) report.issues.push('desktop viewport missing primary nav')
    if (menuVisible) report.issues.push('hamburger visible at desktop width')
  } else if (!menuVisible) {
    report.issues.push('mobile menu button missing at narrow width')
  } else {
    await menuBtn.click()
    const linksShown = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Mobile"]')
      return !!nav && nav.querySelectorAll('a').length >= 4
    })
    if (!linksShown) report.issues.push('mobile menu did not open with nav links')
    await menuBtn.click() // close
  }
  void desktopNavVisible

  // 5. countdown actually ticking (two reads differ)
  const cd = page.getByTestId('countdown').first()
  if (await cd.count()) {
    const t1 = await cd.textContent()
    await page.waitForTimeout(1200)
    const t2 = await cd.textContent()
    if (t1 === t2) report.issues.push(`countdown not ticking: ${t1}`)
  }

  // 6. dark theme actually applied (body bg is dark)
  const bg = await page.evaluate(
    () =>
      getComputedStyle(document.body).backgroundColor +
      ' / ' +
      getComputedStyle(document.documentElement).colorScheme,
  )
  const expectedDark = theme === 'dark' ? /(gray-950|rgb\(3, 7, 18\))|dark/i : null
  if (
    expectedDark &&
    !/rgb\(3, 7, 18\)|dark/i.test(bg) &&
    !(await page.evaluate(() => document.documentElement.classList.contains('dark')))
  ) {
    report.issues.push(`dark class/colorScheme not applied: ${bg}`)
  }
  if (
    !expectedDark &&
    (await page.evaluate(() => document.documentElement.classList.contains('dark')))
  ) {
    report.issues.push('light theme but .dark present')
  }

  report.bg = bg
  return report
}

const browser = await chromium.launch()
let firstFail = null

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      colorScheme: theme,
    })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => failures.push(`${vp.name}/${theme} pageerror: ${e.message}`))
    await page.addInitScript((t) => localStorage.setItem('blockshield.theme', t), theme)
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="app"]', { timeout: 15000 })

    // connect an account so all panels render (bidder account 2)
    try {
      await page.selectOption('#account-select', { index: 2 })
      await page
        .waitForFunction(
          () =>
            document.body.innerText.includes('Account balance') ||
            document.body.innerText.includes('Balance:'),
          null,
          { timeout: 8000 },
        )
        .catch(() => {})
    } catch (e) {
      failures.push(`${vp.name}/${theme} account connect failed: ${e.message}`)
    }

    // dismiss mobile menu open state if any
    const rep = await auditPage(page, vp, theme)
    results.push(rep)
    if (rep.issues.length) {
      failures.push(`${vp.name}/${theme}: ${rep.issues.join(' | ')}`)
      if (!firstFail) firstFail = `${vp.name}/${theme}`
    }

    await page.screenshot({ path: `${OUT}/p1-${vp.name}-${theme}.png`, fullPage: true })
    await ctx.close()
  }
}

// ---------- E2E functional flow at mobile 390 (light) ----------
{
  const fs = await import('node:fs/promises')
  const envTxt = await fs.readFile(path.join(ROOT, '.env.local'), 'utf8')
  const contract = envTxt.match(/VITE_CONTRACT_ADDRESS=(0x[0-9a-fA-F]{40})/)[1]

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => failures.push(`e2e pageerror: ${e.message}`))
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // option order: [placeholder, seller, account1, account2] -> a2 = accounts[2] is index 3
  await page.selectOption('#account-select', { index: 3 })
  await page.waitForTimeout(2000)

  // repeatability: if a prior run left a commitment for this account on this
  // deployment, refund it first (this also exercises the refund control)
  if (!(await page.locator('#bid-amount').count())) {
    const refund = page.getByTestId('action-refund')
    if (await refund.isEnabled().catch(() => false)) {
      await refund.click()
      await page.waitForTimeout(4500) // let polls confirm cleared state
    }
    if (!(await page.locator('#bid-amount').count())) {
      failures.push('e2e: commit form still missing after refund attempt — skipping commit flow')
    }
  }

  if (await page.locator('#bid-amount').count()) {
    await page.fill('#bid-amount', '0.5')
    await page.waitForTimeout(300)
    const commitBtn = page.getByTestId('action-commit')
    if (await commitBtn.isDisabled()) {
      failures.push(`e2e: commit button disabled (${await commitBtn.getAttribute('title')})`)
    } else {
      const nonceShown = (await page.getByTestId('nonce-display').textContent()) || ''
      await commitBtn.click()
      try {
        await page.waitForSelector('[data-testid="status-banner"]', { timeout: 30000 })
        const txt = await page.textContent('[data-testid="status-banner"]')
        if (!txt || !/Committed/.test(txt)) failures.push(`e2e: unexpected commit banner: ${txt}`)
      } catch {
        failures.push('e2e: no status banner after commit click')
      }
      await page.waitForTimeout(1500)

      const secretsVisible = await page
        .getByTestId('secrets-panel')
        .isVisible()
        .catch(() => false)
      if (!secretsVisible) failures.push('e2e: secrets panel not shown after commit')

      // commit-phase correctness: reveal inputs must NOT claim a mismatch while empty
      const nonceVal = ((await page.inputValue('#reveal-nonce').catch(() => '')) || '').trim()
      const amountVal = ((await page.inputValue('#reveal-amount').catch(() => '')) || '').trim()
      if (nonceVal)
        failures.push(
          `e2e: reveal nonce unexpectedly prefilled during commit phase: ${nonceVal.slice(0, 12)}…`,
        )
      if (amountVal)
        failures.push(`e2e: reveal amount unexpectedly prefilled during commit phase: ${amountVal}`)
      const red = await page.evaluate(() =>
        [...document.querySelectorAll('span')]
          .filter((s) => /does NOT match/.test(s.textContent || ''))
          .map((s) => s.textContent),
      )
      if (red.length)
        failures.push('e2e: false "does NOT match" badge while reveal inputs are empty')

      // active-commitment panel must replace the commit form
      const activeTxt = await page.evaluate(() =>
        document.body.innerText.includes('Active commitment on-chain'),
      )
      if (!activeTxt) failures.push('e2e: active commitment panel not shown after commit')

      // read the nonce the app saved (secrets panel)
      const nonceFromDom = nonceShown.trim()

      // selectors come from the compiled artifact, not hand-typed values
      const artTxt = await fs.readFile(
        path.join(ROOT, 'out/CommitRevealAuction.sol/CommitRevealAuction.json'),
        'utf8',
      )
      const methodId = JSON.parse(artTxt).methodIdentifiers

      // on-chain: commitmentHash[bidder] stored by the UI-generated tx must equal
      // computeCommitmentHash(bidder, 0.5 ether, nonce) from the CONTRACT itself
      const accounts = await rpc('eth_accounts')
      const a2 = accounts[2]
      const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0')
      const hex = (n) => BigInt(n).toString(16).padStart(64, '0')
      const storedUi = await rpc('eth_call', [
        { to: contract, data: methodId['commitmentHash(address)'] + pad(a2) },
        'latest',
      ])
      const onchainHash = await rpc('eth_call', [
        {
          to: contract,
          data:
            methodId['computeCommitmentHash(address,uint256,uint256)'] +
            pad(a2) +
            hex('500000000000000000') +
            hex(nonceFromDom || '1'),
        },
        'latest',
      ])
      if (storedUi === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        failures.push(
          'e2e: no commitment stored on-chain for the E2E account — commit did not land',
        )
      } else if (storedUi.toLowerCase() !== onchainHash.toLowerCase()) {
        failures.push(
          `e2e hash mismatch: UI stored ${storedUi} vs contract computed ${onchainHash} (nonce ${nonceFromDom})`,
        )
      } else {
        results.push({ viewport: 'e2e hash cross-check', theme: 'n/a', issues: [] })
        console.log(
          `\n[e2e] UI commitment hash == contract computeCommitmentHash ✓ (${storedUi.slice(0, 18)}…)`,
        )
      }
    }
  }

  await page.screenshot({ path: `${OUT}/p1-e2e-mobile-committed.png`, fullPage: true })
  await ctx.close()
}

await browser.close()

console.log('======== P1 RESPONSIVE AUDIT ========')
for (const r of results) {
  console.log(`\n[${r.viewport} | ${r.theme}] issues: ${r.issues.length}`)
  r.issues.forEach((i) => console.log('   - ' + i))
}
console.log('\nScreenshots -> ' + OUT)
if (failures.length) {
  console.log('\nFAILURES:')
  failures.forEach((f) => console.log(' * ' + f))
  process.exit(1)
}
console.log('\nALL PASS')
