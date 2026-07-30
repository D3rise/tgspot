import { spawn } from 'child_process'
import { mkdir, readdir, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import path from 'path'
import os from 'os'

export class DownloadAuthError extends Error {}
export class DownloadError extends Error {}

export interface DownloadResult {
  workDir: string
  files: string[]
}

export interface DownloadProgress {
  percent: number
}

export type ProgressListener = (progress: DownloadProgress) => void

const AUTH_KEYWORDS = ['credentials', 'unauthorized', 'auth', 'login', 'token expired', 'premium']
const PROGRESS_RE = /(\d{1,3})%/

export class DownloaderService {
  constructor(private readonly credentialsPath: string) {}

  async download(url: string, onProgress?: ProgressListener): Promise<DownloadResult> {
    const workDir = path.join(os.tmpdir(), 'tgspot', randomUUID())
    await mkdir(workDir, { recursive: true })

    try {
      await this.spawnZotify(workDir, url, onProgress)
    } catch (err) {
      await this.cleanup(workDir).catch(() => undefined)
      throw err
    }

    const files = (await this.collectMp3s(workDir)).sort()
    if (files.length === 0) {
      await this.cleanup(workDir).catch(() => undefined)
      throw new DownloadError('zotify finished but produced no .mp3 files')
    }
    return { workDir, files }
  }

  async downloadWithRetry(
    url: string,
    attempts = 2,
    onProgress?: ProgressListener,
  ): Promise<DownloadResult> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.download(url, onProgress)
      } catch (err) {
        lastErr = err
        if (err instanceof DownloadAuthError) throw err
        console.warn(
          `[downloader] attempt ${attempt}/${attempts} failed for ${url}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    throw lastErr
  }

  async cleanup(workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true })
  }

  private spawnZotify(
    workDir: string,
    url: string,
    onProgress: ProgressListener | undefined,
  ): Promise<void> {
    const wantProgress = onProgress !== undefined
    const args = [
      '--creds', this.credentialsPath,
      '--save-credentials', 'True',
      '--root-path', workDir,
      '--output-single', '{artist} - {song_name}',
      '--output-album', '{artist} - {song_name}',
      '--codec', 'mp3',
      '--download-quality', 'very_high',
      '--bitrate', '320',
      '--disable-song-archive', 'True',
      '--disable-directory-archives', 'True',
      '--skip-existing', 'False',
      '--skip-previously-downloaded', 'False',
      '--optimized-downloading', 'True',
      '--bulk-wait-time', '0',
      '--download-rate-limiter', '0',
      '--chunk-size', '131072',
      '--retry-attempts', '3',
      '--print-splash', 'False',
      '--print-progress-info', 'False',
      '--print-download-progress', wantProgress ? 'True' : 'False',
      '--print-downloads', 'False',
      '--print-url-progress', 'False',
      '--print-album-progress', 'False',
      '--print-playlist-progress', 'False',
      '-ns',
      url,
    ]

    return new Promise((resolve, reject) => {
      const child = spawn('zotify', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
      let stderr = ''
      let stdout = ''
      let progressBuffer = ''
      let lastReportedPercent = -1

      const consumeProgress = (chunk: string) => {
        if (!onProgress) return
        progressBuffer += chunk
        const parts = progressBuffer.split(/[\r\n]/)
        progressBuffer = parts.pop() ?? ''
        for (const part of parts) {
          const match = part.match(PROGRESS_RE)
          if (!match) continue
          const percent = Math.min(100, Math.max(0, parseInt(match[1], 10)))
          if (percent === lastReportedPercent) continue
          lastReportedPercent = percent
          onProgress({ percent })
        }
      }

      child.stdout.on('data', (chunk) => {
        const s = chunk.toString()
        stdout += s
        consumeProgress(s)
      })
      child.stderr.on('data', (chunk) => {
        const s = chunk.toString()
        stderr += s
        consumeProgress(s)
      })
      child.on('error', (err) => reject(new DownloadError(`failed to spawn zotify: ${err.message}`)))
      child.on('close', (code) => {
        if (code === 0) return resolve()
        const output = `${stdout}\n${stderr}`.toLowerCase()
        const isAuth = AUTH_KEYWORDS.some((k) => output.includes(k))
        const detail = stderr.trim().slice(-500) || stdout.trim().slice(-500)
        const msg = `zotify exited with code ${code}: ${detail}`
        reject(isAuth ? new DownloadAuthError(msg) : new DownloadError(msg))
      })
    })
  }

  private async collectMp3s(dir: string): Promise<string[]> {
    const results: string[] = []
    const walk = async (current: string) => {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) results.push(full)
      }
    }
    await walk(dir)
    return results
  }
}
