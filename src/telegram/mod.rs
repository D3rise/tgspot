pub mod api;
mod handlers;
mod jobs;
pub mod models;
pub mod reporter;
pub mod views;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result};
use serde_json::json;

use crate::{
    config::Config,
    domain::Source,
    providers::{
        http_client,
        search::{Search, SpotifySearch},
        spotify::Spotify,
        yandex::Yandex,
    },
    services::{downloads::Downloads, queue::PerUserQueue},
};
use api::{Api, TelegramError};
use models::{Update, User};
use views::Sessions;

pub struct App {
    config: Config,
    api: Api,
    me: User,
    search: Search,
    downloads: Downloads,
    pub queue: PerUserQueue,
    sessions: Mutex<Sessions>,
    admin: Mutex<Admin>,
}

#[derive(Default)]
struct Admin {
    chat: Option<i64>,
    delivered: HashSet<Source>,
}

impl App {
    pub async fn new(config: Config) -> Result<Arc<Self>> {
        let client = http_client()?;
        let spotify = Arc::new(Spotify::new(
            &config.spotify_credentials_json,
            client.clone(),
        )?);
        let yandex = config
            .yandex_token
            .as_ref()
            .map(|token| Yandex::new(token, client.clone()).map(Arc::new))
            .transpose()?;
        let spotify_search = config
            .spotify_client
            .as_ref()
            .map(|(id, secret)| SpotifySearch::new(client, id.clone(), secret.clone()));
        let api = Api::new(&config.telegram_api_root, &config.bot_token)?;
        let me = serde_json::from_value(api.call("getMe", json!({})).await?)?;
        let app = Arc::new(Self {
            config,
            api,
            me,
            search: Search {
                spotify: spotify.clone(),
                yandex: yandex.clone(),
                spotify_search,
            },
            downloads: Downloads::new(spotify, yandex),
            queue: PerUserQueue::default(),
            sessions: Mutex::default(),
            admin: Mutex::default(),
        });
        tracing::info!(
            username = app.me.username.as_deref().unwrap_or("unknown"),
            search = app.search.enabled(),
            "Bot ready"
        );
        Ok(app)
    }

    pub async fn poll(self: &Arc<Self>) -> Result<()> {
        self.api
            .call("deleteWebhook", json!({"drop_pending_updates":false}))
            .await?;
        let mut offset = 0;
        loop {
            let response = self
                .api
                .call(
                    "getUpdates",
                    json!({"offset":offset,"timeout":25,"limit":100,
                "allowed_updates":["message","inline_query","callback_query"]}),
                )
                .await;
            let result = match response {
                Ok(value) => value,
                Err(error) => {
                    if error
                        .downcast_ref::<TelegramError>()
                        .is_some_and(|e| [401, 403, 409].contains(&e.code))
                    {
                        return Err(error);
                    }
                    tracing::warn!(%error, "Polling failed; retrying");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
            };
            let updates: Vec<Update> =
                serde_json::from_value(result).context("Invalid Telegram update batch")?;
            for update in updates {
                offset = update.update_id + 1;
                if let Err(error) = self.handle(update).await {
                    tracing::error!(%error, "Update handler failed");
                }
            }
        }
    }
}
