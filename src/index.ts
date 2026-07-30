import { loadConfig } from './config'
import { createBotRunner } from './telegram/bot-runner'

async function main(): Promise<void> {
  const config = loadConfig()
  const runner = createBotRunner(config)

  installSignalHandlers(runner)

  console.log('[bot] starting…')
  await runner.start()
}

function installSignalHandlers(runner: { shutdown: () => Promise<void> }): void {
  let shuttingDown = false
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[bot] received ${signal}, shutting down…`)
    runner
      .shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[bot] shutdown failed:', err)
        process.exit(1)
      })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

main().catch((err) => {
  console.error('[bot] fatal:', err)
  process.exit(1)
})
