type Task<T> = () => Promise<T>

export class PerUserQueue {
  private readonly chains = new Map<number, Promise<unknown>>()

  enqueue<T>(userId: number, task: Task<T>): Promise<T> {
    const previous = this.chains.get(userId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.chains.set(userId, next)
    const cleanup = () => {
      if (this.chains.get(userId) === next) this.chains.delete(userId)
    }
    next.then(cleanup, cleanup)
    return next
  }

  async drain(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()])
    }
  }
}
