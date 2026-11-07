use anyhow::Result;
use tgspot::{config::Config, telegram::App};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("tgspot=info,librespot=warn")),
        )
        .init();
    let app = App::new(Config::from_env()?).await?;
    let result = tokio::select! {
        result = app.poll() => result,
        _ = shutdown() => { tracing::info!("Stopping polling and draining queued downloads"); Ok(()) }
    };
    app.queue.stop();
    app.queue.drain().await;
    result
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("cannot register SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
