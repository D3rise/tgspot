use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aes::cipher::{KeyIvInit, StreamCipher};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT},
};
use serde_json::Value;
use sha2::Sha256;
use tokio::{io::AsyncWriteExt, sync::watch, time::timeout};

use crate::{
    domain::{Album, AuthError, MusicLink, Quality, Source, Track},
    media::{self, Downloaded, Format},
};

const API: &str = "https://api.music.yandex.net";
// Matches yandex-music-api's Android request signing, not a user's OAuth secret.
const SIGN_KEY: &[u8] = b"p93jhgh689SBReK6ghtw62";
const CODECS: &str = "flac,flac-mp4,mp3,aac,he-aac,aac-mp4,he-aac-mp4";

pub struct Yandex {
    client: Client,
    headers: HeaderMap,
}

impl Yandex {
    pub fn new(token: &str, client: Client) -> Result<Self> {
        let mut headers = HeaderMap::new();
        let mut authorization =
            HeaderValue::from_str(&format!("OAuth {token}")).context("Invalid Yandex token")?;
        authorization.set_sensitive(true);
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(USER_AGENT, HeaderValue::from_static("Yandex-Music-API"));
        headers.insert(
            "X-Yandex-Music-Client",
            HeaderValue::from_static("YandexMusicAndroid/24023621"),
        );
        Ok(Self { client, headers })
    }

    async fn get(&self, path: &str, params: &[(&str, &str)]) -> Result<Value> {
        let response = super::response(
            self.client
                .get(format!("{API}{path}"))
                .headers(self.headers.clone())
                .query(params)
                .send()
                .await,
            "Яндекс.Музыка",
        )
        .await?;
        unwrap_response(response.json().await.map_err(|e| e.without_url())?)
    }

    pub async fn track(&self, link: &MusicLink) -> Result<Track> {
        let result = self.get(&format!("/tracks/{}", link.id), &[]).await?;
        map_track(
            result
                .as_array()
                .and_then(|a| a.first())
                .context("Yandex track not found")?,
            link.album_id.as_deref(),
        )
    }

    pub async fn album(&self, link: &MusicLink) -> Result<Album> {
        let album = self
            .get(&format!("/albums/{}/with-tracks", link.id), &[])
            .await?;
        let volumes = album["volumes"]
            .as_array()
            .context("Yandex album has no volumes")?;
        let mut tracks = Vec::new();
        for volume in volumes {
            for track in volume.as_array().context("Invalid Yandex album volume")? {
                let id = id_string(&track["id"]).context("Yandex album track missing ID")?;
                tracks.push(
                    MusicLink::track(Source::Yandex, &id, Some(&link.id))
                        .context("Invalid Yandex track ID")?,
                );
            }
        }
        ensure!(!tracks.is_empty(), "Yandex album has no tracks");
        Ok(Album {
            label: text(&album, "title").to_owned(),
            tracks,
        })
    }

    pub async fn search(&self, query: &str) -> Result<Vec<Track>> {
        let result = self
            .get(
                "/search",
                &[
                    ("text", query),
                    ("type", "track"),
                    ("nocorrect", "false"),
                    ("page", "0"),
                ],
            )
            .await?;
        Ok(result["tracks"]["results"]
            .as_array()
            .into_iter()
            .flatten()
            .take(8)
            .filter_map(|t| map_track(t, None).ok())
            .collect())
    }

    pub async fn download(
        &self,
        link: &MusicLink,
        quality: Quality,
        progress: &watch::Sender<String>,
    ) -> Result<Downloaded> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs()
            .to_string();
        let quality_name = if quality == Quality::Lossless {
            "lossless"
        } else {
            "nq"
        };
        let signature = sign(&timestamp, &link.id, quality_name);
        let params = [
            ("ts", timestamp.as_str()),
            ("trackId", link.id.as_str()),
            ("quality", quality_name),
            ("codecs", CODECS),
            ("transports", "encraw"),
            ("sign", signature.as_str()),
        ];
        let (track, result) =
            tokio::try_join!(self.track(link), self.get("/get-file-info", &params))?;
        let info = &result["downloadInfo"];
        let codec = info["codec"]
            .as_str()
            .context("Yandex response missing codec")?;
        let format = match codec {
            "flac" | "flac-mp4" => Format::Flac,
            "mp3" => Format::Mp3,
            "aac" | "he-aac" | "aac-mp4" | "he-aac-mp4" => Format::M4a,
            _ => anyhow::bail!("Unsupported Yandex audio codec"),
        };
        let warning = (quality == Quality::Lossless && !matches!(format, Format::Flac))
            .then(|| "⚠️ Яндекс отдал качество ниже запрошенного FLAC.".to_owned());
        let directory = tempfile::Builder::new().prefix("tgspot-").tempdir()?;
        let raw = directory.path().join("source.audio");
        let urls = info["urls"]
            .as_array()
            .context("Yandex response missing audio URLs")?;
        ensure!(!urls.is_empty(), "Yandex returned no audio URLs");
        let key = info["key"].as_str().filter(|s| !s.is_empty());
        let audio = async {
            let mut last_error = anyhow::anyhow!("Yandex returned no valid audio URLs");
            for url in urls.iter().filter_map(Value::as_str) {
                match download_audio(&self.client, url, &raw, key, progress).await {
                    Ok(()) => return Ok(()),
                    Err(error) => last_error = error,
                }
            }
            Err(last_error)
        };
        let (audio, cover) = tokio::join!(
            audio,
            super::cover(&self.client, track.cover_url.as_deref())
        );
        audio?;
        media::finish(directory, track, format, cover, warning, progress).await
    }
}

fn unwrap_response(value: Value) -> Result<Value> {
    if let Some(error) = value.get("error") {
        let name = error["name"].as_str().unwrap_or("");
        if ["unauthorized", "forbidden", "session-expired"].contains(&name) {
            return Err(AuthError("Яндекс.Музыка").into());
        }
        anyhow::bail!("Yandex API returned an error");
    }
    value
        .get("result")
        .cloned()
        .context("Yandex API response missing result")
}

fn sign(timestamp: &str, track_id: &str, quality: &str) -> String {
    let message = format!(
        "{timestamp}{track_id}{quality}{}encraw",
        CODECS.replace(',', "")
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(SIGN_KEY).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    STANDARD_NO_PAD.encode(mac.finalize().into_bytes())
}

fn cipher(key: &str) -> Result<ctr::Ctr128BE<aes::Aes128>> {
    ensure!(
        key.len() == 32 && key.is_ascii(),
        "Invalid Yandex decryption key"
    );
    let mut decoded = [0; 16];
    for (index, byte) in decoded.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&key[index * 2..index * 2 + 2], 16)
            .context("Invalid Yandex decryption key")?;
    }
    Ok(ctr::Ctr128BE::<aes::Aes128>::new(
        &decoded.into(),
        &[0; 16].into(),
    ))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn id_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
}
fn artists(value: &Value) -> String {
    value["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["name"].as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn map_track(value: &Value, album_hint: Option<&str>) -> Result<Track> {
    ensure!(
        value["available"].as_bool() != Some(false),
        "Yandex track unavailable"
    );
    let id = id_string(&value["id"]).context("Yandex track missing ID")?;
    let album = value["albums"].as_array().and_then(|a| {
        a.iter()
            .find(|a| album_hint.is_some_and(|hint| id_string(&a["id"]).as_deref() == Some(hint)))
            .or_else(|| a.first())
    });
    let empty = Value::Null;
    let album = album.unwrap_or(&empty);
    let album_id = id_string(&album["id"]).or_else(|| album_hint.map(str::to_owned));
    let title = text(value, "title");
    let version = text(value, "version");
    let cover = value["coverUri"]
        .as_str()
        .or_else(|| album["coverUri"].as_str())
        .map(|uri| {
            format!(
                "https://{}",
                uri.trim_start_matches("https://").replace("%%", "400x400")
            )
        });
    Ok(Track {
        link: MusicLink::track(Source::Yandex, &id, album_id.as_deref())
            .context("Invalid Yandex track ID")?,
        title: if version.is_empty() {
            title.into()
        } else {
            format!("{title} ({version})")
        },
        artists: artists(value),
        album: text(album, "title").into(),
        album_artist: artists(album),
        year: album["year"].as_i64().and_then(|n| i32::try_from(n).ok()),
        number: album["trackPosition"]["index"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok()),
        disc: album["trackPosition"]["volume"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok()),
        duration: (value["durationMs"].as_u64().unwrap_or(0) / 1000).min(u32::MAX as u64) as u32,
        cover_url: cover,
    })
}

async fn download_audio(
    client: &Client,
    url: &str,
    path: &Path,
    key: Option<&str>,
    progress: &watch::Sender<String>,
) -> Result<()> {
    let mut cipher = key.map(cipher).transpose()?;
    let url = reqwest::Url::parse(url).context("Invalid audio URL")?;
    ensure!(url.scheme() == "https", "Audio URL must use HTTPS");
    let response = client
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.without_url())?;
    let total = response.content_length();
    ensure!(
        total.is_none_or(|n| n <= super::MAX_AUDIO_BYTES),
        "Audio exceeds 2 GB"
    );
    let mut stream = response.bytes_stream();
    let mut output = tokio::fs::File::create(path).await?;
    let mut received = 0u64;
    while let Some(chunk) = timeout(Duration::from_secs(45), stream.next())
        .await
        .context("Audio download stalled")?
    {
        let mut chunk = chunk.map_err(|e| e.without_url())?.to_vec();
        if let Some(cipher) = &mut cipher {
            cipher.apply_keystream(&mut chunk);
        }
        received += chunk.len() as u64;
        ensure!(received <= super::MAX_AUDIO_BYTES, "Audio exceeds 2 GB");
        output.write_all(&chunk).await?;
        let text = total
            .filter(|n| *n > 0)
            .map(|n| format!("⬇️ Скачивание… {}%", received * 100 / n))
            .unwrap_or_else(|| format!("⬇️ Скачивание… {} КБ", received / 1024));
        progress.send_replace(text);
    }
    output.flush().await?;
    ensure!(
        received > 0 && total.is_none_or(|n| n == received),
        "Incomplete audio download"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_metadata_and_preserves_album_context() {
        let track = map_track(
            &json!({"id": 123, "title": "Song", "version": "Live", "durationMs": 183500,
            "artists": [{"name": "Artist"}], "albums": [{"id": 12, "title": "Album", "year": 2024,
                "coverUri": "avatars.yandex.net/%%", "trackPosition": {"index": 2, "volume": 1}}]}),
            Some("12"),
        )
        .unwrap();
        assert_eq!(track.title, "Song (Live)");
        assert_eq!(track.link.album_id.as_deref(), Some("12"));
        assert_eq!(track.duration, 183);
        assert_eq!(track.number, Some(2));
        assert_eq!(
            track.cover_url.as_deref(),
            Some("https://avatars.yandex.net/400x400")
        );
        assert!(
            unwrap_response(json!({"error":{"name":"unauthorized"}}))
                .unwrap_err()
                .is::<AuthError>()
        );
    }

    #[test]
    fn request_signature_matches_python_reference() {
        assert_eq!(
            sign("1700000000", "12345", "lossless"),
            "A8rhGDs/OL1IOCIm7vYn4rj4ieadMfXvKJn2YoqVtoc"
        );
        assert!(cipher(&"я".repeat(16)).is_err());
        assert!(cipher("invalid").is_err());
    }

    #[test]
    fn decrypts_reference_aes_ctr_blocks_across_http_chunk_boundaries() {
        let mut encrypted = [
            0x66, 0xe9, 0x4b, 0xd4, 0xef, 0x8a, 0x2c, 0x3b, 0x88, 0x4c, 0xfa, 0x59, 0xca, 0x34,
            0x2b, 0x2e, 0x58, 0xe2, 0xfc, 0xce, 0xfa, 0x7e, 0x30, 0x61, 0x36, 0x7f, 0x1d, 0x57,
            0xa4, 0xe7, 0x45, 0x5a,
        ];
        let mut cipher = cipher("00000000000000000000000000000000").unwrap();
        for chunk in encrypted.chunks_mut(7) {
            cipher.apply_keystream(chunk);
        }
        assert_eq!(encrypted, [0; 32]);
    }
}
