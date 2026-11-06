use std::{
    io::{Read, Seek, SeekFrom, Write},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use librespot_audio::{AudioDecrypt, AudioFile};
use librespot_core::{
    Session, SpotifyUri, authentication::Credentials, config::SessionConfig, error::ErrorKind,
};
use librespot_metadata::{
    Album as SpotifyAlbum, Metadata, Track as SpotifyTrack, audio::AudioFileFormat,
};
use reqwest::Client;
use tokio::{
    sync::{Mutex, watch},
    time::timeout,
};

use crate::{
    domain::{Album, AuthError, MusicLink, Source, Track},
    media::{self, Downloaded, Format},
};

pub struct Spotify {
    credentials: Credentials,
    session: Mutex<Option<Session>>,
    client: Client,
}

fn spotify_error(error: librespot_core::Error) -> anyhow::Error {
    match error.kind {
        ErrorKind::Unauthenticated | ErrorKind::PermissionDenied => AuthError("Spotify").into(),
        _ => anyhow::anyhow!("Spotify: {error}"),
    }
}

impl Spotify {
    pub fn new(credentials_json: &str, client: Client) -> Result<Self> {
        let credentials: Credentials = serde_json::from_str(credentials_json).map_err(|_| {
            anyhow::anyhow!("Invalid SPOTIFY_CREDENTIALS_JSON; expected native librespot JSON")
        })?;
        ensure!(
            !credentials.auth_data.is_empty(),
            "SPOTIFY_CREDENTIALS_JSON has empty auth_data"
        );
        Ok(Self {
            credentials,
            session: Mutex::new(None),
            client,
        })
    }

    async fn session(&self) -> Result<Session> {
        let mut cached = self.session.lock().await;
        if let Some(session) = cached.as_ref().filter(|s| !s.is_invalid()) {
            return Ok(session.clone());
        }
        let session = Session::new(SessionConfig::default(), None);
        timeout(
            Duration::from_secs(60),
            session.connect(self.credentials.clone(), false),
        )
        .await
        .context("Spotify connection timed out")?
        .map_err(spotify_error)?;
        *cached = Some(session.clone());
        Ok(session)
    }

    async fn metadata(&self, link: &MusicLink) -> Result<SpotifyTrack> {
        let session = self.session().await?;
        let uri: SpotifyUri = SpotifyUri::from_uri(&format!("spotify:track:{}", link.id))?;
        timeout(Duration::from_secs(45), SpotifyTrack::get(&session, &uri))
            .await
            .context("Spotify metadata timed out")?
            .map_err(spotify_error)
    }

    pub async fn track(&self, link: &MusicLink) -> Result<Track> {
        map_track(&self.metadata(link).await?)
    }

    pub async fn album(&self, link: &MusicLink) -> Result<Album> {
        let session = self.session().await?;
        let uri: SpotifyUri = SpotifyUri::from_uri(&format!("spotify:album:{}", link.id))?;
        let album = timeout(Duration::from_secs(45), SpotifyAlbum::get(&session, &uri))
            .await
            .context("Spotify album metadata timed out")?
            .map_err(spotify_error)?;
        let tracks = album
            .tracks()
            .map(|uri| {
                let id = uri.to_id()?;
                MusicLink::track(Source::Spotify, &id, None).context("Invalid Spotify track ID")
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(!tracks.is_empty(), "Spotify album has no tracks");
        Ok(Album {
            label: album.name,
            tracks,
        })
    }

    pub async fn download(
        &self,
        link: &MusicLink,
        progress: &watch::Sender<String>,
    ) -> Result<Downloaded> {
        let session = self.session().await?;
        let original = self.metadata(link).await?;
        let metadata = map_track(&original)?;
        let mut track = original;
        if !track.files.contains_key(&AudioFileFormat::OGG_VORBIS_320) {
            for uri in track.alternatives.clone().iter() {
                let alternative =
                    timeout(Duration::from_secs(45), SpotifyTrack::get(&session, uri))
                        .await
                        .context("Spotify alternative metadata timed out")?
                        .map_err(spotify_error)?;
                if alternative
                    .files
                    .contains_key(&AudioFileFormat::OGG_VORBIS_320)
                {
                    track = alternative;
                    break;
                }
            }
        }
        let file_id = *track.files.get(&AudioFileFormat::OGG_VORBIS_320).context(
            "Spotify 320 kbps stream unavailable; Premium or regional availability required",
        )?;
        let SpotifyUri::Track { id } = track.id else {
            anyhow::bail!("Invalid Spotify metadata URI")
        };
        let key = timeout(
            Duration::from_secs(45),
            session.audio_key().request(id, file_id),
        )
        .await
        .context("Spotify audio key timed out")?
        .map_err(spotify_error)?;
        let file = timeout(
            Duration::from_secs(45),
            AudioFile::open(&session, file_id, 40_000),
        )
        .await
        .context("Spotify audio request timed out")?
        .map_err(spotify_error)?;
        let length = file.get_stream_loader_controller()?.len();
        ensure!(
            length > 0 && length as u64 <= super::MAX_AUDIO_BYTES,
            "Invalid Spotify audio size"
        );
        let directory = tempfile::Builder::new().prefix("tgspot-").tempdir()?;
        let path = directory.path().join("source.audio");
        let progress = progress.clone();
        // Keep the TempDir in the blocking task: cancellation must not delete a file still being written.
        let copying = tokio::task::spawn_blocking(move || -> Result<_> {
            let mut source = AudioDecrypt::new(Some(key), file);
            // Spotify's first Ogg packet contains proprietary normalization data.
            source.seek(SeekFrom::Start(0xa7))?;
            let mut output = std::fs::File::create(path)?;
            let mut buffer = [0u8; 128 * 1024];
            let mut received = 0usize;
            loop {
                let size = source
                    .read(&mut buffer)
                    .context("Spotify audio download failed")?;
                if size == 0 {
                    break;
                }
                output.write_all(&buffer[..size])?;
                received += size;
                progress.send_replace(format!(
                    "⬇️ Скачивание… {}%",
                    (received + 0xa7) * 100 / length
                ));
            }
            ensure!(
                received + 0xa7 == length,
                "Incomplete Spotify audio download"
            );
            output.flush()?;
            Ok((directory, progress))
        });
        let (copy, cover) = tokio::join!(
            copying,
            super::cover(&self.client, metadata.cover_url.as_deref())
        );
        let (directory, progress) = copy??;
        media::finish(
            directory,
            metadata,
            Format::SpotifyMp3,
            cover,
            None,
            &progress,
        )
        .await
    }
}

fn map_track(track: &SpotifyTrack) -> Result<Track> {
    let id = track.id.to_id()?;
    Ok(Track {
        link: MusicLink::track(Source::Spotify, &id, None).context("Invalid Spotify track ID")?,
        title: track.name.clone(),
        artists: track
            .artists
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        album: track.album.name.clone(),
        album_artist: track
            .album
            .artists
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        year: Some(track.album.date.year()),
        number: u32::try_from(track.number).ok(),
        disc: u32::try_from(track.disc_number).ok(),
        duration: u32::try_from(track.duration).unwrap_or(0) / 1000,
        cover_url: track
            .album
            .covers
            .first()
            .map(|c| format!("https://i.scdn.co/image/{}", c.id)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_credentials_need_no_file_and_invalid_values_stay_private() {
        let json = r#"{"username":"test","auth_type":1,"auth_data":"YWJj"}"#;
        let spotify = Spotify::new(json, Client::new()).unwrap();
        assert_eq!(spotify.credentials.auth_data, b"abc");
        assert!(Spotify::new(r#"{"username":"test","type":"AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS","credentials":"YWJj"}"#, Client::new()).is_err());
        let error = Spotify::new(r#"{"auth_data":"private-value"}"#, Client::new())
            .err()
            .unwrap();
        assert!(!format!("{error:?}").contains("private-value"));
    }
}
