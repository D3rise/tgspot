import type { Context } from 'grammy'

export function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type
  return type === 'group' || type === 'supergroup'
}

export function mentionsBot(ctx: Context): boolean {
  const me = ctx.me.username
  if (!me) return false
  const entities = ctx.message?.entities ?? []
  const text = ctx.message?.text ?? ''
  const target = `@${me.toLowerCase()}`
  for (const entity of entities) {
    if (entity.type !== 'mention') continue
    const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase()
    if (mention === target) return true
  }
  return false
}
