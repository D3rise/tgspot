export interface Config {
  botToken: string
  whitelist: Set<string>
  adminUsername: string | null
  zotifyCredentialsPath: string
  yandexMusicToken: string | null
  telegramBotApiRoot: string | null
  spotifyClientId: string | null
  spotifyClientSecret: string | null
  storageChatId: number | null
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env variable: ${name}`)
  }
  return value.trim()
}

export function loadConfig(): Config {
  const whitelist = new Set(
    required('WHITELIST')
      .split(',')
      .map((s) => s.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  )

  const admin = process.env.ADMIN_USERNAME?.trim().replace(/^@/, '').toLowerCase() || null

  return {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    whitelist,
    adminUsername: admin,
    zotifyCredentialsPath: process.env.ZOTIFY_CREDENTIALS_PATH?.trim() || '/data/credentials.json',
    yandexMusicToken: process.env.YANDEX_MUSIC_TOKEN?.trim() || null,
    telegramBotApiRoot: process.env.TELEGRAM_BOT_API_ROOT?.trim() || null,
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID?.trim() || null,
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET?.trim() || null,
    storageChatId: parseChatId(process.env.STORAGE_CHAT_ID),
  }
}

function parseChatId(raw: string | undefined): number | null {
  const value = raw?.trim()
  if (!value) return null
  const n = Number(value)
  if (!Number.isInteger(n)) {
    throw new Error(`STORAGE_CHAT_ID must be an integer, got: ${value}`)
  }
  return n
}
