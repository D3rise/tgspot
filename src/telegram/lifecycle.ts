export class Lifecycle {
  private accepting = true

  stopAccepting(): void {
    this.accepting = false
  }

  isAccepting(): boolean {
    return this.accepting
  }
}
