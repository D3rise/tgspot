use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::{Semaphore, watch};

use crate::{
    domain::{Album, AuthError, MusicLink, Quality, Source},
    media::Downloaded,
    providers::{spotify::Spotify, yandex::Yandex},
};

pub struct Downloads {
    pub spotify: Arc<Spotify>,
    pub yandex: Option<Arc<Yandex>>,
    slots: Semaphore,
}

impl Downloads {
    pub fn new(spotify: Arc<Spotify>, yandex: Option<Arc<Yandex>>) -> Self {
        Self {
            spotify,
            yandex,
            slots: Semaphore::new(4),
        }
    }

    pub async fn album(&self, link: &MusicLink) -> Result<Album> {
        match link.source {
            Source::Spotify => self.spotify.album(link).await,
            Source::Yandex => {
                self.yandex
                    .as_ref()
                    .context("Яндекс.Музыка не настроена (нет YANDEX_MUSIC_TOKEN)")?
                    .album(link)
                    .await
            }
        }
    }

    pub async fn track(
        &self,
        link: &MusicLink,
        quality: Quality,
        progress: &watch::Sender<String>,
    ) -> Result<Downloaded> {
        let _permit = self.slots.acquire().await?;
        for attempt in 0..2 {
            progress.send_replace("⏳ Инициализация…".into());
            let result = match link.source {
                Source::Spotify => self.spotify.download(link, progress).await,
                Source::Yandex => {
                    self.yandex
                        .as_ref()
                        .context("Яндекс.Музыка не настроена (нет YANDEX_MUSIC_TOKEN)")?
                        .download(link, quality, progress)
                        .await
                }
            };
            match result {
                Ok(download) => return Ok(download),
                Err(error) if attempt == 0 && !error.is::<AuthError>() => {
                    tracing::warn!(%error, "Retrying track download");
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("second attempt returns a result")
    }
}
