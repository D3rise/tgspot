import type { MusicSource } from './music-link'

export interface SearchResult {
  source: MusicSource
  trackId: string        // spotify base62 or yandex numeric
  albumId?: string       // yandex needs album context in the URL
  title: string
  artists: string        // joined display string
  album: string | null
  durationSec: number | null
  coverUrl: string | null
  url: string            // canonical URL for the downloader
  hasLossless: boolean   // yandex may have flac; spotify never does
}
