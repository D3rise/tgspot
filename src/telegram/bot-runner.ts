import { Bot } from 'grammy'
import { Config } from '../config'
import { WhitelistService } from '../services/whitelist'
import { PerUserQueue } from '../services/queue'
import { DownloaderService } from '../services/downloader'
import { MetadataService } from '../services/metadata'
import { AlbumInfoService } from '../services/album-info'
import { AdminNotifier } from '../services/admin-notifier'
import { DownloadOrchestrator } from '../services/download-orchestrator'
import { registerHandlers } from './handlers'
import { Lifecycle } from './lifecycle'

export interface BotRunner {
  start(): Promise<void>
  shutdown(): Promise<void>
}

export function createBotRunner(config: Config): BotRunner {
  const bot = new Bot(config.botToken)
  const lifecycle = new Lifecycle()

  const whitelist = new WhitelistService(config.whitelist)
  const queue = new PerUserQueue()
  const downloader = new DownloaderService(config.zotifyCredentialsPath)
  const metadata = new MetadataService()
  const albumInfo = new AlbumInfoService()
  const admin = new AdminNotifier(bot.api, config.adminUsername)
  const orchestrator = new DownloadOrchestrator(downloader, albumInfo, admin)

  registerHandlers({ bot, whitelist, queue, orchestrator, admin, metadata, lifecycle })

  return {
    async start() {
      await bot.start({
        onStart: (info) => console.log(`[bot] running as @${info.username}`),
        drop_pending_updates: true,
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
