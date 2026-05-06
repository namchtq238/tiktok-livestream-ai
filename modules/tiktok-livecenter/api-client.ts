// Allow self-signed / corporate proxy certificates.
// Many enterprise environments intercept TLS with their own CA.
// This only affects outbound HTTP requests made by this module.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

export class TikTokAPIError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly response?: any
  ) {
    super(message)
    this.name = 'TikTokAPIError'
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TikTokAPIError)
    }
  }
}

export class CookieLoadError extends Error {
  constructor(
    message: string,
    public readonly profileDir: string
  ) {
    super(message)
    this.name = 'CookieLoadError'
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CookieLoadError)
    }
  }
}

export class ServerURLResolutionError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'ServerURLResolutionError'
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ServerURLResolutionError)
    }
  }
}

export class CredentialExtractionError extends Error {
  constructor(
    message: string,
    public readonly response: any
  ) {
    super(message)
    this.name = 'CredentialExtractionError'
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CredentialExtractionError)
    }
  }
}

interface VersionCheckResponse {
  data: {
    manifest: {
      win32: {
        version: string
      }
    }
  }
}

interface VersionCache {
  version: string
  timestamp: number
}

export class VersionFetcher {
  private cache: VersionCache | null = null
  private readonly CACHE_TTL = 86400000 // 24 hours
  private readonly DEFAULT_VERSION = '0.99.0'
  private readonly UPDATE_ENDPOINT = 'https://tron-sg.bytelemon.com/api/sdk/check_update'

  async getLatestVersion(): Promise<string> {
    if (this.cache && this.isCacheValid()) {
      return this.cache.version
    }

    try {
      const params = new URLSearchParams({
        pid: '7393277106664249610',
        uid: '7464643088460875280',
        branch: 'studio/release/stable',
        buildId: '0'
      })

      const url = `${this.UPDATE_ENDPOINT}?${params.toString()}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      })

      if (!response.ok) {
        console.warn(`[VersionFetcher] HTTP error ${response.status}, using default version`)
        return this.DEFAULT_VERSION
      }

      const data = await response.json() as VersionCheckResponse
      const version = data?.data?.manifest?.win32?.version

      if (!version || typeof version !== 'string') {
        console.warn('[VersionFetcher] Invalid response structure, using default version')
        return this.DEFAULT_VERSION
      }

      this.cache = { version, timestamp: Date.now() }
      return version

    } catch (error) {
      console.warn('[VersionFetcher] Failed to fetch version:', error)
      return this.DEFAULT_VERSION
    }
  }

  private isCacheValid(): boolean {
    if (!this.cache) return false
    return Date.now() - this.cache.timestamp < this.CACHE_TTL
  }

  clearCache(): void {
    this.cache = null
  }
}

interface DispatchResponse {
  ttnet_dispatch_actions?: Array<{
    Action?: string
    strategy_info?: string
  }>
}

interface ServerURLCache {
  url: string
  timestamp: number
}

export class ServerURLResolver {
  private cache: ServerURLCache | null = null
  private readonly CACHE_TTL = 3600000 // 1 hour
  private readonly DEFAULT_URL = 'https://webcast16-normal-c-useast2a.tiktokv.com/'
  private readonly DISPATCH_ENDPOINT = 'https://tnc16-platform-useast1a.tiktokv.com/get_domains/v4/'

  async getServerUrl(cookies: Map<string, string>): Promise<string> {
    if (this.cache && this.isCacheValid()) {
      return this.cache.url
    }

    try {
      const cookieHeader = Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')

      const response = await fetch(this.DISPATCH_ENDPOINT, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Cookie': cookieHeader
        }
      })

      if (!response.ok) {
        console.warn(`[ServerURLResolver] HTTP error ${response.status}, using default URL`)
        this.cache = { url: this.DEFAULT_URL, timestamp: Date.now() }
        return this.DEFAULT_URL
      }

      const data = await response.json() as DispatchResponse
      const serverUrl = this.extractServerUrl(data)

      if (!serverUrl) {
        console.warn('[ServerURLResolver] Could not extract server URL, using default')
        this.cache = { url: this.DEFAULT_URL, timestamp: Date.now() }
        return this.DEFAULT_URL
      }

      this.cache = { url: serverUrl, timestamp: Date.now() }
      return serverUrl

    } catch (error) {
      console.warn('[ServerURLResolver] Failed to resolve server URL:', error)
      this.cache = { url: this.DEFAULT_URL, timestamp: Date.now() }
      return this.DEFAULT_URL
    }
  }

  private extractServerUrl(data: DispatchResponse): string | null {
    try {
      if (!data.ttnet_dispatch_actions || !Array.isArray(data.ttnet_dispatch_actions)) {
        return null
      }

      for (const action of data.ttnet_dispatch_actions) {
        if (!action.strategy_info) continue
        if (!action.strategy_info.includes('webcast-normal.tiktokv.com')) continue

        try {
          const strategyInfo = JSON.parse(action.strategy_info)
          // Two-level resolution: prefer resolved host over domain
          const hostname = strategyInfo.host || strategyInfo.domain

          if (!hostname || typeof hostname !== 'string') continue

          return `https://${hostname}/`
        } catch (parseError) {
          console.warn('[ServerURLResolver] Failed to parse strategy_info:', parseError)
          continue
        }
      }

      return null
    } catch (error) {
      console.warn('[ServerURLResolver] Error extracting server URL:', error)
      return null
    }
  }

  private isCacheValid(): boolean {
    if (!this.cache) return false
    return Date.now() - this.cache.timestamp < this.CACHE_TTL
  }

  clearCache(): void {
    this.cache = null
  }
}

export class CookieManager {
  async loadCookies(context: any): Promise<Map<string, string>> {
    try {
      const allCookies = await context.cookies()

      const tiktokCookies = allCookies.filter((cookie: any) =>
        cookie.domain && cookie.domain.includes('.tiktok.com')
      )

      if (tiktokCookies.length === 0) {
        throw new CookieLoadError(
          'No TikTok cookies found in browser context. Please ensure the account is logged in.',
          'unknown'
        )
      }

      const cookieMap = new Map<string, string>()
      for (const cookie of tiktokCookies) {
        cookieMap.set(cookie.name, cookie.value)
      }

      console.log(`[CookieManager] Loaded ${cookieMap.size} TikTok cookies`)
      console.log(`[CookieManager] Cookie names:`, Array.from(cookieMap.keys()).join(', '))
      return cookieMap

    } catch (error) {
      if (error instanceof CookieLoadError) throw error

      throw new CookieLoadError(
        `Failed to load cookies from browser context: ${error instanceof Error ? error.message : String(error)}`,
        'unknown'
      )
    }
  }
}

export class UserAgentSpoofer {
  getUserAgent(version: string): string {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TikTokLIVEStudio/${version} Chrome/108.0.5359.215 Electron/22.3.18-tt.8.release.main.44 TTElectron/22.3.18-tt.8.release.main.44 Safari/537.36`
  }
}

interface CreateStreamResponse {
  data: {
    stream_url?: {
      rtmp_push_url?: string
    }
    share_url?: string
    room_id?: string
    prompts?: string
  }
  status_code: number
}

interface StreamCredentials {
  accountId: string
  serverUrl: string
  streamKey: string
  rtmpUrl: string
  fetchedAt: number
  expiresAt: number
}

export class APIClient {
  private cookies: Map<string, string>
  private userAgent: string
  private readonly TIMEOUT_MS = 10000

  constructor(cookies: Map<string, string>, userAgent: string) {
    this.cookies = cookies
    this.userAgent = userAgent
  }

  async post(
    baseUrl: string,
    params: Record<string, string>,
    data: Record<string, string>
  ): Promise<CreateStreamResponse> {
    const queryString = new URLSearchParams(params).toString()
    const url = `${baseUrl}webcast/room/create/?${queryString}`

    const cookieHeader = Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')

    const body = new URLSearchParams(data).toString()

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS)

    try {
      console.log(`[APIClient] POST ${url}`)

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': this.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader
        },
        body,
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      console.log(`[APIClient] Response status: ${response.status}`)

      if (!response.ok) {
        const rawText = await response.text()
        console.error(`[APIClient] Error response body (raw):`, rawText.substring(0, 500))

        let errorResponse: any
        try {
          errorResponse = JSON.parse(rawText)
        } catch {
          errorResponse = { raw: rawText }
        }

        throw new TikTokAPIError(
          `HTTP ${response.status}: ${response.statusText}`,
          'HTTP_ERROR',
          response.status,
          errorResponse
        )
      }

      const responseData = await response.json() as CreateStreamResponse
      console.log(`[APIClient] Response body:`, JSON.stringify(responseData, null, 2))
      return responseData

    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === 'AbortError') {
        throw new TikTokAPIError(
          `Request timed out after ${this.TIMEOUT_MS}ms`,
          'TIMEOUT'
        )
      }

      if (error instanceof TikTokAPIError) throw error

      throw new TikTokAPIError(
        `API request failed: ${error instanceof Error ? error.message : String(error)}`,
        'REQUEST_FAILED'
      )
    }
  }
}

export class CredentialExtractor {
  extract(response: CreateStreamResponse, accountId: string): StreamCredentials {
    if (!response.data) {
      throw new CredentialExtractionError(
        'Invalid API response: missing "data" field',
        response
      )
    }

    if (!response.data.stream_url) {
      throw new CredentialExtractionError(
        'Invalid API response: missing "data.stream_url" field',
        response
      )
    }

    const rtmpPushUrl = response.data.stream_url.rtmp_push_url

    if (!rtmpPushUrl || typeof rtmpPushUrl !== 'string') {
      throw new CredentialExtractionError(
        'Invalid API response: missing or invalid "data.stream_url.rtmp_push_url" field',
        response
      )
    }

    const lastSlashIndex = rtmpPushUrl.lastIndexOf('/')

    if (lastSlashIndex === -1 || lastSlashIndex === rtmpPushUrl.length - 1) {
      throw new CredentialExtractionError(
        'Invalid RTMP URL format: cannot split server URL and stream key',
        response
      )
    }

    const serverUrl = rtmpPushUrl.substring(0, lastSlashIndex + 1)
    const streamKey = rtmpPushUrl.substring(lastSlashIndex + 1)
    const rtmpUrl = serverUrl + streamKey

    const fetchedAt = Date.now()
    const expiresAt = fetchedAt + 7200000 // 2 hours

    return { accountId, serverUrl, streamKey, rtmpUrl, fetchedAt, expiresAt }
  }
}

interface AccountConfigInput {
  id: string
  name?: string
  username?: string
  profileDir?: string
  hashtag_id?: string
  priority_region?: string
  title?: string
}

export class FallbackHandler {
  async handleFailure(
    context: any,
    accountId: string,
    title: string,
    options: { headless?: boolean; timeout?: number; retryMax?: number },
    error: Error
  ): Promise<StreamCredentials> {
    console.warn(
      `[${accountId}] [FallbackHandler] API failed, falling back to browser automation. Reason: ${error.message}`
    )

    const { fetchStreamKeyViaBrowser } = await import('./scraper.js')

    try {
      const credentials = await fetchStreamKeyViaBrowser(context, accountId, title, options)
      console.log(`[${accountId}] [FallbackHandler] Browser automation succeeded.`)
      return credentials
    } catch (fallbackError) {
      console.error(
        `[${accountId}] [FallbackHandler] Browser automation also failed:`,
        fallbackError
      )
      throw fallbackError
    }
  }
}

export class StreamCreator {
  private readonly cookieManager = new CookieManager()
  private readonly versionFetcher = new VersionFetcher()
  private readonly serverURLResolver = new ServerURLResolver()
  private readonly userAgentSpoofer = new UserAgentSpoofer()
  private readonly credentialExtractor = new CredentialExtractor()
  private readonly fallbackHandler = new FallbackHandler()

  async createStreamFromConfig(
    context: any,
    accountConfig: AccountConfigInput,
    title: string,
    options: { headless?: boolean; timeout?: number; retryMax?: number } = {}
  ): Promise<StreamCredentials> {
    return this.createStream(context, accountConfig.id, title, {
      ...options,
      hashtag_id: accountConfig.hashtag_id,
      priority_region: accountConfig.priority_region,
      titleOverride: accountConfig.title,
    })
  }

  async createStream(
    context: any,
    accountId: string,
    title: string,
    options: {
      headless?: boolean
      timeout?: number
      retryMax?: number
      hashtag_id?: string
      priority_region?: string
      game_tag_id?: string
      titleOverride?: string
    } = {}
  ): Promise<StreamCredentials> {
    console.log(`[${accountId}] [StreamCreator] Starting API-based stream creation...`)

    try {
      const cookies = await this.cookieManager.loadCookies(context)
      const version = await this.versionFetcher.getLatestVersion()
      const serverUrl = await this.serverURLResolver.getServerUrl(cookies)
      const userAgent = this.userAgentSpoofer.getUserAgent(version)

      const hashtag_id = options.hashtag_id ?? '0'
      const priority_region = options.priority_region ?? ''
      const game_tag_id = options.game_tag_id ?? '0'
      const effectiveTitle = options.titleOverride ?? title

      // Derive webcast_sdk_version from version string: "0.99.0" → "990"
      const webcast_sdk_version = version
        .split('.')
        .map((part) => part.padStart(2, '0'))
        .join('')
        .replace(/^0+/, '') || '990'

      const params: Record<string, string> = {
        aid: '8311',
        app_name: 'tiktok_live_studio',
        channel: 'studio',
        device_platform: 'windows',
        priority_region,
        live_mode: '6',
        version_code: version,
        webcast_sdk_version,
        webcast_language: 'en',
        app_language: 'en',
        language: 'en',
        browser_version: userAgent.replace(/^Mozilla\/5\.0 /, ''),
        browser_name: 'Mozilla',
        browser_platform: 'Win32',
        browser_language: 'en-US',
        screen_height: '1080',
        screen_width: '1920',
        timezone_name: 'Africa/Lagos',
        device_id: '7378193331631310352',
        install_id: '7378196538524927745',
      }

      const data: Record<string, string> = {
        title: effectiveTitle,
        live_studio: '1',
        gen_replay: 'false',
        chat_auth: '1',
        cover_uri: '',
        close_room_when_close_stream: 'true',
        hashtag_id,
        game_tag_id,
        screenshot_cover_status: '1',
        live_sub_only: '0',
        chat_sub_only_auth: '2',
        multi_stream_scene: '0',
        gift_auth: '1',
        chat_l2: '1',
        star_comment_switch: 'true',
        multi_stream_source: '1',
      }

      const apiClient = new APIClient(cookies, userAgent)
      const response = await apiClient.post(serverUrl, params, data)
      const credentials = this.credentialExtractor.extract(response, accountId)

      console.log(`[${accountId}] [StreamCreator] Stream created successfully via API.`)
      return credentials

    } catch (error) {
      return this.fallbackHandler.handleFailure(
        context,
        accountId,
        title,
        options,
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }
}
