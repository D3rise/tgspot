import spotifyUrlInfo = require('spotify-url-info')

type SpotifyUrlInfoClient = { getData: (url: string) => Promise<unknown> }
type SpotifyUrlInfoFactory = (fetchImpl: typeof fetch) => SpotifyUrlInfoClient

export interface AlbumTrack {
  id: string
  url: string
  title: string
  artists: string
}

export interface AlbumInfo {
  name: string
  artist: string
  tracks: AlbumTrack[]
}

interface RawTrack {
  uri?: string
  id?: string
  name?: string
  title?: string
  subtitle?: string
  artists?: Array<{ name: string }>
}

interface RawAlbum {
  name?: string
  title?: string
  subtitle?: string
  artists?: Array<{ name: string }>
  trackList?: RawTrack[]
  tracks?: { items?: RawTrack[] } | RawTrack[]
}

export class AlbumInfoService {
  private readonly client: SpotifyUrlInfoClient

  constructor() {
    const factory = spotifyUrlInfo as unknown as SpotifyUrlInfoFactory
    this.client = factory(fetch)
  }

  async fetch(url: string): Promise<AlbumInfo> {
    const data = (await this.client.getData(url)) as RawAlbum
    const name = data.name || data.title || 'Unknown album'
    const artist = data.artists?.[0]?.name || data.subtitle || 'Unknown artist'
    const tracks = this.parseTracks(data, artist)
    if (tracks.length === 0) {
      throw new Error('Album track list is empty or could not be parsed')
    }
    return { name, artist, tracks }
  }

  private parseTracks(data: RawAlbum, fallbackArtist: string): AlbumTrack[] {
    const raw =
      data.trackList || (Array.isArray(data.tracks) ? data.tracks : data.tracks?.items) || []

    return raw
      .map((t): AlbumTrack | null => {
        const id = this.extractTrackId(t)
        if (!id) return null
        return {
          id,
          url: `https://open.spotify.com/track/${id}`,
          title: t.title || t.name || 'Unknown title',
          artists: t.subtitle || t.artists?.map((a) => a.name).join(', ') || fallbackArtist,
        }
      })
      .filter((t): t is AlbumTrack => t !== null)
  }

  private extractTrackId(t: RawTrack): string | null {
    if (t.id) return t.id
    if (t.uri?.startsWith('spotify:track:')) return t.uri.slice('spotify:track:'.length)
    return null
  }
}
