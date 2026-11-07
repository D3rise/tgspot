//! Opt-in provider smoke tests. These download one track each; they never contact Telegram.
use anyhow::{Context, Result, ensure};
use tgspot::{
    domain::{MusicLink, Quality, Source},
    media,
    providers::{http_client, spotify::Spotify, yandex::Yandex},
};
use tokio::{process::Command, sync::watch};

#[tokio::test]
#[ignore = "requires Spotify Premium credentials and network access"]
async fn spotify_download() -> Result<()> {
    let provider = Spotify::new(&std::env::var("SPOTIFY_CREDENTIALS_JSON")?, http_client()?)?;
    let id =
        std::env::var("TEST_SPOTIFY_TRACK_ID").unwrap_or_else(|_| "4cOdK2wGLETKBW3PvgPWqT".into());
    let link = MusicLink::track(Source::Spotify, &id, None).context("invalid test track")?;
    let (progress, _) = watch::channel(String::new());
    let file = provider.download(&link, &progress).await?;
    let probe = media::run(
        Command::new("ffprobe")
            .args(["-v", "error", "-show_streams", "-of", "json"])
            .arg(&file.path),
    )
    .await?;
    let probe: serde_json::Value = serde_json::from_slice(&probe)?;
    ensure!(probe["streams"][0]["codec_name"] == "mp3", "Expected MP3");
    ensure!(file.track.duration > 0, "Missing duration");
    Ok(())
}

#[tokio::test]
#[ignore = "requires Yandex Music token/subscription and network access"]
async fn yandex_download() -> Result<()> {
    let provider = Yandex::new(&std::env::var("YANDEX_MUSIC_TOKEN")?, http_client()?)?;
    let track = provider
        .search("Кино Группа крови")
        .await?
        .into_iter()
        .next()
        .context("No search results")?;
    let (progress, _) = watch::channel(String::new());
    for quality in [Quality::Lossless, Quality::High] {
        let file = provider.download(&track.link, quality, &progress).await?;
        let probe = media::run(
            Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                ])
                .arg(&file.path),
        )
        .await?;
        let probe: serde_json::Value = serde_json::from_slice(&probe)?;
        let codec = probe["streams"][0]["codec_name"]
            .as_str()
            .context("Missing codec")?;
        ensure!(
            ["flac", "aac", "mp3"].contains(&codec),
            "Unexpected audio codec"
        );
        ensure!(
            quality != Quality::Lossless || codec == "flac" || file.warning.is_some(),
            "Missing downgrade warning"
        );
        ensure!(
            probe["format"]["tags"]["title"] == file.track.title,
            "Missing title tag"
        );
        ensure!(file.track.duration > 0, "Missing duration");
        eprintln!(
            "Yandex {quality:?}: {codec}, tagged={}, cover={}",
            !file.track.title.is_empty(),
            file.thumbnail.is_some()
        );
    }
    Ok(())
}
