import { spawn } from 'child_process'
import path from 'path'
import { SearchResult } from '../domain/search-result'

// pipx installs yandex-music-downloader to a predictable venv path; the
// yandex_music package (SDK) is a transitive dep, importable from that venv.
const DEFAULT_PYTHON = '/opt/pipx/venvs/yandex-music-downloader/bin/python'
const DEFAULT_SCRIPT = '/app/scripts/yandex_search.py'
const SEARCH_TIMEOUT_MS = 15_000

interface RawTrack {
  trackId: string
  albumId: string
  title: string
  version: string | null
  artists: string
  album: string | null
  durationSec: number | null
  coverUri: string | null
}

export class YandexSearchService {
  private readonly pythonBin: string
  private readonly scriptPath: string

  constructor(private readonly token: string) {
    this.pythonBin = process.env.YANDEX_SEARCH_PYTHON?.trim() || DEFAULT_PYTHON
    this.scriptPath = process.env.YANDEX_SEARCH_SCRIPT?.trim() || DEFAULT_SCRIPT
  }

  async search(query: string, limit = 8): Promise<SearchResult[]> {
    const raw = await this.spawnPython(['search', query, String(limit)])
    return raw.map((t) => this.mapTrack(t))
  }

  async fetchTrack(trackId: string, albumId?: string): Promise<SearchResult | null> {
    const arg = albumId ? `${trackId}:${albumId}` : trackId
    const raw = await this.spawnPython(['track', arg])
    if (raw.length === 0) return null
    return this.mapTrack(raw[0])
  }

  private mapTrack(t: RawTrack): SearchResult {
    const versionSuffix = t.version ? ` (${t.version})` : ''
    return {
      source: 'yandex',
      trackId: t.trackId,
      albumId: t.albumId,
      title: t.title + versionSuffix,
      artists: t.artists,
      album: t.album,
      durationSec: t.durationSec,
      coverUrl: buildCoverUrl(t.coverUri),
      url: `https://music.yandex.ru/album/${t.albumId}/track/${t.trackId}`,
      hasLossless: true,
    }
  }

  private spawnPython(args: string[]): Promise<RawTrack[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.pythonBin,
        [this.scriptPath, this.token, ...args],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        },
      )

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => (stdout += c.toString()))
      child.stderr.on('data', (c) => (stderr += c.toString()))

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Yandex subprocess timed out after ${SEARCH_TIMEOUT_MS}ms`))
      }, SEARCH_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`Yandex subprocess spawn failed: ${err.message}`))
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          return reject(
            new Error(
              `Yandex subprocess exited with ${code}: ${stderr.trim().slice(0, 300)}`,
            ),
          )
        }
        try {
          const parsed = JSON.parse(stdout || '[]') as RawTrack[]
          resolve(parsed)
        } catch (e) {
          reject(new Error(`Yandex subprocess returned invalid JSON: ${(e as Error).message}`))
        }
      })
    })
  }
}

function buildCoverUrl(coverUri: string | null): string | null {
  if (!coverUri) return null
  const cleaned = coverUri.replace(/%%$/, '300x300')
  return `https://${cleaned}`
}
