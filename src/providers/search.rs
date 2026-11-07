use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::{spotify::Spotify, yandex::Yandex};
use crate::domain::{MusicLink, Source, Track};

pub struct Search {
    pub spotify: Arc<Spotify>,
    pub yandex: Option<Arc<Yandex>>,
    pub spotify_search: Option<SpotifySearch>,
}

impl Search {
    pub fn enabled(&self) -> bool {
        self.spotify_search.is_some() || self.yandex.is_some()
    }

    pub async fn track(&self, link: &MusicLink) -> Result<Track> {
        match link.source {
            Source::Spotify => self.spotify.track(link).await,
            Source::Yandex => {
                self.yandex
                    .as_ref()
                    .context("Яндекс.Музыка не настроена")?
                    .track(link)
                    .await
            }
        }
    }

    pub async fn search(&self, query: &str) -> Result<Vec<Track>> {
        let spotify = async {
            match &self.spotify_search {
                Some(s) => s.search(query).await,
                None => Ok(Vec::new()),
            }
        };
        let yandex = async {
            match &self.yandex {
                Some(s) => s.search(query).await,
                None => Ok(Vec::new()),
            }
        };
        let (spotify, yandex) = tokio::join!(spotify, yandex);
        if spotify.is_err() && (yandex.is_err() || self.yandex.is_none())
            || yandex.is_err() && self.spotify_search.is_none()
        {
            anyhow::bail!("Поиск временно недоступен, попробуй ещё раз.");
        }
        let mut sources = [spotify, yandex].map(|result| match result {
            Ok(items) => items.into_iter(),
            Err(error) => {
                tracing::warn!(%error, "Search provider failed");
                Vec::new().into_iter()
            }
        });
        let mut result = Vec::new();
        for _ in 0..8 {
            for source in &mut sources {
                if let Some(track) = source.next() {
                    result.push(track);
                }
            }
        }
        Ok(result)
    }
}

pub struct SpotifySearch {
    client: Client,
    client_id: String,
    client_secret: String,
    token: Mutex<Option<(String, Instant)>>,
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    expires_in: u64,
}

impl SpotifySearch {
    pub fn new(client: Client, client_id: String, client_secret: String) -> Self {
        Self {
            client,
            client_id,
            client_secret,
            token: Mutex::new(None),
        }
    }

    async fn token(&self) -> Result<String> {
        let mut cached = self.token.lock().await;
        if let Some((token, _)) = cached
            .as_ref()
            .filter(|(_, expiry)| *expiry > Instant::now())
        {
            return Ok(token.clone());
        }
        let response = super::response(
            self.client
                .post("https://accounts.spotify.com/api/token")
                .basic_auth(&self.client_id, Some(&self.client_secret))
                .form(&[("grant_type", "client_credentials")])
                .send()
                .await,
            "Spotify search",
        )
        .await?;
        let token: Token = response.json().await.map_err(|e| e.without_url())?;
        *cached = Some((
            token.access_token.clone(),
            Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60)),
        ));
        Ok(token.access_token)
    }

    pub async fn search(&self, query: &str) -> Result<Vec<Track>> {
        for attempt in 0..2 {
            let token = self.token().await?;
            let response = self
                .client
                .get("https://api.spotify.com/v1/search")
                .bearer_auth(token)
                .query(&[("q", query), ("type", "track"), ("limit", "8")])
                .send()
                .await
                .map_err(|e| e.without_url())?;
            if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                *self.token.lock().await = None;
                continue;
            }
            let response = super::response(Ok(response), "Spotify search").await?;
            let data: Value = response.json().await.map_err(|e| e.without_url())?;
            return Ok(data["tracks"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(map_track)
                .collect());
        }
        unreachable!("second attempt returns a result")
    }
}

fn map_track(value: &Value) -> Option<Track> {
    let link = MusicLink::track(Source::Spotify, value["id"].as_str()?, None)?;
    let album = &value["album"];
    let names = |artists: &Value| {
        artists
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a["name"].as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Some(Track {
        link,
        title: value["name"].as_str()?.into(),
        artists: names(&value["artists"]),
        album: album["name"].as_str().unwrap_or("").into(),
        album_artist: names(&album["artists"]),
        duration: (value["duration_ms"].as_u64().unwrap_or(0) / 1000).min(u32::MAX as u64) as u32,
        cover_url: album["images"]
            .as_array()
            .and_then(|images| {
                images
                    .iter()
                    .find(|i| {
                        i["width"]
                            .as_u64()
                            .is_some_and(|width| (200..=400).contains(&width))
                    })
                    .or_else(|| images.first())
            })
            .and_then(|image| image["url"].as_str())
            .map(str::to_owned),
        year: album["release_date"]
            .as_str()
            .and_then(|s| s.get(..4))
            .and_then(|s| s.parse().ok()),
        number: None,
        disc: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_spotify_search_results_without_optional_metadata() {
        let track = map_track(
            &json!({"id":"0hBUik7RITAPmSlnOGiWdm", "name":"Song", "artists":[{"name":"Artist"}]}),
        )
        .unwrap();
        assert_eq!(track.artists, "Artist");
        assert_eq!(track.cover_url, None);
        assert!(map_track(&json!({"id":"../evil", "name":"Song"})).is_none());
    }
}
