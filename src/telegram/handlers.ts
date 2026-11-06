import type { Bot, Context } from 'grammy'
import { WhitelistService } from '../services/whitelist'
import { PerUserQueue } from '../services/queue'
import { DownloadOrchestrator } from '../services/download-orchestrator'
import { AdminNotifier } from '../services/admin-notifier'
import { MetadataService } from '../services/metadata'
import { findMusicLink } from '../domain/music-link'
import { TelegramJobReporter, safeReply } from './telegram-reporter'
import { isGroupChat, mentionsBot } from './mention'
import { Lifecycle } from './lifecycle'
import { DmSearch } from './dm-search'

const HELP_TEXT =
  'Пришли ссылку на трек или альбом — я скачаю и отправлю.\n' +
  'Поддерживаются: Spotify и Яндекс.Музыка.\n' +
  'Примеры:\n' +
  '  https://open.spotify.com/track/0hBUik7RITAPmSlnOGiWdm\n' +
  '  https://music.yandex.ru/album/12345/track/67890\n\n' +
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
  dmSearch: DmSearch
}

export function registerHandlers(deps: HandlerDeps): void {
  const { bot, whitelist, queue, orchestrator, admin, metadata, lifecycle, dmSearch } = deps

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

    const link = findMusicLink(ctx.message.text)
    if (!link) {
      if (isGroupChat(ctx)) return
      // В ЛС текст без ссылки — это поисковый запрос.
      await dmSearch.startSearch(ctx, ctx.message.text.trim())
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
