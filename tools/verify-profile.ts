import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

async function verifyProfile(accountId: string) {
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found`)
  }

  console.log(`Verifying profile for ${account.username}...`)

  const shouldIgnoreHTTPSErrors = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  const context = await chromium.launchPersistentContext(account.profileDir, {
    headless: true,
    ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
  })

  const page = await context.newPage()
  
  try {
    await page.goto('https://www.tiktok.com/foryou', { timeout: 30000 })

    // Wait a bit for any redirects
    await page.waitForTimeout(2000)

    const finalUrl = page.url()
    const isLoggedIn = !finalUrl.includes('/login')
    
    if (!isLoggedIn) {
      await context.close()
      console.log(`✗ Profile ${accountId} expired (redirected to /login)`)
      console.log(`  URL: ${finalUrl}`)
      return false
    }

    // CRITICAL: Verify the logged-in username matches expected account
    let loggedInUsername = null
    try {
      // Method 1: Click on profile button and get URL
      const profileButton = await page.locator('[data-e2e="nav-profile"]').first()
      if (profileButton) {
        await profileButton.click()
        await page.waitForTimeout(2000) // Wait for navigation
        const profileUrl = page.url()
        const match = profileUrl.match(/@([^/?]+)/)
        if (match) {
          loggedInUsername = match[1]
        }
      }

      // Method 2: If method 1 fails, try looking for profile link after page loads
      if (!loggedInUsername) {
        await page.waitForTimeout(3000) // Wait longer for page to load
        const profileLinks = await page.locator('a[href*="/@"]').all()
        for (const link of profileLinks) {
          const href = await link.getAttribute('href')
          if (href) {
            const match = href.match(/@([^/?]+)/)
            if (match) {
              loggedInUsername = match[1]
              break
            }
          }
        }
      }
    } catch (e) {
      // Username extraction failed
    }
    
    await context.close()

    // Verify username matches
    if (loggedInUsername) {
      const expectedUsername = account.username
      const usernameMatches = loggedInUsername === expectedUsername

      if (usernameMatches) {
        console.log(`✓ Profile ${accountId} is valid`)
        console.log(`  Username: ${loggedInUsername} ✓`)
        console.log(`  URL: ${finalUrl}`)
        return true
      } else {
        console.log(`✗ Profile ${accountId} has WRONG account logged in!`)
        console.log(`  Expected: ${expectedUsername}`)
        console.log(`  Found: ${loggedInUsername}`)
        console.log(`  → Profile is corrupted or mixed up`)
        return false
      }
    } else {
      // Could not extract username, fall back to basic check
      console.log(`⚠️  Profile ${accountId} appears logged in, but could not verify username`)
      console.log(`  URL: ${finalUrl}`)
      console.log(`  → Consider re-setup to ensure correct account`)
      return true // Assume valid but warn user
    }
  } catch (error) {
    await context.close()
    console.log(`✗ Profile ${accountId} verification failed`)
    console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// CLI
const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/verify-profile.js <accountId>')
  process.exit(1)
}

verifyProfile(accountId)
  .then(valid => process.exit(valid ? 0 : 1))
  .catch(console.error)
