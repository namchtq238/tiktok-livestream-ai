import type { Page, ElementHandle } from 'playwright'

export const SELECTORS = {
  goLiveButton: [
    'button:has-text("Go Live")',
    '[data-testid="go-live-btn"]',
    '.go-live-button',
  ],
  titleInput: [
    'input[placeholder*="title" i]',
    '[data-testid="stream-title-input"]',
    'input[name="title"]',
  ],
  saveAndGoLiveButton: [
    'button:has-text("Save and Go Live")',
    'button:has-text("Confirm")',
    'button:has-text("Start")',
  ],
  serverUrlField: [
    '[data-testid="server-url"]',
    'input[value*="rtmp"]',
    'input[readonly][value*="push"]',
  ],
  streamKeyField: [
    '[data-testid="stream-key"]',
    'input[type="text"][value*="live_"]',
    'input[readonly][value*="?"]',
  ],
}

export async function findElement(
  page: Page,
  selectorList: string[],
  timeout: number = 30000
): Promise<ElementHandle | null> {
  for (const selector of selectorList) {
    try {
      const element = await page.waitForSelector(selector, { timeout, state: 'visible' })
      if (element) return element
    } catch {
      continue
    }
  }
  return null
}
