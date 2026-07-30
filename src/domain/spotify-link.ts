export type SpotifyLinkType = 'track' | 'album' | 'playlist' | 'episode' | 'artist' | 'show'

export interface SpotifyLink {
  type: SpotifyLinkType
  id: string
  url: string
}

const SPOTIFY_URL_RE =
  /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|episode|artist|show)\/([a-zA-Z0-9]+)/i

export function findSpotifyLink(text: string): SpotifyLink | null {
  const match = text.match(SPOTIFY_URL_RE)
  if (!match) return null
  const type = match[1].toLowerCase() as SpotifyLinkType
  const id = match[2]
  return { type, id, url: `https://open.spotify.com/${type}/${id}` }
}
