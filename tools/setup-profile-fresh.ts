import { chromium } from 'playwright'
import { readFileSync, existsSync, rmSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function setupProfileFresh(accountId: string) {
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found in config`)
  }

  console.log(`Setting up FRESH profile for ${account.username}...`)
  
  // FORCE DELETE old profile
  if (existsSync(account.profileDir)) {
    console.log(`Deleting old profile at ${account.profileDir}...`)
    rmSync(account.profileDir, { recursive: true, force: true })
    console.log('✓ Old profile deleted\n')
  }

  const shouldIgnoreHTTPSErrors = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  const context = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    permissions: ['geolocation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })

  const page = await context.newPage()
  
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    })
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })
  })
  
  console.log('Navigating to TikTok...')
  await page.goto('https://www.tiktok.com', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  })
  
  await page.waitForTimeout(2000)
  
  console.log('\n' + '='.repeat(60))
  console.log('FRESH LOGIN - NO OLD COOKIES')
  console.log('='.repeat(60))
  console.log(`\n📱 LOGIN WITH ACCOUNT: ${account.username}`)
  console.log('\nINSTRUCTIONS:')
  console.log('1. Click "Log in" button')
  console.log('2. Choose login method (QR code recommended)')
  console.log(`3. IMPORTANT: Login with ${account.username}`)
  console.log('4. Complete OTP if needed')
  console.log('\n⏳ Waiting for login...')
  console.log('='.repeat(60) + '\n')

  // Wait for successful login
  try {
    await Promise.race([
      page.waitForSelector('[data-e2e="nav-profile"]', { timeout: 300000 }),
      page.waitForSelector('a[href*="/@"]', { timeout: 300000 }),
    ])
    
    console.log('\n✓ Login detected!')
  } catch (error) {
    console.log('\n✗ Timeout waiting for login.')
    await context.close()
    process.exit(1)
  }

  // Verify username immediately
  console.log('Verifying username...')
  await page.waitForTimeout(2000)
  
  let loggedInUsername = null
  try {
    const profileButton = await page.locator('[data-e2e="nav-profile"]').first()
    if (profileButton) {
      await profileButton.click()
      await page.waitForTimeout(2000)
      const profileUrl = page.url()
      const match = profileUrl.match(/@([^/?]+)/)
      if (match) {
        loggedInUsername = match[1]
      }
    }
  } catch (e) {
    console.log('Could not extract username')
  }

  if (loggedInUsername) {
    if (loggedInUsername === account.username) {
      console.log(`✓ Correct account: ${loggedInUsername}`)
    } else {
      console.log(`\n✗ WRONG ACCOUNT!`)
      console.log(`  Expected: ${account.username}`)
      console.log(`  Found: ${loggedInUsername}`)
      console.log(`\n  Please close browser and try again with correct account.`)
      await context.close()
      process.exit(1)
    }
  }

  console.log('\n✓ Login successful!')
  console.log('Saving context...')
  await context.close()

  // Verify persistence
  console.log('Verifying context persistence...')
  const context2 = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })
  const page2 = await context2.newPage()
  await page2.goto('https://www.tiktok.com/foryou')
  await page2.waitForTimeout(2000)

  const isLoggedIn = !page2.url().includes('/login')
  
  if (isLoggedIn) {
    console.log('✓ Profile verified! Context saved successfully.')
    console.log(`\n📁 Profile saved to: ${account.profileDir}`)
    console.log(`✅ You can now use this profile for automation!`)
  } else {
    console.log('✗ Profile verification failed.')
  }

  await context2.close()
}

const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/setup-profile-fresh.js <accountId>')
  console.error('\nThis tool DELETES old profile and creates a fresh one.')
  console.error('Use this when you have wrong account logged in.')
  process.exit(1)
}

setupProfileFresh(accountId).catch(console.error)
