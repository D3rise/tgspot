import type { Bot, Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { randomBytes } from 'crypto'
import { WhitelistService } from '../services/whitelist'
import { PerUserQueue } from '../services/queue'
import { DownloadOrchestrator } from '../services/download-orchestrator'
import { MetadataService } from '../services/metadata'
import { SearchOrchestrator } from '../services/search-orchestrator'
import { SearchResult } from '../domain/search-result'
import { MusicLink } from '../domain/music-link'
import { YandexQuality } from '../services/downloader-types'
import { TelegramJobReporter, safeReply } from './telegram-reporter'
import { Lifecycle } from './lifecycle'

const PAGE_SIZE = 5
const SESSION_TTL_MS = 30 * 60 * 1000
const MAX_SESSIONS = 500

interface Session {
  userId: number
  chatId: number
  query: string
  results: SearchResult[]
  page: number
  expiresAt: number
}

export interface DmSearchDeps {
  whitelist: WhitelistService
  queue: PerUserQueue
  orchestrator: DownloadOrchestrator
  metadata: MetadataService
  search: SearchOrchestrator
  lifecycle: Lifecycle
}

// Namespace for our callback data — must not collide with `dl|` used by inline.
// sp = search-page, st = select track, sb = back to results, sx = close, sd = download.
const OUR_PREFIXES = ['sp|', 'st|', 'sb|', 'sx|', 'sd|']

export class DmSearch {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly deps: DmSearchDeps) {}

  register(bot: Bot): void {
    bot.on('callback_query:data', async (ctx, next) => {
      const data = ctx.callbackQuery.data
      if (!OUR_PREFIXES.some((p) => data.startsWith(p))) return next()
      try {
        await this.handleCallback(ctx, data)
      } catch (err) {
        console.error('[dm-search] callback failed:', err)
        await ctx.answerCallbackQuery({ text: 'Ошибка' }).catch(() => undefined)
      }
    })
  }

  async startSearch(ctx: Context, query: string): Promise<void> {
    if (!this.deps.search.enabled) {
      await safeReply(
        ctx,
        'Поиск не настроен. Пришли ссылку на трек/альбом Spotify или Яндекс.Музыки.',
      )
      return
    }

    let results: SearchResult[]
    try {
      results = await this.deps.search.search(query)
    } catch (err) {
      console.error('[dm-search] search failed:', err)
      await safeReply(ctx, 'Не удалось выполнить поиск, попробуй ещё раз.')
      return
    }

    if (results.length === 0) {
      await safeReply(ctx, `Ничего не нашёл по «${query}».`)
      return
    }

    const sid = this.newSessionId()
    const session: Session = {
      userId: ctx.from!.id,
      chatId: ctx.chat!.id,
      query,
      results,
      page: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    this.saveSession(sid, session)

    const view = renderResultsPage(sid, session)
    try {
      await ctx.reply(view.text, {
        reply_markup: view.keyboard,
        reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
      })
    } catch (err) {
      console.error('[dm-search] failed to send results:', err)
    }
  }

  private async handleCallback(ctx: Context, data: string): Promise<void> {
    if (!this.deps.whitelist.isAllowed(ctx.from?.username)) {
      await ctx.answerCallbackQuery({ text: '⛔️ Нет доступа', show_alert: true })
      return
    }
    if (!this.deps.lifecycle.isAccepting()) {
      await ctx.answerCallbackQuery({
        text: 'Бот перезапускается, попробуй через минуту.',
        show_alert: true,
      })
      return
    }

    const parts = data.split('|')
    const kind = parts[0]

    if (kind === 'sd') return this.handleDownload(ctx, parts)
    if (kind === 'sx') return this.handleClose(ctx, parts[1])
    if (kind === 'sp') return this.handlePage(ctx, parts[1], parseInt(parts[2] ?? '0', 10))
    if (kind === 'st') return this.handleTrackSelect(ctx, parts[1], parseInt(parts[2] ?? '0', 10))
    if (kind === 'sb') return this.handleBack(ctx, parts[1], parseInt(parts[2] ?? '0', 10))
  }

  private async handlePage(ctx: Context, sid: string, newPage: number): Promise<void> {
    const session = this.getSession(sid)
    if (!session) return this.replyExpired(ctx)
    const totalPages = Math.max(1, Math.ceil(session.results.length / PAGE_SIZE))
    const clamped = Math.max(0, Math.min(totalPages - 1, newPage))
    if (clamped === session.page) {
      await ctx.answerCallbackQuery()
      return
    }
    session.page = clamped
    await this.editToView(ctx, renderResultsPage(sid, session))
    await ctx.answerCallbackQuery()
  }

  private async handleTrackSelect(ctx: Context, sid: string, absIndex: number): Promise<void> {
    const session = this.getSession(sid)
    if (!session) return this.replyExpired(ctx)
    const track = session.results[absIndex]
    if (!track) {
      await ctx.answerCallbackQuery({ text: 'Трек не найден', show_alert: true })
      return
    }
    await this.editToView(ctx, renderTrackDetail(sid, track, session.page))
    await ctx.answerCallbackQuery()
  }

  private async handleBack(ctx: Context, sid: string, page: number): Promise<void> {
    const session = this.getSession(sid)
    if (!session) return this.replyExpired(ctx)
    session.page = page
    await this.editToView(ctx, renderResultsPage(sid, session))
    await ctx.answerCallbackQuery()
  }

  private async handleClose(ctx: Context, sid: string): Promise<void> {
    this.sessions.delete(sid)
    try {
      await ctx.deleteMessage()
    } catch {
      /* ignore */
    }
    await ctx.answerCallbackQuery()
  }

  private async handleDownload(ctx: Context, parts: string[]): Promise<void> {
    // sd|s|<trackId>  OR  sd|y|<q>|<trackId>|<albumId>
    const source = parts[1]
    let link: MusicLink
    let yandexQuality: YandexQuality | undefined

    if (source === 's' && parts.length === 3 && parts[2]) {
      const trackId = parts[2]
      link = {
        source: 'spotify',
        type: 'track',
        id: trackId,
        url: `https://open.spotify.com/track/${trackId}`,
      }
    } else if (source === 'y' && parts.length === 5 && parts[3] && parts[4]) {
      const q = parts[2]
      const trackId = parts[3]
      const albumId = parts[4]
      if (q !== 'h' && q !== 'l') {
        await ctx.answerCallbackQuery({ text: 'Ошибка данных', show_alert: true })
        return
      }
      yandexQuality = q === 'h' ? 'high' : 'lossless'
      link = {
        source: 'yandex',
        type: 'track',
        id: trackId,
        url: `https://music.yandex.ru/album/${albumId}/track/${trackId}`,
      }
    } else {
      await ctx.answerCallbackQuery({ text: 'Ошибка данных', show_alert: true })
      return
    }

    await ctx.answerCallbackQuery({ text: '⬇️ Скачиваю…' })
    // Убираем меню поиска — статус-сообщение о скачивании появится вместо него.
    try {
      await ctx.deleteMessage()
    } catch {
      /* ignore */
    }

    const reporter = new TelegramJobReporter(ctx, this.deps.metadata)
    const userId = ctx.from!.id
    this.deps.queue
      .enqueue(userId, () => this.deps.orchestrator.handle(link, reporter, { yandexQuality }))
      .catch((err) => console.error(`[dm-search] task failed for user ${userId}:`, err))
  }

  private async editToView(ctx: Context, view: View): Promise<void> {
    try {
      await ctx.editMessageText(view.text, { reply_markup: view.keyboard })
    } catch {
      // Common failures: message too old, identical text, etc. — non-fatal.
    }
  }

  private async replyExpired(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery({
      text: 'Сессия поиска устарела. Отправь запрос заново.',
      show_alert: true,
    })
  }

  private newSessionId(): string {
    return randomBytes(4).toString('hex') // 8 hex chars → комфортно влезает в 64б callback_data
  }

  private saveSession(sid: string, s: Session): void {
    this.evictExpired()
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest) this.sessions.delete(oldest)
    }
    this.sessions.set(sid, s)
  }

  private getSession(sid: string): Session | null {
    const s = this.sessions.get(sid)
    if (!s) return null
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(sid)
      return null
    }
    return s
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [key, s] of this.sessions) {
      if (s.expiresAt < now) this.sessions.delete(key)
    }
  }
}

interface View {
  text: string
  keyboard: InlineKeyboard
}

function renderResultsPage(sid: string, session: Session): View {
  const totalPages = Math.max(1, Math.ceil(session.results.length / PAGE_SIZE))
  const page = session.page
  const startIdx = page * PAGE_SIZE
  const items = session.results.slice(startIdx, startIdx + PAGE_SIZE)

  const lines: string[] = [`🔎 «${session.query}» — ${session.results.length} результатов`, '']
  items.forEach((r, i) => {
    const num = startIdx + i + 1
    const src = r.source === 'spotify' ? 'Spotify' : 'Yandex'
    const dur = r.durationSec !== null ? ` · ${formatDuration(r.durationSec)}` : ''
    lines.push(`${num}. ${r.artists} — ${r.title}`)
    lines.push(`    ${src}${dur}`)
  })

  const kb = new InlineKeyboard()
  items.forEach((_, i) => {
    const absIdx = startIdx + i
    kb.text(`${absIdx + 1}`, `st|${sid}|${absIdx}`)
  })
  kb.row()

  const hasPrev = page > 0
  const hasNext = page < totalPages - 1
  // Disabled arrows call back with the current page → answerCallbackQuery без изменений.
  kb.text(hasPrev ? '⬅' : '·', hasPrev ? `sp|${sid}|${page - 1}` : `sp|${sid}|${page}`)
  kb.text(`${page + 1}/${totalPages}`, `sp|${sid}|${page}`)
  kb.text(hasNext ? '➡' : '·', hasNext ? `sp|${sid}|${page + 1}` : `sp|${sid}|${page}`)
  kb.row()
  kb.text('✕ Закрыть', `sx|${sid}`)

  return { text: lines.join('\n'), keyboard: kb }
}

function renderTrackDetail(sid: string, r: SearchResult, page: number): View {
  const dur = r.durationSec !== null ? ` · ${formatDuration(r.durationSec)}` : ''
  const src = r.source === 'spotify' ? 'Spotify' : 'Yandex'
  const text =
    `🎵 ${r.artists} — ${r.title}\n` +
    `${src}${dur}${r.album ? ` · ${r.album}` : ''}`

  const kb = new InlineKeyboard()
  if (r.source === 'spotify') {
    kb.text('🎵 Скачать MP3 320', `sd|s|${r.trackId}`)
  } else {
    const suffix = `${r.trackId}|${r.albumId ?? ''}`
    kb.text('🎵 M4A', `sd|y|h|${suffix}`).text('💿 FLAC', `sd|y|l|${suffix}`)
  }
  kb.row()
  kb.text('⬅ К результатам', `sb|${sid}|${page}`)

  return { text, keyboard: kb }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
