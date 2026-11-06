import type { Bot, Context } from 'grammy'
import { InlineKeyboard, InlineQueryResultBuilder } from 'grammy'
import type { InlineQueryResult } from 'grammy/types'
import { SearchOrchestrator } from '../services/search-orchestrator'
import { SearchResult } from '../domain/search-result'
import { findMusicLink, MusicLink } from '../domain/music-link'
import { WhitelistService } from '../services/whitelist'

const MAX_RESULTS = 20
const CACHE_TIME_SEC = 30

export function registerInlineSearch(
  bot: Bot,
  whitelist: WhitelistService,
  search: SearchOrchestrator,
): void {
  bot.on('inline_query', async (ctx) => {
    try {
      await handle(ctx, whitelist, search)
    } catch (err) {
      console.error('[inline] handler failed:', err)
      await ctx
        .answerInlineQuery([], { cache_time: 5, is_personal: true })
        .catch(() => undefined)
    }
  })
}

async function handle(
  ctx: Context,
  whitelist: WhitelistService,
  search: SearchOrchestrator,
): Promise<void> {
  const iq = ctx.inlineQuery
  if (!iq) return

  if (!whitelist.isAllowed(ctx.from?.username)) {
    await ctx.answerInlineQuery([], {
      cache_time: 5,
      is_personal: true,
      button: { text: '⛔️ Нет доступа', start_parameter: 'no_access' },
    })
    return
  }

  const query = iq.query.trim()
  if (!query) {
    await ctx.answerInlineQuery([], {
      cache_time: 5,
      is_personal: true,
      button: { text: 'Введи название трека или пришли ссылку', start_parameter: 'help' },
    })
    return
  }

  // Link mode — user pasted a Spotify/Yandex URL instead of a search term.
  // Works even when search backends aren't configured, since we can still
  // synthesize a card and let the callback drive the downloader.
  const link = findMusicLink(query)
  if (link) {
    await handleLink(ctx, search, link)
    return
  }

  if (!search.enabled) {
    await ctx.answerInlineQuery([], {
      cache_time: 5,
      is_personal: true,
      button: { text: 'Поиск не настроен', start_parameter: 'no_search' },
    })
    return
  }

  const results = await search.search(query)
  const inlineResults = results.slice(0, MAX_RESULTS).map(buildInlineResult)
  await ctx.answerInlineQuery(inlineResults, {
    cache_time: CACHE_TIME_SEC,
    is_personal: true,
  })
}

async function handleLink(
  ctx: Context,
  search: SearchOrchestrator,
  link: MusicLink,
): Promise<void> {
  if (link.type !== 'track') {
    // Album / playlist / artist inline is not supported — those flows expand to
    // many tracks and don't fit a single inline card.
    await ctx.answerInlineQuery([], {
      cache_time: 5,
      is_personal: true,
      button: {
        text: 'Альбомы/плейлисты — только в личке бота',
        start_parameter: 'album_only_in_dm',
      },
    })
    return
  }

  let result: SearchResult | null = null
  try {
    result = await search.fetchTrackByLink(link)
  } catch (err) {
    console.warn('[inline] track lookup failed:', err instanceof Error ? err.message : err)
  }

  // Fallback: build a minimal card from the URL alone so the user can still
  // trigger the download even if the metadata lookup failed.
  const card = result ?? synthesizeFallback(link)
  if (!card) {
    await ctx.answerInlineQuery([], {
      cache_time: 5,
      is_personal: true,
      button: { text: 'Не смог обработать ссылку', start_parameter: 'link_failed' },
    })
    return
  }

  await ctx.answerInlineQuery([buildInlineResult(card)], {
    cache_time: result ? CACHE_TIME_SEC : 5,
    is_personal: true,
  })
}

// Build a bare-bones SearchResult from a MusicLink so we can offer a download
// button even when the metadata API fetch fails. Requires albumId for Yandex.
function synthesizeFallback(link: MusicLink): SearchResult | null {
  if (link.source === 'spotify') {
    return {
      source: 'spotify',
      trackId: link.id,
      title: 'Скачать по ссылке',
      artists: 'Spotify',
      album: null,
      durationSec: null,
      coverUrl: null,
      url: link.url,
      hasLossless: false,
    }
  }
  const albumMatch = link.url.match(/\/album\/(\d+)\/track\//)
  if (!albumMatch) return null
  return {
    source: 'yandex',
    trackId: link.id,
    albumId: albumMatch[1],
    title: 'Скачать по ссылке',
    artists: 'Yandex Music',
    album: null,
    durationSec: null,
    coverUrl: null,
    url: link.url,
    hasLossless: true,
  }
}

function buildInlineResult(r: SearchResult): InlineQueryResult {
  const id = `${r.source[0]}_${r.trackId}`.slice(0, 64)
  const sourceLabel = r.source === 'spotify' ? 'Spotify' : 'Yandex'
  const durationLabel = r.durationSec !== null ? ` · ${formatDuration(r.durationSec)}` : ''
  const description = `${sourceLabel}${durationLabel}${r.album ? ` · ${r.album}` : ''}`
  const messageText =
    `🎵 ${escapeHtml(r.artists)} — ${escapeHtml(r.title)}\n` +
    `<i>${escapeHtml(sourceLabel + durationLabel)}</i>`

  const builder = InlineQueryResultBuilder.article(id, `${r.artists} — ${r.title}`, {
    description,
    reply_markup: buildKeyboard(r),
    thumbnail_url: r.coverUrl ?? undefined,
  }).text(messageText, { parse_mode: 'HTML' })
  return builder
}

function buildKeyboard(r: SearchResult): InlineKeyboard {
  const kb = new InlineKeyboard()
  if (r.source === 'spotify') {
    kb.text('🎵 Скачать MP3 320', `dl|s|${r.trackId}`)
  } else {
    // Yandex — two buttons
    const suffix = `${r.trackId}|${r.albumId}`
    kb.text('🎵 M4A', `dl|y|h|${suffix}`).text('💿 FLAC', `dl|y|l|${suffix}`)
  }
  return kb
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
