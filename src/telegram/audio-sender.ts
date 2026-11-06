import { Api, InputFile } from 'grammy'
import type { Message } from 'grammy/types'
import { readFile } from 'fs/promises'
import path from 'path'
import { MetadataService } from '../services/metadata'

export interface SendTrackOptions {
  chatId: number | string
  replyToMessageId?: number
}

export interface SentTrack {
  message: Message
  kind: 'audio' | 'document'
  fileId: string
  displayName: string
}

export async function sendTrackToChat(
  api: Api,
  metadata: MetadataService,
  filePath: string,
  opts: SendTrackOptions,
): Promise<SentTrack> {
  const ext = path.extname(filePath).toLowerCase()
  const meta = await metadata.extract(filePath)
  const displayName = `${meta.performer} — ${meta.title}`
  const fileName = sanitizeFileName(`${displayName}${ext}`)
  const audio = new InputFile(await readFile(filePath), fileName)
  const thumbnail = meta.thumbnailPath
    ? new InputFile(await readFile(meta.thumbnailPath), path.basename(meta.thumbnailPath))
    : undefined
  const replyParams = opts.replyToMessageId
    ? { message_id: opts.replyToMessageId }
    : undefined

  if (ext === '.mp3' || ext === '.m4a' || ext === '.flac') {
    try {
      const msg = await api.sendAudio(opts.chatId, audio, {
        title: meta.title,
        performer: meta.performer,
        duration: meta.durationSec ?? undefined,
        thumbnail,
        reply_parameters: replyParams,
      })
      if (msg.audio) {
        return { message: msg, kind: 'audio', fileId: msg.audio.file_id, displayName }
      }
      // Telegram accepted the file but downgraded to non-audio; fall through
      // to the document branch (this happens for weird containers occasionally).
    } catch (err) {
      console.warn(
        `[audio-sender] sendAudio rejected for ${fileName}, falling back to document:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  const msg = await api.sendDocument(opts.chatId, audio, {
    caption: displayName,
    thumbnail,
    reply_parameters: replyParams,
  })
  if (!msg.document) {
    throw new Error('sendDocument response missing document field')
  }
  return { message: msg, kind: 'document', fileId: msg.document.file_id, displayName }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]+/g, '_').trim() || 'track'
}
