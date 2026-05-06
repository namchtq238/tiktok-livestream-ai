import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function verifyProfileDebug(accountId: string) {
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found`)
  }

  console.log(`Verifying profile for ${account.username}...`)
  console.log('Opening browser in non-headless mode for debugging...\n')

  const shouldIgnoreHTTPSErrors = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  const context = await chromium.launchPersistentContext(account.profileDir, {
    headless: false,  // Show browser
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })

  const page = await context.newPage()
  
  try {
    await page.goto('https://www.tiktok.com/foryou', { timeout: 30000 })
    await page.waitForTimeout(3000)

    const finalUrl = page.url()
    console.log(`Current URL: ${finalUrl}`)
    
    const isLoggedIn = !finalUrl.includes('/login')
    console.log(`Is logged in: ${isLoggedIn}\n`)

    if (!isLoggedIn) {
      console.log('Not logged in, stopping...')
      await context.close()
      return false
    }

    // Debug: Try multiple methods to extract username
    console.log('=== Attempting to extract username ===\n')

    // Method 1: Profile links
    console.log('Method 1: Looking for profile links...')
    const profileLinks = await page.locator('a[href*="/@"]').all()
    console.log(`Found ${profileLinks.length} links with /@`)
    for (let i = 0; i < Math.min(profileLinks.length, 5); i++) {
      const href = await profileLinks[i].getAttribute('href')
      console.log(`  Link ${i + 1}: ${href}`)
    }

    // Method 2: Navigate to profile
    console.log('\nMethod 2: Navigating to /profile...')
    await page.goto('https://www.tiktok.com/profile', { timeout: 10000 })
    await page.waitForTimeout(2000)
    const profileUrl = page.url()
    console.log(`Profile URL: ${profileUrl}`)

    // Method 3: Check page title
    console.log('\nMethod 3: Checking page title...')
    const title = await page.title()
    console.log(`Page title: ${title}`)

    // Method 4: Look for username in meta tags
    console.log('\nMethod 4: Checking meta tags...')
    const metaUsername = await page.locator('meta[property="og:url"]').getAttribute('content').catch(() => null)
    console.log(`Meta og:url: ${metaUsername}`)

    // Method 5: Check data attributes
    console.log('\nMethod 5: Looking for data-e2e attributes...')
    const userElements = await page.locator('[data-e2e*="user"], [data-e2e*="profile"]').all()
    console.log(`Found ${userElements.length} user-related elements`)
    for (let i = 0; i < Math.min(userElements.length, 5); i++) {
      const dataE2e = await userElements[i].getAttribute('data-e2e')
      const text = await userElements[i].textContent().catch(() => '')
      console.log(`  Element ${i + 1}: data-e2e="${dataE2e}", text="${text?.substring(0, 50)}"`)
    }

    console.log('\n=== Debug session complete ===')
    console.log('Browser will stay open. Press Ctrl+C to close.')
    
    // Keep browser open for manual inspection
    await page.waitForTimeout(300000) // 5 minutes

    await context.close()
    return true
  } catch (error) {
    console.log(`Error: ${error instanceof Error ? error.message : String(error)}`)
    await context.close()
    return false
  }
}

const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/verify-profile-debug.js <accountId>')
  process.exit(1)
}

verifyProfileDebug(accountId).catch(console.error)
