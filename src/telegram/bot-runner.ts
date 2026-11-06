import { Bot } from 'grammy'
import { Config } from '../config'
import { WhitelistService } from '../services/whitelist'
import { PerUserQueue } from '../services/queue'
import { SpotifyDownloader } from '../services/spotify-downloader'
import { YandexDownloader } from '../services/yandex-downloader'
import { MetadataService } from '../services/metadata'
import { AlbumInfoService } from '../services/album-info'
import { AdminNotifier } from '../services/admin-notifier'
import { DownloadOrchestrator } from '../services/download-orchestrator'
import { SpotifySearchService } from '../services/spotify-search'
import { YandexSearchService } from '../services/yandex-search'
import { SearchOrchestrator } from '../services/search-orchestrator'
import { registerHandlers } from './handlers'
import { registerInlineSearch } from './inline-search'
import { registerInlineCallback } from './inline-callback'
import { DmSearch } from './dm-search'
import { Lifecycle } from './lifecycle'

export interface BotRunner {
  start(): Promise<void>
  shutdown(): Promise<void>
}

export function createBotRunner(config: Config): BotRunner {
  const bot = new Bot(
    config.botToken,
    config.telegramBotApiRoot ? { client: { apiRoot: config.telegramBotApiRoot } } : undefined,
  )
  const lifecycle = new Lifecycle()

  const whitelist = new WhitelistService(config.whitelist)
  const queue = new PerUserQueue()
  const spotify = new SpotifyDownloader(config.zotifyCredentialsPath)
  const yandex = config.yandexMusicToken ? new YandexDownloader(config.yandexMusicToken) : null
  const metadata = new MetadataService()
  const albumInfo = new AlbumInfoService()
  const admin = new AdminNotifier(bot.api, config.adminUsername)
  const orchestrator = new DownloadOrchestrator(spotify, yandex, albumInfo, admin)

  const spotifySearch =
    config.spotifyClientId && config.spotifyClientSecret
      ? new SpotifySearchService(config.spotifyClientId, config.spotifyClientSecret)
      : null
  const yandexSearch = config.yandexMusicToken
    ? new YandexSearchService(config.yandexMusicToken)
    : null
  const search = new SearchOrchestrator(spotifySearch, yandexSearch)

  const dmSearch = new DmSearch({
    whitelist,
    queue,
    orchestrator,
    metadata,
    search,
    lifecycle,
  })

  registerHandlers({ bot, whitelist, queue, orchestrator, admin, metadata, lifecycle, dmSearch })
  registerInlineSearch(bot, whitelist, search)
  registerInlineCallback(
    bot,
    whitelist,
    queue,
    spotify,
    yandex,
    metadata,
    admin,
    lifecycle,
    config.storageChatId,
  )
  dmSearch.register(bot)

  if (!yandex) console.log('[bot] Yandex.Music support disabled (no YANDEX_MUSIC_TOKEN)')
  if (config.telegramBotApiRoot) {
    console.log(`[bot] using local Bot API server at ${config.telegramBotApiRoot} (2 GB upload limit)`)
  }
  if (!spotifySearch)
    console.log('[bot] Spotify search disabled (no SPOTIFY_CLIENT_ID/SECRET)')
  if (!yandexSearch)
    console.log('[bot] Yandex search disabled (no YANDEX_MUSIC_TOKEN)')
  if (config.storageChatId) {
    console.log(
      `[bot] inline delivery: via storage chat ${config.storageChatId} (file appears in the target chat)`,
    )
  } else {
    console.log('[bot] inline delivery: DM fallback (no STORAGE_CHAT_ID set)')
  }

  return {
    async start() {
      await bot.start({
        onStart: (info) => console.log(`[bot] running as @${info.username}`),
        drop_pending_updates: true,
        allowed_updates: ['message', 'inline_query', 'callback_query'],
      })
    },
    async shutdown() {
      lifecycle.stopAccepting()
      console.log('[bot] draining per-user queue…')
      await queue.drain()
      console.log('[bot] queue drained, stopping polling')
      await bot.stop()
    },
  }
}
