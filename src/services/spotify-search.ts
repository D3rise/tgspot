import { SearchResult } from '../domain/search-result'

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SEARCH_URL = 'https://api.spotify.com/v1/search'
const TRACK_URL = 'https://api.spotify.com/v1/tracks'
const TOKEN_REFRESH_MARGIN_MS = 60_000

interface TokenResponse {
  access_token: string
  expires_in: number
}

interface RawArtist {
  name: string
}

interface RawImage {
  url: string
  width?: number
  height?: number
}

interface RawAlbum {
  name: string
  images?: RawImage[]
}

interface RawTrack {
  id: string
  name: string
  artists: RawArtist[]
  album?: RawAlbum
  duration_ms?: number
  external_urls?: { spotify?: string }
}

interface SearchResponse {
  tracks?: { items?: RawTrack[] }
}

export class SpotifySearchService {
  private token: string | null = null
  private tokenExpiresAt = 0
  private tokenPromise: Promise<string> | null = null

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async fetchTrack(trackId: string): Promise<SearchResult | null> {
    const token = await this.getToken()
    const resp = await fetch(`${TRACK_URL}/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (resp.status === 404) return null
    if (!resp.ok) {
      throw new Error(`Spotify track fetch failed: ${resp.status} ${await resp.text().catch(() => '')}`)
    }
    const data = (await resp.json()) as RawTrack
    return this.mapTrack(data)
  }

  async search(query: string, limit = 8): Promise<SearchResult[]> {
    const token = await this.getToken()
    const url = new URL(SEARCH_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'track')
    url.searchParams.set('limit', String(limit))
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!resp.ok) {
      throw new Error(`Spotify search failed: ${resp.status} ${await resp.text().catch(() => '')}`)
    }
    const data = (await resp.json()) as SearchResponse
    const items = data.tracks?.items ?? []
    return items.map((t) => this.mapTrack(t))
  }

  private mapTrack(t: RawTrack): SearchResult {
    return {
      source: 'spotify',
      trackId: t.id,
      title: t.name,
      artists: t.artists.map((a) => a.name).join(', ') || 'Unknown Artist',
      album: t.album?.name ?? null,
      durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
      coverUrl: pickImage(t.album?.images),
      url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
      hasLossless: false,
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.token
    }
    if (this.tokenPromise) return this.tokenPromise
    this.tokenPromise = this.fetchToken().finally(() => {
      this.tokenPromise = null
    })
    return this.tokenPromise
  }

  private async fetchToken(): Promise<string> {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!resp.ok) {
      throw new Error(`Spotify token fetch failed: ${resp.status}`)
    }
    const data = (await resp.json()) as TokenResponse
    this.token = data.access_token
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000
    return this.token
  }
}

function pickImage(images?: RawImage[]): string | null {
  if (!images || images.length === 0) return null
  // Spotify returns largest first. Pick a middle-size (~300) if available.
  const preferred = images.find((i) => i.width && i.width >= 200 && i.width <= 400)
  return (preferred ?? images[images.length - 1]).url
}
