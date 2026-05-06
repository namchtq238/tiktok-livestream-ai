import { rmSync, existsSync } from 'fs'
import { readFileSync } from 'fs'
import type { AccountConfig } from '../modules/tiktok-livecenter/types.js'

function clearProfile(accountId: string) {
  // Load account config
  const configPath = 'config/accounts.json'
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const account = config.accounts.find((a: AccountConfig) => a.id === accountId)
  
  if (!account) {
    throw new Error(`Account ${accountId} not found in config`)
  }

  console.log(`Clearing profile for ${account.username}...`)
  console.log(`Profile directory: ${account.profileDir}`)

  if (!existsSync(account.profileDir)) {
    console.log('✓ Profile directory does not exist. Nothing to clear.')
    return
  }

  try {
    rmSync(account.profileDir, { recursive: true, force: true })
    console.log('✓ Profile cleared successfully!')
    console.log('\nYou can now run setup-profile-qr.js to create a fresh profile.')
  } catch (error) {
    console.error('✗ Failed to clear profile:', error)
    throw error
  }
}

// CLI
const accountId = process.argv[2]
if (!accountId) {
  console.error('Usage: node dist/tools/clear-profile.js <accountId>')
  console.error('\nExample:')
  console.error('  node dist/tools/clear-profile.js acc1')
  console.error('\nWarning: This will delete all saved cookies and session data!')
  process.exit(1)
}

console.log('\n⚠️  WARNING: This will delete all saved cookies and session data!')
console.log('You will need to login again after clearing.\n')

clearProfile(accountId)
