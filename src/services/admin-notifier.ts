import type { Api } from 'grammy'

export class AdminNotifier {
  private chatId: number | null = null
  private readonly deliveredKeys = new Set<string>()

  constructor(
    private readonly api: Api,
    private readonly adminUsername: string | null,
  ) {}

  observe(username: string | null | undefined, chatId: number): void {
    if (!this.adminUsername || !username) return
    if (username.toLowerCase() !== this.adminUsername) return
    if (this.chatId === chatId) return
    this.chatId = chatId
    console.log(`[admin] captured chat id ${chatId} for @${username}`)
  }

  async notifyOnce(key: string, message: string): Promise<void> {
    if (this.deliveredKeys.has(key)) return
    this.deliveredKeys.add(key)
    console.error(`[admin] ${message}`)
    if (this.chatId === null) return
    try {
      await this.api.sendMessage(this.chatId, message)
    } catch (err) {
      console.error('[admin] failed to send admin notification', err)
    }
  }

  reset(key: string): void {
    this.deliveredKeys.delete(key)
  }
}
