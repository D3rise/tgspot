import { spawn } from 'child_process'
import { mkdir, readdir, rm, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'
import path from 'path'
import os from 'os'
import {
  DownloadAuthError,
  DownloadError,
  DownloadOptions,
  DownloadResult,
  ProgressListener,
  TrackDownloader,
  YandexQuality,
} from './downloader-types'

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac'])
const AUTH_KEYWORDS = ['unauthorized', 'invalid token', 'bad token', 'auth', 'oauth']
const TRACK_PROGRESS_RE = /^\s*\[(\d+)\/(\d+)\]\s/m
// yandex-music-downloader печатает по строке на трек — 5 минут молчания
// означает, что процесс завис (сетевой стол, зависший HTTP-запрос).
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

const ALBUM_PATH_PATTERN = '#number-padded - #track-artist - #title'
const TRACK_PATH_PATTERN = '#track-artist - #title'

const QUALITY_ARG: Record<YandexQuality, string> = {
  high: '1',      // AAC 192 kbps, .m4a
  lossless: '2',  // FLAC (native or flac-in-mp4, we remux the latter)
}

export class YandexDownloader implements TrackDownloader {
  constructor(private readonly token: string) {}

  async downloadWithRetry(url: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
    const attempts = opts.attempts ?? 2
    const quality: YandexQuality = opts.quality ?? 'lossless'
    let lastErr: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.download(url, quality, opts.onProgress)
      } catch (err) {
        lastErr = err
        if (err instanceof DownloadAuthError) throw err
        console.warn(
          `[yandex-downloader] attempt ${attempt}/${attempts} failed for ${url}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    throw lastErr
  }

  private async download(
    url: string,
    quality: YandexQuality,
    onProgress?: ProgressListener,
  ): Promise<DownloadResult> {
    const workDir = path.join(os.tmpdir(), 'tgspot', randomUUID())
    await mkdir(workDir, { recursive: true })

    try {
      await this.spawnCli(workDir, url, quality, onProgress)
    } catch (err) {
      await this.cleanup(workDir).catch(() => undefined)
      throw err
    }

    const rawFiles = (await this.collectAudio(workDir)).sort()
    if (rawFiles.length === 0) {
      await this.cleanup(workDir).catch(() => undefined)
      throw new DownloadError('yandex-music-downloader finished but produced no audio files')
    }

    // Only remux to native FLAC for the lossless path — 'high' should stay as .m4a.
    const files =
      quality === 'lossless'
        ? await Promise.all(rawFiles.map((f) => this.normalizeContainer(f)))
        : rawFiles
    return { workDir, files }
  }

  async cleanup(workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true })
  }

  // Yandex сейчас часто отдаёт lossless как codec="flac-mp4" — это настоящий
  // FLAC, но в MP4-контейнере, и yandex-music-downloader сохраняет его как
  // .m4a. Перепаковываем в нативный .flac без перекодирования (-c copy),
  // тогда Telegram узнаёт FLAC и мы отдаём его как lossless-документ.
  private async normalizeContainer(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase()
    if (ext !== '.m4a') return filePath

    let codec: string | null
    try {
      codec = await this.probeAudioCodec(filePath)
    } catch (err) {
      console.warn(
        `[yandex-downloader] codec probe failed for ${path.basename(filePath)}:`,
        (err as Error).message,
      )
      return filePath
    }

    console.log(`[yandex-downloader] ${path.basename(filePath)} → audio codec=${codec ?? '?'}`)
    if (codec !== 'flac') return filePath

    const flacPath = filePath.slice(0, -ext.length) + '.flac'
    try {
      await this.remuxToFlac(filePath, flacPath)
      await unlink(filePath).catch(() => undefined)
      console.log(`[yandex-downloader] remuxed FLAC-in-MP4 → ${path.basename(flacPath)}`)
      return flacPath
    } catch (err) {
      console.warn(
        `[yandex-downloader] remux failed for ${path.basename(filePath)}, keeping .m4a:`,
        (err as Error).message,
      )
      await unlink(flacPath).catch(() => undefined)
      return filePath
    }
  }

  private probeAudioCodec(filePath: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]
      const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += c.toString()))
      child.stderr.on('data', (c) => (err += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err.trim()}`))
        resolve(out.trim() || null)
      })
    })
  }

  private remuxToFlac(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-y', '-loglevel', 'error',
        '-i', input,
        '-map', '0:a:0',
        '-map', '0:v?',
        '-c', 'copy',
        '-disposition:v:0', 'attached_pic',
        '-map_metadata', '0',
        output,
      ]
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (c) => (err += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg remux exited ${code}: ${err.trim()}`))
      })
    })
  }

  private spawnCli(
    workDir: string,
    url: string,
    quality: YandexQuality,
    onProgress: ProgressListener | undefined,
  ): Promise<void> {
    const pattern = url.includes('/track/') ? TRACK_PATH_PATTERN : ALBUM_PATH_PATTERN
    const args = [
      '--token', this.token,
      '--url', url,
      '--dir', workDir,
      '--path-pattern', pattern,
      '--quality', QUALITY_ARG[quality],
      '--embed-cover',
      '--only-music',
    ]

    return new Promise((resolve, reject) => {
      const child = spawn('yandex-music-downloader', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
      let stderr = ''
      let stdout = ''
      let progressBuffer = ''
      let lastReportedIndex = -1
      let killedForIdle = false

      let idleTimer: NodeJS.Timeout | null = null
      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }
      const armIdleTimer = () => {
        clearIdleTimer()
        idleTimer = setTimeout(() => {
          killedForIdle = true
          child.kill('SIGKILL')
        }, IDLE_TIMEOUT_MS)
      }
      armIdleTimer()

      const consumeProgress = (chunk: string) => {
        if (!onProgress) return
        progressBuffer += chunk
        const parts = progressBuffer.split(/\n/)
        progressBuffer = parts.pop() ?? ''
        for (const line of parts) {
          const match = line.match(TRACK_PROGRESS_RE)
          if (!match) continue
          const current = parseInt(match[1], 10)
          const total = parseInt(match[2], 10)
          if (current === lastReportedIndex) continue
          lastReportedIndex = current
          const label = total > 1 ? `Трек ${current}/${total}` : 'Скачивание…'
          onProgress({ percent: null, phase: 'download', label })
        }
      }

      child.stdout.on('data', (chunk) => {
        const s = chunk.toString()
        stdout += s
        armIdleTimer()
        consumeProgress(s)
      })
      child.stderr.on('data', (chunk) => {
        const s = chunk.toString()
        stderr += s
        armIdleTimer()
      })
      child.on('error', (err) => {
        clearIdleTimer()
        reject(new DownloadError(`failed to spawn yandex-music-downloader: ${err.message}`))
      })
      child.on('close', (code) => {
        clearIdleTimer()
        if (killedForIdle) {
          return reject(
            new DownloadError(
              `yandex-music-downloader hung: no output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s, killed`,
            ),
          )
        }
        if (code === 0) return resolve()
        const output = `${stdout}\n${stderr}`.toLowerCase()
        const isAuth = AUTH_KEYWORDS.some((k) => output.includes(k))
        const detail = stderr.trim().slice(-500) || stdout.trim().slice(-500)
        const msg = `yandex-music-downloader exited with code ${code}: ${detail}`
        reject(isAuth ? new DownloadAuthError(msg) : new DownloadError(msg))
      })
    })
  }

  private async collectAudio(dir: string): Promise<string[]> {
    const results: string[] = []
    const walk = async (current: string) => {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
          results.push(full)
        }
      }
    }
    await walk(dir)
    return results
  }
}
