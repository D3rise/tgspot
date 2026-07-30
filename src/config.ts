export interface Config {
  botToken: string
  whitelist: Set<string>
  adminUsername: string | null
  zotifyCredentialsPath: string
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
  }
}
