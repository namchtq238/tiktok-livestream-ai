import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function setupProfile(accountId: string) {
  // Load account config
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found in config`)
  }

  console.log(`Setting up profile for ${account.username}...`)

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
  
  // Navigate to TikTok login
  console.log('Navigating to TikTok...')
  await page.goto('https://www.tiktok.com/login', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  })
  
  console.log('Please login manually:')
  console.log(`1. Username V2: ${account.username}`)
  console.log('2. Password: (check docs/requirements/tiktok account/1.note.md)')
  console.log('3. OTP: Go to https://mail.tm → login → get OTP')
  console.log('\n⚠️  IMPORTANT: Wait 5-10 seconds before typing to avoid detection')
  console.log('⚠️  Type slowly and naturally (like a human)')
  // Wait for successful login - detect by checking for profile avatar element
  // TikTok no longer redirects to /foryou after login
  console.log('\nWaiting for login... (will auto-detect when logged in)')

  // Add random mouse movements to simulate human behavior
  const simulateHumanBehavior = async () => {
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(
        Math.random() * 1280,
        Math.random() * 720
      )
      await page.waitForTimeout(Math.random() * 2000 + 1000)
    }
  }
  
  // Run simulation in background
  simulateHumanBehavior().catch(() => {})

  // Wait for login by detecting profile-related elements or URL changes
  await page.waitForFunction(
    () => {
      const url = window.location.href
      // Detect common post-login URLs
      if (url.includes('/foryou') || url.includes('/@') || url.includes('/following')) return true
      // Detect logged-in state by checking for upload/profile button
      const uploadBtn = document.querySelector('[data-e2e="upload-icon"]')
      const profileAvatar = document.querySelector('[data-e2e="nav-profile"]')
      const sidebarProfile = document.querySelector('[href*="/@"]')
      return !!(uploadBtn || profileAvatar || sidebarProfile)
    },
    { timeout: 300000 } // 5 minutes
  )

  console.log('✓ Login successful!')
  console.log('Verifying context...')

  // Close and reopen to verify context persistence
  await context.close()

  // Reopen context
  const context2 = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })
  const page2 = await context2.newPage()
  
  try {
    await page2.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch {
    // Ignore HTTP error codes - page may still be usable
  }

  // Check if still logged in (not redirected to login page)
  const isLoggedIn = !page2.url().includes('/login')
  
  if (isLoggedIn) {
    console.log('✓ Profile verified! Context saved successfully.')
  } else {
    console.log('✗ Profile verification failed. Please try again.')
  }

  await context2.close()
}

// CLI
const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/setup-profile.js <accountId>')
  process.exit(1)
}

setupProfile(accountId).catch(console.error)
