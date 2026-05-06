import { chromium, type BrowserContext } from 'playwright'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { chromium as chromiumExtra } from 'playwright-extra'

chromiumExtra.use(StealthPlugin())

export class BrowserManager {
  private contexts: Map<string, BrowserContext> = new Map()

  async getContext(
    accountId: string,
    profileDir: string,
    headless: boolean = true
  ): Promise<BrowserContext> {
    // Reuse existing context
    if (this.contexts.has(accountId)) {
      return this.contexts.get(accountId)!
    }

    // Create new persistent context
    const shouldIgnoreHTTPSErrors = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
    const context = await chromiumExtra.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(shouldIgnoreHTTPSErrors && { ignoreHTTPSErrors: true }),
    })

    this.contexts.set(accountId, context)
    return context
  }

  async closeContext(accountId: string): Promise<void> {
    const context = this.contexts.get(accountId)
    if (context) {
      await context.close()
      this.contexts.delete(accountId)
    }
  }

  async closeAll(): Promise<void> {
    for (const [accountId] of this.contexts) {
      await this.closeContext(accountId)
    }
  }
}
