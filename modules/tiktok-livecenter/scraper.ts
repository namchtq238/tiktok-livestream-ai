import type { BrowserContext } from 'playwright'
import { findElement, SELECTORS } from './selectors.js'
import type { StreamCredentials, FetchOptions } from './types.js'
import { StreamCreator } from './api-client.js'

export async function fetchStreamKey(
  context: BrowserContext,
  accountId: string,
  title: string,
  options: FetchOptions = {}
): Promise<StreamCredentials> {
  try {
    const credentials = await new StreamCreator().createStream(context, accountId, title, options)
    console.log(`[${accountId}] Stream key fetched via API.`)
    return credentials
  } catch (error) {
    console.warn(`[${accountId}] API approach failed, falling back to browser. Reason: ${error instanceof Error ? error.message : String(error)}`)
    return fetchStreamKeyViaBrowser(context, accountId, title, options)
  }
}

export async function fetchStreamKeyViaBrowser(
  context: BrowserContext,
  accountId: string,
  title: string,
  options: FetchOptions = {}
): Promise<StreamCredentials> {
  const { timeout = 30000 } = options

  const page = await context.newPage()

  try {
    // Navigate to livecenter (main page first)
    console.log(`[${accountId}] Navigating to livecenter...`)
    await page.goto('https://livecenter.tiktok.com/', { timeout, waitUntil: 'domcontentloaded' })
    console.log(`[${accountId}] ✓ Page loaded: ${page.url()}`)
    
    // Check if redirected to login
    if (page.url().includes('/login')) {
      throw new Error('Session expired - redirected to login page. Please run setup-profile again.')
    }

    // Wait a bit for page to fully load
    await page.waitForTimeout(2000)

    // Try to navigate to producer page
    console.log(`[${accountId}] Attempting to navigate to producer page...`)
    const producerResponse = await page.goto('https://livecenter.tiktok.com/producer', { 
      timeout, 
      waitUntil: 'domcontentloaded' 
    })
    console.log(`[${accountId}] Producer page response: ${producerResponse?.status()}`)
    console.log(`[${accountId}] Current URL: ${page.url()}`)
    
    // If redirected back to main page, account may not have Go Live access
    if (page.url() === 'https://livecenter.tiktok.com/' || !page.url().includes('producer')) {
      console.log(`[${accountId}] ⚠️  Redirected away from producer page`)
      console.log(`[${accountId}] This account may not have Go Live access yet`)
      console.log(`[${accountId}] Trying alternative approach: looking for Go Live button on main page...`)
    }

    // Wait for "Go Live" button
    console.log(`[${accountId}] Looking for "Go Live" button...`)
    const goLiveBtn = await findElement(page, SELECTORS.goLiveButton, timeout)
    if (!goLiveBtn) throw new Error('Go Live button not found')
    console.log(`[${accountId}] ✓ Found "Go Live" button`)
    await goLiveBtn.click()
    console.log(`[${accountId}] ✓ Clicked "Go Live" button`)

    // Fill title
    console.log(`[${accountId}] Looking for title input...`)
    const titleInput = await findElement(page, SELECTORS.titleInput, timeout)
    if (!titleInput) throw new Error('Title input not found')
    console.log(`[${accountId}] ✓ Found title input`)
    await titleInput.fill(title)
    console.log(`[${accountId}] ✓ Filled title: "${title}"`)

    // Click "Save and Go Live"
    console.log(`[${accountId}] Looking for "Save and Go Live" button...`)
    const saveBtn = await findElement(page, SELECTORS.saveAndGoLiveButton, timeout)
    if (!saveBtn) throw new Error('Save button not found')
    console.log(`[${accountId}] ✓ Found "Save and Go Live" button`)
    await saveBtn.click()
    console.log(`[${accountId}] ✓ Clicked "Save and Go Live" button`)

    // Wait for stream key to appear
    console.log(`[${accountId}] Waiting for stream key generation...`)
    await page.waitForTimeout(3000) // Wait for key generation

    // Extract server URL
    console.log(`[${accountId}] Extracting server URL...`)
    const serverUrlField = await findElement(page, SELECTORS.serverUrlField, timeout)
    if (!serverUrlField) throw new Error('Server URL field not found')
    const serverUrl = await serverUrlField.inputValue()
    console.log(`[${accountId}] ✓ Server URL: ${serverUrl}`)

    // Extract stream key
    console.log(`[${accountId}] Extracting stream key...`)
    const streamKeyField = await findElement(page, SELECTORS.streamKeyField, timeout)
    if (!streamKeyField) throw new Error('Stream key field not found')
    const streamKey = await streamKeyField.inputValue()
    console.log(`[${accountId}] ✓ Stream key: ${streamKey.substring(0, 20)}...`)

    // Validate
    if (!serverUrl || !streamKey) {
      throw new Error('Invalid stream credentials')
    }

    const rtmpUrl = serverUrl.endsWith('/') 
      ? `${serverUrl}${streamKey}` 
      : `${serverUrl}/${streamKey}`

    const fetchedAt = Date.now()
    const expiresAt = fetchedAt + 7200000 // 2 hours

    console.log(`[${accountId}] ✅ Stream key fetched successfully!`)

    return {
      accountId,
      serverUrl,
      streamKey,
      rtmpUrl,
      fetchedAt,
      expiresAt,
    }
  } catch (error) {
    console.error(`[${accountId}] ❌ Error:`, error)
    throw error
  } finally {
    await page.close()
  }
}
