import {
  DownloadAuthError,
  DownloadProgress,
  ProgressListener,
  TrackDownloader,
  YandexQuality,
} from './downloader-types'
import { SpotifyDownloader } from './spotify-downloader'
import { YandexDownloader } from './yandex-downloader'
import { AlbumInfoService, AlbumTrack } from './album-info'
import { AdminNotifier } from './admin-notifier'
import { JobReporter } from './job-reporter'
import { MusicLink } from '../domain/music-link'

const SPOTIFY_AUTH_KEY = 'spotify-auth'
const YANDEX_AUTH_KEY = 'yandex-auth'

export class DownloadOrchestrator {
  constructor(
    private readonly spotify: SpotifyDownloader,
    private readonly yandex: YandexDownloader | null,
    private readonly albumInfo: AlbumInfoService,
    private readonly admin: AdminNotifier,
  ) {}

  async handle(
    link: MusicLink,
    reporter: JobReporter,
    opts: { yandexQuality?: YandexQuality } = {},
  ): Promise<void> {
    try {
      if (link.source === 'spotify') {
        await this.handleSpotify(link, reporter)
      } else {
        await this.handleYandex(link, reporter, opts.yandexQuality)
      }
    } finally {
      reporter.stopWorkingIndication()
    }
  }

  private async handleSpotify(link: MusicLink, reporter: JobReporter): Promise<void> {
    if (link.type === 'track') {
      await this.spotifyTrack(link, reporter)
    } else if (link.type === 'album') {
      await this.spotifyAlbum(link, reporter)
    } else {
      await reporter.done(`Поддерживаются только треки и альбомы. Получил: ${link.type}.`)
    }
  }

  private async handleYandex(
    link: MusicLink,
    reporter: JobReporter,
    quality: YandexQuality | undefined,
  ): Promise<void> {
    if (this.yandex === null) {
      await reporter.done(
        'Поддержка Яндекс.Музыки не настроена (нет YANDEX_MUSIC_TOKEN). Обратись к админу.',
      )
      return
    }
    if (link.type !== 'track' && link.type !== 'album') {
      await reporter.done(`Поддерживаются только треки и альбомы. Получил: ${link.type}.`)
      return
    }
    await this.yandexBundle(this.yandex, link, reporter, quality)
  }

  private async spotifyTrack(link: MusicLink, reporter: JobReporter): Promise<void> {
    await reporter.progress('⏳ Инициализация…')
    reporter.workingIndication()
    try {
      await this.downloadAndSendAll(this.spotify, link.url, reporter, (p) => {
        reporter.progress(spotifyProgressLine(p)).catch(() => undefined)
      })
      await reporter.cancel()
    } catch (err) {
      await this.reportError(err, SPOTIFY_AUTH_KEY, reporter)
    }
  }

  private async spotifyAlbum(link: MusicLink, reporter: JobReporter): Promise<void> {
    let tracks: AlbumTrack[]
    let albumLabel: string
    try {
      const info = await this.albumInfo.fetch(link.url)
      tracks = info.tracks
      albumLabel = `${info.artist} — ${info.name}`
    } catch (err) {
      console.error('[album] failed to fetch info:', err)
      await reporter.done('Не удалось получить список треков альбома.')
      return
    }

    await reporter.progress(`Скачиваю альбом ${albumLabel} (0/${tracks.length})…`)

    const failed: Array<{ track: AlbumTrack; reason: string }> = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      const prefix = `Альбом ${albumLabel} (${i + 1}/${tracks.length})`
      reporter.workingIndication()
      await reporter.progress(`${prefix} — ⏳ Инициализация…`)
      try {
        await this.downloadAndSendAll(this.spotify, track.url, reporter, (p) => {
          reporter.progress(`${prefix} ${spotifyProgressLine(p)}`).catch(() => undefined)
        })
      } catch (err) {
        if (err instanceof DownloadAuthError) {
          await this.admin.notifyOnce(
            SPOTIFY_AUTH_KEY,
            `⚠️ Spotify auth error: ${err.message.slice(0, 400)}`,
          )
        }
        const reason = describeError(err)
        failed.push({ track, reason })
        console.error(`[album] track failed: ${track.title}: ${reason}`)
      }
      await reporter.progress(`Скачиваю альбом ${albumLabel} (${i + 1}/${tracks.length})…`)
    }

    await reporter.done(buildAlbumSummary(tracks.length, failed))
  }

  private async yandexBundle(
    yandex: YandexDownloader,
    link: MusicLink,
    reporter: JobReporter,
    quality: YandexQuality | undefined,
  ): Promise<void> {
    await reporter.progress('⏳ Инициализация…')
    reporter.workingIndication()
    const prefix = link.type === 'album' ? 'Альбом (Яндекс)' : 'Трек (Яндекс)'

    let result
    try {
      result = await yandex.downloadWithRetry(link.url, {
        attempts: 2,
        quality,
        onProgress: (p) => {
          reporter.progress(`${prefix} ⬇️ ${p.label ?? 'Скачивание…'}`).catch(() => undefined)
        },
      })
    } catch (err) {
      await this.reportError(err, YANDEX_AUTH_KEY, reporter)
      return
    }

    await reporter.progress(`${prefix} — отправляю ${result.files.length} файл(ов)…`)
    try {
      for (const file of result.files) {
        await reporter.sendAudio(file)
      }
      this.admin.reset(YANDEX_AUTH_KEY)
      await reporter.cancel()
    } catch (err) {
      console.error('[yandex] send failed:', err)
      await reporter.done(`Не удалось отправить файл: ${describeError(err)}`)
    } finally {
      await yandex.cleanup(result.workDir)
    }
  }

  private async downloadAndSendAll(
    downloader: TrackDownloader,
    url: string,
    reporter: JobReporter,
    onProgress?: ProgressListener,
  ): Promise<void> {
    const result = await downloader.downloadWithRetry(url, { attempts: 2, onProgress })
    try {
      for (const file of result.files) {
        await reporter.sendAudio(file)
      }
      this.admin.reset(SPOTIFY_AUTH_KEY)
    } finally {
      await downloader.cleanup(result.workDir)
    }
  }

  private async reportError(err: unknown, authKey: string, reporter: JobReporter): Promise<void> {
    console.error('[orchestrator] download failed:', err)
    if (err instanceof DownloadAuthError) {
      const source = authKey === YANDEX_AUTH_KEY ? 'Яндекс.Музыки' : 'Spotify'
      await this.admin.notifyOnce(authKey, `⚠️ ${source} auth error: ${err.message.slice(0, 400)}`)
      await reporter.done(
        `Не удалось скачать: проблема с авторизацией ${source}. Админ уведомлён.`,
      )
      return
    }
    await reporter.done(`Не удалось скачать: ${describeError(err)}`)
  }
}

function spotifyProgressLine(p: DownloadProgress): string {
  const bar = p.percent !== null ? ` ${renderProgressBar(p.percent)}` : ''
  return `${phaseLabel(p.phase)}${bar}`
}

function phaseLabel(phase: 'download' | 'transcode'): string {
  return phase === 'transcode' ? '⚙️ Транскодирование…' : '⬇️ Скачивание…'
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0].slice(0, 200)
}

const PROGRESS_BAR_LENGTH = 20

function renderProgressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const filled = Math.round((clamped / 100) * PROGRESS_BAR_LENGTH)
  const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_LENGTH - filled)
  return `[${bar}] ${clamped}%`
}

function buildAlbumSummary(
  total: number,
  failed: Array<{ track: AlbumTrack; reason: string }>,
): string {
  const success = total - failed.length
  if (failed.length === 0) return `Готово: ${success}/${total}.`
  const lines = failed.map((f) => `• ${f.track.artists} — ${f.track.title}: ${f.reason}`)
  return `Готово: ${success}/${total}.\nНе удалось:\n${lines.join('\n')}`
}
