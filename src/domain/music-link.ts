export type MusicSource = 'spotify' | 'yandex'

export type MusicKind =
  | 'track'
  | 'album'
  | 'playlist'
  | 'artist'
  | 'episode'
  | 'show'
  | 'other'

export interface MusicLink {
  source: MusicSource
  type: MusicKind
  id: string
  url: string
}

const SPOTIFY_URL_RE =
  /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|episode|artist|show)\/([a-zA-Z0-9]+)/i

const YANDEX_TRACK_RE =
  /https?:\/\/music\.yandex\.(?:ru|com|by|kz)\/album\/(\d+)\/track\/(\d+)/i
const YANDEX_ALBUM_RE = /https?:\/\/music\.yandex\.(?:ru|com|by|kz)\/album\/(\d+)(?![\/\d])/i
const YANDEX_ARTIST_RE = /https?:\/\/music\.yandex\.(?:ru|com|by|kz)\/artist\/(\d+)/i
const YANDEX_PLAYLIST_RE =
  /https?:\/\/music\.yandex\.(?:ru|com|by|kz)\/users\/([^\/\s]+)\/playlists\/(\d+)/i

export function findMusicLink(text: string): MusicLink | null {
  const spotify = text.match(SPOTIFY_URL_RE)
  if (spotify) {
    const type = spotify[1].toLowerCase() as MusicKind
    const id = spotify[2]
    return { source: 'spotify', type, id, url: `https://open.spotify.com/${type}/${id}` }
  }

  const yaTrack = text.match(YANDEX_TRACK_RE)
  if (yaTrack) {
    const [_, albumId, trackId] = yaTrack
    return {
      source: 'yandex',
      type: 'track',
      id: trackId,
      url: `https://music.yandex.ru/album/${albumId}/track/${trackId}`,
    }
  }

  const yaAlbum = text.match(YANDEX_ALBUM_RE)
  if (yaAlbum) {
    return {
      source: 'yandex',
      type: 'album',
      id: yaAlbum[1],
      url: `https://music.yandex.ru/album/${yaAlbum[1]}`,
    }
  }

  const yaArtist = text.match(YANDEX_ARTIST_RE)
  if (yaArtist) {
    return {
      source: 'yandex',
      type: 'artist',
      id: yaArtist[1],
      url: `https://music.yandex.ru/artist/${yaArtist[1]}`,
    }
  }

  const yaPlaylist = text.match(YANDEX_PLAYLIST_RE)
  if (yaPlaylist) {
    return {
      source: 'yandex',
      type: 'playlist',
      id: `${yaPlaylist[1]}/${yaPlaylist[2]}`,
      url: `https://music.yandex.ru/users/${yaPlaylist[1]}/playlists/${yaPlaylist[2]}`,
    }
  }

  return null
}
