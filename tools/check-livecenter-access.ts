import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function checkLivecenterAccess(accountId: string) {
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found`)
  }

  console.log(`\n=== Checking Livecenter Access for ${account.username} ===\n`)

  const shouldIgnoreHTTPSErrors = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  const context = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })

  const page = await context.newPage()
  
  try {
    // Step 1: Check if logged in
    console.log('Step 1: Checking login status...')
    await page.goto('https://www.tiktok.com/foryou', { timeout: 30000 })
    const isLoggedIn = !page.url().includes('/login')
    
    if (!isLoggedIn) {
      console.log('❌ Not logged in - session expired')
      console.log('   Run: node dist/tools/setup-profile.js', accountId)
      await context.close()
      return
    }
    console.log('✓ Logged in successfully\n')

    // Step 2: Navigate to livecenter main page
    console.log('Step 2: Navigating to livecenter...')
    await page.goto('https://livecenter.tiktok.com/', { timeout: 30000, waitUntil: 'domcontentloaded' })
    console.log(`✓ Livecenter loaded: ${page.url()}\n`)
    
    await page.waitForTimeout(2000)

    // Step 3: Try to access producer page
    console.log('Step 3: Attempting to access producer page...')
    const response = await page.goto('https://livecenter.tiktok.com/producer', { 
      timeout: 30000, 
      waitUntil: 'domcontentloaded' 
    })
    
    console.log(`Response status: ${response?.status()}`)
    console.log(`Current URL: ${page.url()}`)
    
    if (page.url().includes('producer')) {
      console.log('✅ Producer page accessible!\n')
    } else {
      console.log('⚠️  Redirected away from producer page\n')
      console.log('Possible reasons:')
      console.log('  1. Account does not have Go Live permission yet')
      console.log('  2. Need to verify account (phone, email)')
      console.log('  3. Need minimum followers (usually 1000+)')
      console.log('  4. Account age requirement not met')
      console.log('  5. Region restrictions\n')
    }

    // Step 4: Check for Go Live button on current page
    console.log('Step 4: Looking for Go Live button...')
    await page.waitForTimeout(2000)
    
    const goLiveSelectors = [
      'button:has-text("Go Live")',
      'button:has-text("Go LIVE")',
      'a[href*="producer"]',
      '[data-testid="go-live-btn"]',
      '.go-live-button',
    ]
    
    let foundGoLive = false
    for (const selector of goLiveSelectors) {
      try {
        const element = await page.waitForSelector(selector, { timeout: 3000, state: 'visible' })
        if (element) {
          console.log(`✓ Found Go Live button with selector: ${selector}`)
          foundGoLive = true
          break
        }
      } catch {
        continue
      }
    }
    
    if (!foundGoLive) {
      console.log('❌ Go Live button not found')
      console.log('   This account may not have streaming access\n')
    }

    // Step 5: Take screenshot for manual inspection
    console.log('\nStep 5: Taking screenshot...')
    await page.screenshot({ path: `data/logs/livecenter-${accountId}.png`, fullPage: true })
    console.log(`✓ Screenshot saved: data/logs/livecenter-${accountId}.png`)
    
    console.log('\n=== Check Complete ===')
    console.log('Browser will stay open for 10 seconds for manual inspection...')
    await page.waitForTimeout(10000)

  } finally {
    await context.close()
  }
}

// CLI
const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/check-livecenter-access.js <accountId>')
  console.error('Example: node dist/tools/check-livecenter-access.js acc1')
  process.exit(1)
}

checkLivecenterAccess(accountId).catch(console.error)
