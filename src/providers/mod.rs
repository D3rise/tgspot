pub mod search;
pub mod spotify;
pub mod yandex;

use std::time::Duration;

use anyhow::{Result, ensure};
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};

use crate::domain::AuthError;

pub const MAX_AUDIO_BYTES: u64 = 2_000_000_000;

pub fn http_client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent("tgspot/2.0")
        .build()?)
}

pub async fn response(
    response: Result<Response, reqwest::Error>,
    source: &'static str,
) -> Result<Response> {
    let response = response.map_err(|e| e.without_url())?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(AuthError(source).into());
    }
    ensure!(
        response.status().is_success(),
        "{source}: HTTP {}",
        response.status()
    );
    Ok(response)
}

pub async fn cover(client: &Client, url: Option<&str>) -> Option<Vec<u8>> {
    let url = url?;
    if !url.starts_with("https://") {
        return None;
    }
    let response = response(client.get(url).send().await, "Cover").await.ok()?;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.ok()?);
        if bytes.len() > 5_000_000 {
            return None;
        }
    }
    Some(bytes)
}
