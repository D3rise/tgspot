import type { Api } from 'grammy'
import { GrammyError } from 'grammy'
import { JobReporter, SendAudioOptions } from '../services/job-reporter'
import { MetadataService } from '../services/metadata'
import { sendTrackToChat, SentTrack } from './audio-sender'

const STATUS_THROTTLE_MS = 1000

export class DmNotOpenError extends Error {
  constructor() {
    super("bot can't DM this user")
  }
}

export interface InlineDeliveryConfig {
  api: Api
  inlineMessageId: string
  userId: number                  // fallback DM target
  storageChatId: number | null    // preferred: upload here, then edit inline
  metadata: MetadataService
}

export class InlineCallbackReporter implements JobReporter {
  private lastStatusEditAt = 0
  private pendingText: string | null = null
  private pendingTimer: NodeJS.Timeout | null = null
  private lastText: string | null = null
  // Once we editMessageMedia, the message becomes a media message — no more
  // text edits after that. Track this so `done`/`cancel` don't overwrite.
  private mediaEditDone = false

  constructor(private readonly cfg: InlineDeliveryConfig) {}

  async progress(text: string): Promise<void> {
    if (this.mediaEditDone) return
    this.pendingText = text
    if (this.pendingTimer !== null) return
    const elapsed = Date.now() - this.lastStatusEditAt
    if (elapsed >= STATUS_THROTTLE_MS) {
      await this.flush()
    } else {
      this.pendingTimer = setTimeout(() => {
        this.flush().catch(() => undefined)
      }, STATUS_THROTTLE_MS - elapsed)
    }
  }

  async done(text: string): Promise<void> {
    this.cancelPending()
    if (this.mediaEditDone) return
    await this.editText(text)
    this.lastStatusEditAt = Date.now()
  }

  async cancel(): Promise<void> {
    this.cancelPending()
    if (this.mediaEditDone) return
    // Only reached in DM-fallback flow (media flow already replaced the message).
    await this.editText('✅ Готово, отправил в личку.')
  }

  async sendAudio(filePath: string, opts?: SendAudioOptions): Promise<void> {
    if (this.cfg.storageChatId !== null) {
      await this.deliverViaStorage(filePath, this.cfg.storageChatId, opts?.captionSuffix)
    } else {
      await this.deliverViaDm(filePath, opts?.captionSuffix)
    }
  }

  workingIndication(): void {}
  stopWorkingIndication(): void {}

  private async deliverViaStorage(
    filePath: string,
    storageChatId: number,
    captionSuffix?: string,
  ): Promise<void> {
    let sent: SentTrack
    try {
      sent = await sendTrackToChat(this.cfg.api, this.cfg.metadata, filePath, {
        chatId: storageChatId,
      })
    } catch (err) {
      console.error('[inline-reporter] storage upload failed:', err)
      throw err
    }

    const captionParts = [sent.displayName]
    if (captionSuffix) captionParts.push(captionSuffix)
    const caption = captionParts.join('\n')

    try {
      if (sent.kind === 'audio') {
        await this.cfg.api.editMessageMediaInline(this.cfg.inlineMessageId, {
          type: 'audio',
          media: sent.fileId,
          caption: captionSuffix ? caption : undefined,
        })
      } else {
        await this.cfg.api.editMessageMediaInline(this.cfg.inlineMessageId, {
          type: 'document',
          media: sent.fileId,
          caption,
        })
      }
      this.mediaEditDone = true
    } catch (err) {
      console.error('[inline-reporter] editMessageMedia inline failed:', err)
      await this.editText(
        '❌ Не удалось прикрепить файл к inline-сообщению. ' +
          'Файл остался в служебном канале.',
      ).catch(() => undefined)
      throw err
    }
  }

  private async deliverViaDm(filePath: string, captionSuffix?: string): Promise<void> {
    try {
      const sent = await sendTrackToChat(this.cfg.api, this.cfg.metadata, filePath, {
        chatId: this.cfg.userId,
      })
      if (captionSuffix) {
        // sendAudio for MP3/M4A already has metadata baked in; the suffix is
        // usually a downgrade warning, which is only meaningful for the user.
        // Send it as a follow-up plain message rather than mangling the audio card.
        await this.cfg.api
          .sendMessage(this.cfg.userId, captionSuffix, {
            reply_parameters: { message_id: sent.message.message_id },
          })
          .catch(() => undefined)
      }
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) {
        throw new DmNotOpenError()
      }
      throw err
    }
  }

  private cancelPending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.pendingText = null
  }

  private async flush(): Promise<void> {
    this.pendingTimer = null
    const text = this.pendingText
    this.pendingText = null
    if (text === null) return
    this.lastStatusEditAt = Date.now()
    await this.editText(text)
  }

  private async editText(text: string): Promise<void> {
    if (this.lastText === text) return
    this.lastText = text
    try {
      await this.cfg.api.editMessageTextInline(this.cfg.inlineMessageId, text)
    } catch {
      /* edits fail if message deleted / too old — non-fatal */
    }
  }
}
