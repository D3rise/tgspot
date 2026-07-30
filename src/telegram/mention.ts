import type { Context } from 'grammy'

export function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type
  return type === 'group' || type === 'supergroup'
}

export function mentionsBot(ctx: Context): boolean {
  const me = ctx.me
  const meUsername = me.username?.toLowerCase()
  const message = ctx.message
  if (!message) return false

  if (message.reply_to_message?.from?.id === me.id) return true

  const entities = message.entities ?? []
  const text = message.text ?? ''
  const target = meUsername ? `@${meUsername}` : null
  for (const entity of entities) {
    if (entity.type === 'mention' && target) {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase()
      if (mention === target) return true
    } else if (entity.type === 'text_mention' && entity.user?.id === me.id) {
      return true
    }
  }
  return false
}
