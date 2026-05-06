import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function setupProfileLiveStudio(accountId: string) {
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found in config`)
  }

  console.log(`Setting up profile for ${account.username} via Live Studio...`)

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
  
  // Navigate to TikTok login page (more reliable than Live Studio)
  console.log('Navigating to TikTok...')
  await page.goto('https://www.tiktok.com', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  })
  
  await page.waitForTimeout(2000)
  
  console.log('\n' + '='.repeat(60))
  console.log('LOGIN VIA TIKTOK')
  console.log('='.repeat(60))
  console.log('\n📱 INSTRUCTIONS:')
  console.log('1. If not logged in, click "Log in" button')
  console.log('2. Choose your preferred login method:')
  console.log('   - QR code (scan with TikTok app) - RECOMMENDED')
  console.log('   - Username/password + OTP')
  console.log('3. Complete the login process')
  console.log('\n⏳ Waiting for login... (will auto-detect success)')
  console.log('='.repeat(60) + '\n')

  // Wait for successful login (multiple possible success indicators)
  try {
    console.log('Waiting for you to complete login...')
    
    await Promise.race([
      // Option 1: User avatar appears (means logged in)
      page.waitForSelector('[data-e2e="nav-profile"]', { timeout: 300000 }),
      
      // Option 2: Profile link appears
      page.waitForSelector('a[href*="/@"]', { timeout: 300000 }),
      
      // Option 3: For You feed loads (logged in state)
      page.waitForFunction(() => {
        return document.querySelector('[data-e2e="recommend-list-item-container"]') !== null
      }, { timeout: 300000 }),
    ])
    
    console.log('\n✓ Login detected!')
  } catch (error) {
    console.log('\n⚠️  Timeout waiting for login. Checking current state...')
    console.log('Current URL:', page.url())
    
    // Check if we're actually logged in despite timeout
    const hasProfileButton = await page.locator('[data-e2e="nav-profile"]').count() > 0
    const hasProfileLink = await page.locator('a[href*="/@"]').count() > 0
    const isOnLoginPage = page.url().includes('/login')
    
    if (!hasProfileButton && !hasProfileLink && !isOnLoginPage) {
      console.log('✗ Could not detect login. Please try again.')
      await context.close()
      process.exit(1)
    }
    
    if (isOnLoginPage) {
      console.log('✗ Still on login page. Login was not completed.')
      await context.close()
      process.exit(1)
    }
    
    console.log('✓ Looks like login was successful (found user elements)')
  }

  console.log('\n✓ Login successful!')
  console.log('Verifying context...')

  await context.close()

  // Verify by going to regular TikTok
  console.log('Reopening browser to verify session persistence...')
  const context2 = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })
  const page2 = await context2.newPage()
  await page2.goto('https://www.tiktok.com/foryou', { timeout: 30000 })

  const isLoggedIn = !page2.url().includes('/login')
  
  if (isLoggedIn) {
    console.log('✓ Profile verified! Context saved successfully.')
    console.log(`\n📁 Profile saved to: ${account.profileDir}`)
    console.log('\n✅ You can now use this profile for automation!')
  } else {
    console.log('✗ Profile verification failed. Please try again.')
  }

  await context2.close()
}

const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/setup-profile-live-studio.js <accountId>')
  console.error('\nExample:')
  console.error('  node dist/tools/setup-profile-live-studio.js acc1')
  console.error('\nThis tool uses TikTok Live Studio login page which has')
  console.error('less strict anti-bot detection than www.tiktok.com')
  process.exit(1)
}

setupProfileLiveStudio(accountId).catch(console.error)
