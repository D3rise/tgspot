use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use tempfile::TempDir;
use tokio::{process::Command, sync::watch, time::timeout};

use crate::domain::Track;

#[derive(Debug, Clone, Copy)]
pub enum Format {
    SpotifyMp3,
    Mp3,
    M4a,
    Flac,
}

pub struct Downloaded {
    pub directory: TempDir,
    pub path: PathBuf,
    pub thumbnail: Option<PathBuf>,
    pub track: Track,
    pub quality: String,
    pub warning: Option<String>,
}

impl Downloaded {
    pub fn caption(&self) -> String {
        match &self.warning {
            Some(warning) => format!("{}\n{warning}", self.quality),
            None => self.quality.clone(),
        }
    }
}

pub async fn run(command: &mut Command) -> Result<Vec<u8>> {
    let output = timeout(
        Duration::from_secs(180),
        command.kill_on_drop(true).output(),
    )
    .await
    .context("Audio processing timed out")?
    .context("Cannot start FFmpeg; install ffmpeg")?;
    ensure!(
        output.status.success(),
        "Audio processing failed: {}",
        String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(400)
            .collect::<String>()
    );
    Ok(output.stdout)
}

pub async fn finish(
    directory: TempDir,
    track: Track,
    format: Format,
    cover: Option<Vec<u8>>,
    warning: Option<String>,
    progress: &watch::Sender<String>,
) -> Result<Downloaded> {
    progress.send_replace("⚙️ Обработка аудио и метаданных…".into());
    let raw = directory.path().join("source.audio");
    let thumbnail = if let Some(bytes) = cover {
        let original = directory.path().join("cover.original");
        let thumbnail = directory.path().join("cover.jpg");
        tokio::fs::write(&original, bytes).await?;
        let result = run(Command::new("ffmpeg")
            .args(["-nostdin", "-y", "-v", "error", "-i"])
            .arg(&original)
            .args([
                "-vf",
                "scale=320:320:force_original_aspect_ratio=decrease",
                "-frames:v",
                "1",
                "-q:v",
                "4",
            ])
            .arg(&thumbnail))
        .await;
        match result {
            Ok(_) if tokio::fs::metadata(&thumbnail).await?.len() <= 200_000 => Some(thumbnail),
            _ => {
                tracing::warn!("Could not prepare cover thumbnail");
                None
            }
        }
    } else {
        None
    };
    let extension = match format {
        Format::SpotifyMp3 | Format::Mp3 => "mp3",
        Format::M4a => "m4a",
        Format::Flac => "flac",
    };
    let path = directory.path().join(format!(
        "{}.{}",
        safe_filename(&track.display_name()),
        extension
    ));
    let mut command = Command::new("ffmpeg");
    command
        .args(["-nostdin", "-y", "-v", "error", "-i"])
        .arg(&raw);
    if let Some(cover) = &thumbnail {
        command.arg("-i").arg(cover);
    }
    command.args(["-map", "0:a:0", "-map_metadata", "-1"]);
    match format {
        Format::SpotifyMp3 => {
            command.args(["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"]);
        }
        _ => {
            command.args(["-c:a", "copy"]);
        }
    }
    if thumbnail.is_some() {
        command.args([
            "-map",
            "1:v:0",
            "-c:v",
            "mjpeg",
            "-disposition:v:0",
            "attached_pic",
        ]);
    }
    for (key, value) in [
        ("title", track.title.clone()),
        ("artist", track.artists.clone()),
        ("album", track.album.clone()),
        ("album_artist", track.album_artist.clone()),
        (
            "date",
            track.year.map(|n| n.to_string()).unwrap_or_default(),
        ),
        (
            "track",
            track.number.map(|n| n.to_string()).unwrap_or_default(),
        ),
        (
            "disc",
            track.disc.map(|n| n.to_string()).unwrap_or_default(),
        ),
    ] {
        if !value.is_empty() {
            command.arg("-metadata").arg(format!("{key}={value}"));
        }
    }
    if extension == "m4a" {
        command.args(["-movflags", "+faststart"]);
    }
    command.arg(&path);
    run(&mut command).await?;
    ensure!(
        tokio::fs::metadata(&path).await?.len() > 0,
        "FFmpeg produced an empty file"
    );
    let quality = audio_quality(&path).await?;
    Ok(Downloaded {
        directory,
        path,
        thumbnail,
        track,
        quality,
        warning,
    })
}

async fn audio_quality(path: &Path) -> Result<String> {
    let bytes = run(Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,bit_rate,bits_per_raw_sample,sample_rate",
            "-of",
            "json",
        ])
        .arg(path))
    .await
    .context("Cannot inspect audio quality with ffprobe")?;
    let probe: serde_json::Value = serde_json::from_slice(&bytes)?;
    let stream = &probe["streams"][0];
    let codec = stream["codec_name"]
        .as_str()
        .context("Missing audio codec")?;
    let mut parts = vec![codec.to_uppercase()];
    let field = if codec == "flac" {
        "bits_per_raw_sample"
    } else {
        "bit_rate"
    };
    if let Some(value) = stream[field]
        .as_str()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|&n| n > 0)
    {
        parts.push(if codec == "flac" {
            format!("{value} бит")
        } else {
            format!("{:.0} кбит/с", f64::from(value) / 1000.0)
        });
    }
    if let Some(rate) = stream["sample_rate"]
        .as_str()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|&n| n > 0)
    {
        parts.push(format!("{} кГц", f64::from(rate) / 1000.0));
    }
    Ok(parts.join(" · "))
}

pub fn safe_filename(value: &str) -> String {
    let mut output = String::new();
    for c in value.chars() {
        let c = if c.is_control() || "/\\:*?\"<>|".contains(c) {
            '_'
        } else {
            c
        };
        if output.len() + c.len_utf8() > 220 {
            break;
        }
        output.push(c);
    }
    let output = output.trim().trim_matches('.');
    if output.is_empty() {
        "track".into()
    } else {
        output.into()
    }
}

pub fn is_flac(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "flac")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{MusicLink, Source};

    #[test]
    fn filenames_cannot_escape_directory_and_fit_utf8_filesystems() {
        assert_eq!(safe_filename("../../a\nb\\c"), "_.._a_b_c");
        assert!(safe_filename(&"Я".repeat(300)).len() <= 220);
        assert_eq!(safe_filename(".."), "track");
    }

    #[tokio::test]
    async fn ffmpeg_embeds_metadata_and_produces_mp3() {
        let dir = tempfile::tempdir().unwrap();
        run(Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.1",
                "-f",
                "wav",
            ])
            .arg(dir.path().join("source.audio")))
        .await
        .unwrap();
        let mut track = Track::fallback(MusicLink::track(Source::Yandex, "123", None).unwrap());
        track.title = "Тест".into();
        track.artists = "Artist".into();
        let (progress, _) = watch::channel(String::new());
        let result = finish(dir, track, Format::SpotifyMp3, None, None, &progress)
            .await
            .unwrap();
        assert_eq!(result.quality, "MP3 · 320 кбит/с · 44.1 кГц");
        assert_eq!(result.caption(), result.quality);
        let bytes = run(Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(&result.path))
        .await
        .unwrap();
        let probe: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(probe["format"]["tags"]["title"], "Тест");
        assert_eq!(probe["streams"][0]["codec_name"], "mp3");
        let directory = result.directory.path().to_owned();
        drop(result);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn captions_report_actual_flac_and_aac_quality_before_downgrade_warning() {
        for (codec, format, sample_format) in [
            ("flac", Format::Flac, "s16"),
            ("flac", Format::Flac, "s32"),
            ("aac", Format::M4a, "fltp"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            run(Command::new("ffmpeg")
                .args([
                    "-nostdin",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=0.5:sample_rate=48000",
                    "-c:a",
                    codec,
                    "-sample_fmt",
                    sample_format,
                    "-f",
                    if codec == "flac" { "flac" } else { "adts" },
                ])
                .arg(dir.path().join("source.audio")))
            .await
            .unwrap();
            let track = Track::fallback(MusicLink::track(Source::Yandex, "123", None).unwrap());
            let (progress, _) = watch::channel(String::new());
            let warning = (codec == "aac")
                .then(|| "⚠️ Яндекс отдал качество ниже запрошенного FLAC.".to_owned());
            let file = finish(dir, track, format, None, warning.clone(), &progress)
                .await
                .unwrap();
            if codec == "flac" {
                let bits = if sample_format == "s16" { 16 } else { 24 };
                assert_eq!(file.caption(), format!("FLAC · {bits} бит · 48 кГц"));
            } else {
                assert!(file.quality.starts_with("AAC · "));
                assert!(file.quality.ends_with(" кбит/с · 48 кГц"));
                assert_eq!(
                    file.caption(),
                    format!("{}\n{}", file.quality, warning.unwrap())
                );
            }
        }
    }
}
