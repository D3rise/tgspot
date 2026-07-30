import NodeID3 from 'node-id3'
import { writeFile } from 'fs/promises'
import path from 'path'

export interface TrackMetadata {
  title: string
  performer: string
  album: string | null
  year: string | null
  durationSec: number | null
  thumbnailPath: string | null
}

export class MetadataService {
  async extract(mp3Path: string): Promise<TrackMetadata> {
    const tags = NodeID3.read(mp3Path)
    const { title, performer } = this.resolveTitleAndPerformer(tags, mp3Path)

    return {
      title,
      performer,
      album: tags.album?.trim() || null,
      year: tags.year?.trim() || tags.date?.trim()?.slice(0, 4) || null,
      durationSec: tags.length ? Math.round(Number(tags.length) / 1000) : null,
      thumbnailPath: await this.extractThumbnail(tags, mp3Path),
    }
  }

  private resolveTitleAndPerformer(tags: NodeID3.Tags, mp3Path: string): { title: string; performer: string } {
    const tagTitle = tags.title?.trim()
    const tagArtist = tags.artist?.trim()
    if (tagTitle && tagArtist) return { title: tagTitle, performer: tagArtist }

    const fallbackName = path.basename(mp3Path, '.mp3')
    if (fallbackName.includes(' - ')) {
      const [artistPart, ...rest] = fallbackName.split(' - ')
      return {
        title: tagTitle || rest.join(' - ').trim(),
        performer: tagArtist || artistPart.trim(),
      }
    }
    return { title: tagTitle || fallbackName, performer: tagArtist || 'Unknown Artist' }
  }

  private async extractThumbnail(tags: NodeID3.Tags, mp3Path: string): Promise<string | null> {
    const image = tags.image
    if (!image || typeof image !== 'object' || !('imageBuffer' in image) || !image.imageBuffer) {
      return null
    }
    const ext = image.mime?.includes('png') ? 'png' : 'jpg'
    const thumbnailPath = path.join(
      path.dirname(mp3Path),
      `${path.basename(mp3Path, '.mp3')}.thumb.${ext}`,
    )
    await writeFile(thumbnailPath, image.imageBuffer)
    return thumbnailPath
  }
}
