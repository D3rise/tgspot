import { DownloadAuthError, DownloaderService } from './downloader'
import { AlbumInfoService, AlbumTrack } from './album-info'
import { AdminNotifier } from './admin-notifier'
import { JobReporter } from './job-reporter'
import { SpotifyLink } from '../domain/spotify-link'

const AUTH_ERROR_KEY = 'spotify-auth'

export class DownloadOrchestrator {
  constructor(
    private readonly downloader: DownloaderService,
    private readonly albumInfo: AlbumInfoService,
    private readonly admin: AdminNotifier,
  ) {}

  async handle(link: SpotifyLink, reporter: JobReporter): Promise<void> {
    try {
      if (link.type === 'track') {
        await this.handleTrack(link, reporter)
      } else if (link.type === 'album') {
        await this.handleAlbum(link, reporter)
      } else {
        await reporter.done(`Поддерживаются только треки и альбомы. Получил: ${link.type}.`)
      }
    } finally {
      reporter.stopWorkingIndication()
    }
  }

  private async handleTrack(link: SpotifyLink, reporter: JobReporter): Promise<void> {
    await reporter.progress('⏳ Инициализация…')
    reporter.workingIndication()
    try {
      await this.downloadAndSend(link.url, reporter, (percent) => {
        reporter.progress(`⬇️ Скачивание… ${renderProgressBar(percent)}`).catch(() => undefined)
      })
      await reporter.cancel()
    } catch (err) {
      await this.reportError(err, reporter)
    }
  }

  private async handleAlbum(link: SpotifyLink, reporter: JobReporter): Promise<void> {
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
        await this.downloadAndSend(track.url, reporter, (percent) => {
          reporter.progress(`${prefix} ⬇️ ${renderProgressBar(percent)}`).catch(() => undefined)
        })
      } catch (err) {
        if (err instanceof DownloadAuthError) {
          await this.admin.notifyOnce(AUTH_ERROR_KEY, `⚠️ Spotify auth error: ${err.message.slice(0, 400)}`)
        }
        const reason = describeError(err)
        failed.push({ track, reason })
        console.error(`[album] track failed: ${track.title}: ${reason}`)
      }
      await reporter.progress(`Скачиваю альбом ${albumLabel} (${i + 1}/${tracks.length})…`)
    }

    await reporter.done(buildAlbumSummary(tracks.length, failed))
  }

  private async downloadAndSend(
    url: string,
    reporter: JobReporter,
    onPercent?: (percent: number) => void,
  ): Promise<void> {
    const result = await this.downloader.downloadWithRetry(
      url,
      2,
      onPercent ? (p) => onPercent(p.percent) : undefined,
    )
    try {
      await reporter.sendAudio(result.files[0])
      this.admin.reset(AUTH_ERROR_KEY)
    } finally {
      await this.downloader.cleanup(result.workDir)
    }
  }

  private async reportError(err: unknown, reporter: JobReporter): Promise<void> {
    console.error('[orchestrator] download failed:', err)
    if (err instanceof DownloadAuthError) {
      await this.admin.notifyOnce(AUTH_ERROR_KEY, `⚠️ Spotify auth error: ${err.message.slice(0, 400)}`)
      await reporter.done('Не удалось скачать: проблема с авторизацией Spotify. Админ уведомлён.')
      return
    }
    await reporter.done(`Не удалось скачать: ${describeError(err)}`)
  }
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
