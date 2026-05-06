export interface AccountConfig {
  id: string              // "acc1", "acc2"
  name: string            // display name
  username: string        // TikTok username
  profileDir: string      // path to persistent context
  hashtag_id: string      // "42" = Chat, "6" = Music
  priority_region: string // "vn", "us"
  title?: string          // override title
}

export interface StreamCredentials {
  accountId: string
  serverUrl: string       // e.g. "rtmps://push-live.tiktokcdn.com/live/"
  streamKey: string       // e.g. "live_XXXXXXXX?..."
  rtmpUrl: string         // full URL
  fetchedAt: number       // unix timestamp
  expiresAt: number       // fetchedAt + 7200000 (2h)
}

export interface TitleConfig {
  defaultTitle: string
  titleTemplate: string   // "{account} | Live #{index}"
  allowOverride: boolean
}

export interface FetchOptions {
  headless?: boolean
  timeout?: number
  retryMax?: number
}

export interface PreflightResult {
  success: boolean
  credentials: StreamCredentials[]
  errors: Array<{ accountId: string; error: Error }>
}
