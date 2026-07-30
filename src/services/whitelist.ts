export class WhitelistService {
  constructor(private readonly allowed: ReadonlySet<string>) {}

  isAllowed(username: string | null | undefined): boolean {
    if (!username) return false
    return this.allowed.has(username.toLowerCase())
  }
}
