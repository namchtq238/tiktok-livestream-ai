import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function setupProfileWithQR(accountId: string) {
  // Load account config
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found in config`)
  }

  console.log(`Setting up profile for ${account.username} using QR Code...`)

  // Launch browser with persistent context + anti-detection settings
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
  
  // Add extra stealth measures
  await page.addInitScript(() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })
    
    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    })
    
    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })
  })
  
  // Navigate to TikTok homepage first (more natural)
  console.log('Navigating to TikTok homepage...')
  await page.goto('https://www.tiktok.com', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  })
  
  // Wait a bit (simulate human browsing)
  await page.waitForTimeout(3000)
  
  // Now go to login page
  console.log('Navigating to login page...')
  await page.goto('https://www.tiktok.com/login', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  })
  
  console.log('\n' + '='.repeat(60))
  console.log('LOGIN WITH QR CODE')
  console.log('='.repeat(60))
  console.log('\n📱 INSTRUCTIONS:')
  console.log('1. Click on "Log in with QR code" button on the page')
  console.log('2. Open TikTok app on your phone')
  console.log('3. Go to Profile → Menu (☰) → Settings → Scan QR code')
  console.log('4. Scan the QR code displayed on screen')
  console.log('5. Confirm login on your phone')
  console.log('\n⏳ Waiting for QR code login... (will auto-detect when you reach /foryou)')
  console.log('='.repeat(60) + '\n')

  // Wait for successful login (redirect to /foryou)
  try {
    await page.waitForURL('**/foryou', { timeout: 300000 }) // 5 minutes
  } catch (error) {
    console.log('\n⚠️  Timeout waiting for login. Checking current URL...')
    console.log('Current URL:', page.url())
    
    // Check if we're on a different success page
    if (!page.url().includes('/login')) {
      console.log('✓ Looks like login was successful (not on /login page)')
    } else {
      throw new Error('Login timeout - still on login page')
    }
  }

  console.log('\n✓ Login successful!')
  console.log('Verifying context...')

  // Close and reopen to verify context persistence
  await context.close()

  // Reopen context
  const context2 = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })
  const page2 = await context2.newPage()
  await page2.goto('https://www.tiktok.com/foryou')

  // Check if still logged in
  const isLoggedIn = !page2.url().includes('/login')
  
  if (isLoggedIn) {
    console.log('✓ Profile verified! Context saved successfully.')
    console.log(`\n📁 Profile saved to: ${account.profileDir}`)
  } else {
    console.log('✗ Profile verification failed. Please try again.')
  }

  await context2.close()
}

// CLI
const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/setup-profile-qr.js <accountId>')
  console.error('\nExample:')
  console.error('  node dist/tools/setup-profile-qr.js acc1')
  process.exit(1)
}

setupProfileWithQR(accountId).catch(console.error)
