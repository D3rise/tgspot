import type { Bot, Context } from 'grammy'
import path from 'path'
import { WhitelistService } from '../services/whitelist'
import { PerUserQueue } from '../services/queue'
import { SpotifyDownloader } from '../services/spotify-downloader'
import { YandexDownloader } from '../services/yandex-downloader'
import { MetadataService } from '../services/metadata'
import { AdminNotifier } from '../services/admin-notifier'
import { YandexQuality } from '../services/downloader-types'
import { DmNotOpenError, InlineCallbackReporter } from './inline-reporter'
import { Lifecycle } from './lifecycle'

interface ParsedCallback {
  source: 'spotify' | 'yandex'
  quality: YandexQuality | 'mp3' // spotify=mp3, yandex=high|lossless
  url: string
  label: string // for user-facing status text
}

export function registerInlineCallback(
  bot: Bot,
  whitelist: WhitelistService,
  queue: PerUserQueue,
  spotify: SpotifyDownloader,
  yandex: YandexDownloader | null,
  metadata: MetadataService,
  admin: AdminNotifier,
  lifecycle: Lifecycle,
  storageChatId: number | null,
): void {
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    if (!data.startsWith('dl|')) return next()

    const parsed = parseCallbackData(data)
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'Неверные данные кнопки', show_alert: false })
      return
    }

    if (!whitelist.isAllowed(ctx.from?.username)) {
      await ctx.answerCallbackQuery({ text: '⛔️ Нет доступа', show_alert: true })
      return
    }

    if (!lifecycle.isAccepting()) {
      await ctx.answerCallbackQuery({
        text: 'Бот перезапускается, попробуй через минуту.',
        show_alert: true,
      })
      return
    }

    if (parsed.source === 'yandex' && yandex === null) {
      await ctx.answerCallbackQuery({
        text: 'Яндекс.Музыка не настроена (нет YANDEX_MUSIC_TOKEN).',
        show_alert: true,
      })
      return
    }

    // Inline callback: message context is inline_message_id, not chat.
    const inlineMessageId = ctx.callbackQuery.inline_message_id
    if (!inlineMessageId) {
      await ctx.answerCallbackQuery({
        text: 'Ошибка: нет inline_message_id',
        show_alert: true,
      })
      return
    }

    await ctx.answerCallbackQuery({ text: '⬇️ Скачиваю…' })

    const userId = ctx.from.id
    queue
      .enqueue(userId, () =>
        runInlineDownload(ctx, parsed, inlineMessageId, {
          spotify,
          yandex,
          metadata,
          admin,
          storageChatId,
        }),
      )
      .catch((err) => console.error(`[callback] task failed for user ${userId}:`, err))
  })
}

interface Deps {
  spotify: SpotifyDownloader
  yandex: YandexDownloader | null
  metadata: MetadataService
  admin: AdminNotifier
  storageChatId: number | null
}

async function runInlineDownload(
  ctx: Context,
  parsed: ParsedCallback,
  inlineMessageId: string,
  deps: Deps,
): Promise<void> {
  const userId = ctx.from!.id
  const reporter = new InlineCallbackReporter({
    api: ctx.api,
    inlineMessageId,
    userId,
    storageChatId: deps.storageChatId,
    metadata: deps.metadata,
  })

  await reporter.progress(`⬇️ Скачиваю ${parsed.label}…`)

  try {
    if (parsed.source === 'spotify') {
      const result = await deps.spotify.downloadWithRetry(parsed.url, {
        attempts: 2,
        onProgress: (p) => {
          const phase = p.phase === 'transcode' ? '⚙️ Транскодирование' : '⬇️ Скачивание'
          const pct = p.percent !== null ? ` ${p.percent}%` : ''
          reporter.progress(`${phase}${pct} — ${parsed.label}`).catch(() => undefined)
        },
      })
      try {
        for (const file of result.files) {
          await reporter.sendAudio(file)
        }
        await reporter.cancel()
      } finally {
        await deps.spotify.cleanup(result.workDir)
      }
    } else {
      const yandex = deps.yandex!
      const quality = parsed.quality as YandexQuality
      const result = await yandex.downloadWithRetry(parsed.url, {
        attempts: 2,
        quality,
        onProgress: (p) => {
          reporter.progress(`⬇️ ${p.label ?? 'Скачивание…'} — ${parsed.label}`).catch(() => undefined)
        },
      })
      // Yandex may downgrade to aac even when we ask for lossless — usually
      // because the specific track has no FLAC master or the account isn't
      // entitled to lossless. Detect and tell the user why they got .m4a.
      const captionSuffix =
        quality === 'lossless' &&
        !result.files.every((f) => path.extname(f).toLowerCase() === '.flac')
          ? '⚠️ FLAC не доступен для этого трека — Yandex отдал M4A/AAC.'
          : undefined
      try {
        for (const file of result.files) {
          await reporter.sendAudio(file, { captionSuffix })
        }
        await reporter.cancel()
      } finally {
        await yandex.cleanup(result.workDir)
      }
    }
  } catch (err) {
    if (err instanceof DmNotOpenError) {
      await reporter.done(
        `❌ Открой личный чат с @${ctx.me.username} и нажми Start, потом попробуй снова.`,
      )
      return
    }
    console.error('[callback] download failed:', err)
    const msg = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err)
    await reporter.done(`❌ Не удалось скачать: ${msg}`)
  }
}

function parseCallbackData(data: string): ParsedCallback | null {
  const parts = data.split('|')
  if (parts[0] !== 'dl') return null

  if (parts[1] === 's' && parts.length === 3) {
    const trackId = parts[2]
    if (!trackId) return null
    return {
      source: 'spotify',
      quality: 'mp3',
      url: `https://open.spotify.com/track/${trackId}`,
      label: 'Spotify · MP3 320',
    }
  }

  if (parts[1] === 'y' && parts.length === 5) {
    const [, , q, trackId, albumId] = parts
    if (!trackId || !albumId) return null
    if (q !== 'h' && q !== 'l') return null
    const quality: YandexQuality = q === 'h' ? 'high' : 'lossless'
    return {
      source: 'yandex',
      quality,
      url: `https://music.yandex.ru/album/${albumId}/track/${trackId}`,
      label: `Yandex · ${quality === 'lossless' ? 'FLAC' : 'M4A'}`,
    }
  }

  return null
}
