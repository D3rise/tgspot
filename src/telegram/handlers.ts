import type { Bot, Context } from 'grammy'
import { WhitelistService } from '../services/whitelist'
import { PerUserQueue } from '../services/queue'
import { DownloadOrchestrator } from '../services/download-orchestrator'
import { AdminNotifier } from '../services/admin-notifier'
import { MetadataService } from '../services/metadata'
import { findSpotifyLink } from '../domain/spotify-link'
import { TelegramJobReporter, safeReply } from './telegram-reporter'
import { isGroupChat, mentionsBot } from './mention'
import { Lifecycle } from './lifecycle'

const HELP_TEXT =
  'Пришли ссылку на трек или альбом в Spotify — я скачаю и отправлю.\n' +
  'Пример: https://open.spotify.com/track/0hBUik7RITAPmSlnOGiWdm\n\n' +
  'В группах я работаю в режиме privacy: реагирую только на сообщения, ' +
  'в которых меня явно упомянули через @. Пример:\n' +
  '@botname https://open.spotify.com/track/...'

export interface HandlerDeps {
  bot: Bot
  whitelist: WhitelistService
  queue: PerUserQueue
  orchestrator: DownloadOrchestrator
  admin: AdminNotifier
  metadata: MetadataService
  lifecycle: Lifecycle
}

export function registerHandlers(deps: HandlerDeps): void {
  const { bot, whitelist, queue, orchestrator, admin, metadata, lifecycle } = deps

  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat) admin.observe(ctx.from.username, ctx.chat.id)
    await next()
  })

  bot.command(['start', 'help'], async (ctx) => {
    if (!isAllowed(ctx, whitelist)) return
    await safeReply(ctx, HELP_TEXT)
  })

  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx, whitelist)) return

    if (!lifecycle.isAccepting()) {
      await safeReply(ctx, 'Бот перезапускается, попробуй через минуту.')
      return
    }

    if (isGroupChat(ctx) && !mentionsBot(ctx)) return

    const link = findSpotifyLink(ctx.message.text)
    if (!link) {
      if (!isGroupChat(ctx)) await safeReply(ctx, `Не вижу ссылку на Spotify.\n\n${HELP_TEXT}`)
      return
    }

    const reporter = new TelegramJobReporter(ctx, metadata)
    queue
      .enqueue(ctx.from!.id, () => orchestrator.handle(link, reporter))
      .catch((err) => console.error(`[handlers] task failed for user ${ctx.from?.id}:`, err))
  })

  bot.catch((err) => console.error('[bot] update handler error:', err.error))
}

function isAllowed(ctx: Context, whitelist: WhitelistService): boolean {
  if (whitelist.isAllowed(ctx.from?.username)) return true
  if (ctx.from) {
    console.log(
      `[handlers] rejected message from @${ctx.from.username ?? '<no-username>'} (id=${ctx.from.id})`,
    )
  }
  return false
}
