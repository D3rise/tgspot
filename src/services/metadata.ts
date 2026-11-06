import { spawn } from 'child_process'
import path from 'path'

export interface TrackMetadata {
  title: string
  performer: string
  album: string | null
  year: string | null
  durationSec: number | null
  thumbnailPath: string | null
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
}

interface FfprobeFormat {
  duration?: string
  tags?: Record<string, string>
}

interface FfprobeOutput {
  format?: FfprobeFormat
  streams?: FfprobeStream[]
}

export class MetadataService {
  async extract(filePath: string): Promise<TrackMetadata> {
    const info = await this.probe(filePath).catch((err) => {
      console.warn(`[metadata] ffprobe failed for ${filePath}:`, err.message)
      return {} as FfprobeOutput
    })
    const tags = this.mergeTags(info)
    const durationRaw = info.format?.duration
    const durationSec =
      durationRaw && !Number.isNaN(parseFloat(durationRaw))
        ? Math.round(parseFloat(durationRaw))
        : null
    const { title, performer } = this.resolveTitleAndPerformer(tags, filePath)
    const cover = this.pickCoverStream(info.streams)
    const thumbnailPath = cover
      ? await this.extractCover(filePath, cover).catch((err) => {
          console.warn(`[metadata] cover extract failed for ${filePath}:`, err.message)
          return null
        })
      : null

    const result: TrackMetadata = {
      title,
      performer,
      album: tags.album?.trim() || null,
      year: (tags.date?.slice(0, 4) || tags.year || tags.originalyear || '').trim() || null,
      durationSec,
      thumbnailPath,
    }
    console.log(
      `[metadata] ${path.basename(filePath)} → title="${result.title}" performer="${result.performer}" cover=${thumbnailPath ? 'yes' : 'no'} duration=${durationSec ?? '?'}s`,
    )
    return result
  }

  private mergeTags(info: FfprobeOutput): Record<string, string> {
    const merged: Record<string, string> = {}
    const consume = (t?: Record<string, string>) => {
      if (!t) return
      for (const [k, v] of Object.entries(t)) merged[k.toLowerCase()] = v
    }
    consume(info.format?.tags)
    for (const s of info.streams ?? []) consume(s.tags)
    return merged
  }

  private resolveTitleAndPerformer(
    tags: Record<string, string>,
    filePath: string,
  ): { title: string; performer: string } {
    const tagTitle = tags.title?.trim()
    const tagArtist = (tags.artist || tags.album_artist)?.trim()
    if (tagTitle && tagArtist) return { title: tagTitle, performer: tagArtist }

    const base = path.basename(filePath, path.extname(filePath))
    if (base.includes(' - ')) {
      const parts = base.split(' - ').map((p) => p.trim()).filter(Boolean)
      // filename shape: "<number> - Artist - Title" or "Artist - Title"
      const [maybeArtistPart, ...rest] = parts.length >= 3 ? parts.slice(1) : parts
      return {
        title: tagTitle || rest.join(' - ').trim() || maybeArtistPart,
        performer: tagArtist || maybeArtistPart,
      }
    }
    return { title: tagTitle || base, performer: tagArtist || 'Unknown Artist' }
  }

  private pickCoverStream(streams: FfprobeStream[] | undefined): FfprobeStream | null {
    if (!streams) return null
    return (
      streams.find(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
      ) ?? null
    )
  }

  private probe(filePath: string): Promise<FfprobeOutput> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format', '-show_streams',
        filePath,
      ]
      const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += c.toString()))
      child.stderr.on('data', (c) => (err += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffprobe exited with ${code}: ${err.trim()}`))
        try {
          resolve(JSON.parse(out) as FfprobeOutput)
        } catch (e) {
          reject(new Error(`ffprobe returned invalid JSON: ${(e as Error).message}`))
        }
      })
    })
  }

  private extractCover(filePath: string, cover: FfprobeStream): Promise<string> {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath, path.extname(filePath))
    // Telegram thumbnail must be ≤ 320px and ≤ 200 KB — resize with ffmpeg.
    const ext = cover.codec_name === 'png' ? 'jpg' : 'jpg' // always output jpg for compactness
    const thumbnailPath = path.join(dir, `${base}.thumb.${ext}`)
    return new Promise((resolve, reject) => {
      const args = [
        '-y', '-loglevel', 'error',
        '-i', filePath,
        '-an',
        '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
        '-vframes', '1',
        '-q:v', '4',
        thumbnailPath,
      ]
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (c) => (stderr += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(thumbnailPath)
        else reject(new Error(`ffmpeg cover extract failed (${code}): ${stderr.trim()}`))
      })
    })
  }
}
