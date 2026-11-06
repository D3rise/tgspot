import { SearchResult } from '../domain/search-result'
import { MusicLink } from '../domain/music-link'
import { SpotifySearchService } from './spotify-search'
import { YandexSearchService } from './yandex-search'

const PER_SOURCE_LIMIT = 8

export class SearchOrchestrator {
  constructor(
    private readonly spotify: SpotifySearchService | null,
    private readonly yandex: YandexSearchService | null,
  ) {}

  get enabled(): boolean {
    return this.spotify !== null || this.yandex !== null
  }

  // Look up a single track by its canonical link. Returns null if the source
  // isn't configured or the API doesn't know the track. Errors bubble up.
  async fetchTrackByLink(link: MusicLink): Promise<SearchResult | null> {
    if (link.type !== 'track') return null
    if (link.source === 'spotify') {
      if (!this.spotify) return null
      return this.spotify.fetchTrack(link.id)
    }
    if (!this.yandex) return null
    // Yandex track links look like /album/<albumId>/track/<trackId>. findMusicLink
    // extracts trackId into `id`; the albumId is only in the URL path.
    const albumMatch = link.url.match(/\/album\/(\d+)\/track\//)
    const albumId = albumMatch ? albumMatch[1] : undefined
    return this.yandex.fetchTrack(link.id, albumId)
  }

  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim()
    if (!trimmed) return []

    const tasks: Promise<SearchResult[]>[] = []
    if (this.spotify) {
      tasks.push(
        this.spotify.search(trimmed, PER_SOURCE_LIMIT).catch((err) => {
          console.warn('[search] Spotify failed:', err.message ?? err)
          return []
        }),
      )
    }
    if (this.yandex) {
      tasks.push(
        this.yandex.search(trimmed, PER_SOURCE_LIMIT).catch((err) => {
          console.warn('[search] Yandex failed:', err.message ?? err)
          return []
        }),
      )
    }

    const [spotifyRes = [], yandexRes = []] = await Promise.all(tasks)
    return interleave(spotifyRes, yandexRes)
  }
}

// Alternate results so the user sees a mix, not one whole source then the other.
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i])
    if (i < b.length) out.push(b[i])
  }
  return out
}
