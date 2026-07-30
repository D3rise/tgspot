import { InputFile } from 'grammy'
import type { Context } from 'grammy'
import { readFile } from 'fs/promises'
import path from 'path'
import { JobReporter } from '../services/job-reporter'
import { MetadataService } from '../services/metadata'

const CHAT_ACTION_INTERVAL_MS = 4000
const STATUS_THROTTLE_MS = 1000

export class TelegramJobReporter implements JobReporter {
  private statusMessageId: number | null = null
  private statusText: string | null = null
  private chatActionTimer: NodeJS.Timeout | null = null
  private pendingStatusText: string | null = null
  private pendingStatusTimer: NodeJS.Timeout | null = null
  private lastStatusEditAt = 0

  constructor(
    private readonly ctx: Context,
    private readonly metadata: MetadataService,
  ) {}

  async progress(text: string): Promise<void> {
    this.pendingStatusText = text
    if (this.pendingStatusTimer !== null) return
    const elapsed = Date.now() - this.lastStatusEditAt
    if (elapsed >= STATUS_THROTTLE_MS) {
      await this.flushPendingStatus()
    } else {
      this.pendingStatusTimer = setTimeout(() => {
        this.flushPendingStatus().catch(() => undefined)
      }, STATUS_THROTTLE_MS - elapsed)
    }
  }

  async done(text: string): Promise<void> {
    this.stopWorkingIndication()
    this.cancelPendingStatus()
    await this.upsertStatus(text)
    this.lastStatusEditAt = Date.now()
  }

  async cancel(): Promise<void> {
    this.stopWorkingIndication()
    this.cancelPendingStatus()
    if (this.statusMessageId === null || this.ctx.chat === undefined) return
    try {
      await this.ctx.api.deleteMessage(this.ctx.chat.id, this.statusMessageId)
    } catch {
      /* ignore */
    }
    this.statusMessageId = null
  }

  private cancelPendingStatus(): void {
    if (this.pendingStatusTimer !== null) {
      clearTimeout(this.pendingStatusTimer)
      this.pendingStatusTimer = null
    }
    this.pendingStatusText = null
  }

  private async flushPendingStatus(): Promise<void> {
    this.pendingStatusTimer = null
    const text = this.pendingStatusText
    this.pendingStatusText = null
    if (text === null) return
    this.lastStatusEditAt = Date.now()
    await this.upsertStatus(text)
  }

  async sendAudio(filePath: string): Promise<void> {
    const meta = await this.metadata.extract(filePath)
    const audio = new InputFile(await readFile(filePath), path.basename(filePath))
    const thumbnail = meta.thumbnailPath
      ? new InputFile(await readFile(meta.thumbnailPath), path.basename(meta.thumbnailPath))
      : undefined
    await this.ctx.replyWithAudio(audio, {
      title: meta.title,
      performer: meta.performer,
      duration: meta.durationSec ?? undefined,
      thumbnail,
    })
  }

  workingIndication(): void {
    this.fireChatAction()
    if (this.chatActionTimer !== null) return
    this.chatActionTimer = setInterval(() => this.fireChatAction(), CHAT_ACTION_INTERVAL_MS)
  }

  stopWorkingIndication(): void {
    if (this.chatActionTimer === null) return
    clearInterval(this.chatActionTimer)
    this.chatActionTimer = null
  }

  private fireChatAction(): void {
    this.ctx.replyWithChatAction('upload_document').catch(() => undefined)
  }

  private async upsertStatus(text: string): Promise<void> {
    if (this.statusText === text) return
    this.statusText = text

    if (this.statusMessageId === null) {
      const msg = await safeReply(this.ctx, text)
      if (msg) this.statusMessageId = msg.message_id
      return
    }
    if (this.ctx.chat === undefined) return
    try {
      await this.ctx.api.editMessageText(this.ctx.chat.id, this.statusMessageId, text)
    } catch {
      /* editing failures (message too old, identical text, etc.) are non-fatal */
    }
  }
}

export async function safeReply(ctx: Context, text: string) {
  try {
    return await ctx.reply(text, {
      reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
    })
  } catch (err) {
    console.error('[bot] reply failed:', err instanceof Error ? err.message : err)
    return null
  }
}
