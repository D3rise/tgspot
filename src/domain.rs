use std::sync::LazyLock;

use regex::Regex;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    Spotify,
    Yandex,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Self::Spotify => "Spotify",
            Self::Yandex => "Яндекс.Музыка",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Track,
    Album,
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MusicLink {
    pub source: Source,
    pub kind: Kind,
    pub id: String,
    pub album_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Quality {
    High,
    #[default]
    Lossless,
}

impl MusicLink {
    pub fn track(source: Source, id: &str, album_id: Option<&str>) -> Option<Self> {
        if !valid_id(source, id) || album_id.is_some_and(|a| !valid_id(Source::Yandex, a)) {
            return None;
        }
        Some(Self {
            source,
            kind: Kind::Track,
            id: id.into(),
            album_id: album_id.map(str::to_owned),
        })
    }

    pub fn url(&self) -> String {
        match self.source {
            Source::Spotify => format!(
                "https://open.spotify.com/{}/{}",
                if self.kind == Kind::Album {
                    "album"
                } else {
                    "track"
                },
                self.id
            ),
            Source::Yandex if self.kind == Kind::Album => {
                format!("https://music.yandex.ru/album/{}", self.id)
            }
            Source::Yandex => match &self.album_id {
                Some(album) => format!("https://music.yandex.ru/album/{album}/track/{}", self.id),
                None => format!("https://music.yandex.ru/track/{}", self.id),
            },
        }
    }
}

pub fn valid_id(source: Source, id: &str) -> bool {
    match source {
        Source::Spotify => id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric()),
        Source::Yandex => {
            !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

pub fn find_music_link(text: &str) -> Option<MusicLink> {
    static URLS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"https?://[^\s<>\"\[\]]+"#).unwrap());
    URLS.find_iter(text).find_map(|m| {
        let url = Url::parse(m.as_str().trim_end_matches([')', '.', ',', ';', '!', '?'])).ok()?;
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            return None;
        }
        let mut p: Vec<_> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
        let source = match url.host_str()? {
            "open.spotify.com" | "spotify.com" => Source::Spotify,
            "music.yandex.ru" | "music.yandex.com" | "music.yandex.by" | "music.yandex.kz" => {
                Source::Yandex
            }
            _ => return None,
        };
        if source == Source::Spotify && p.first().is_some_and(|s| s.starts_with("intl-")) {
            p.remove(0);
        }
        match p.as_slice() {
            ["track", id] => MusicLink::track(source, id, None),
            ["album", album, "track", id] if source == Source::Yandex => {
                MusicLink::track(source, id, Some(album))
            }
            ["album", id] if valid_id(source, id) => Some(MusicLink {
                source,
                kind: Kind::Album,
                id: (*id).into(),
                album_id: None,
            }),
            [kind @ ("artist" | "playlist" | "episode" | "show"), id] => Some(MusicLink {
                source,
                kind: Kind::Unsupported((*kind).into()),
                id: (*id).into(),
                album_id: None,
            }),
            ["users", _, "playlists", id] if source == Source::Yandex => Some(MusicLink {
                source,
                kind: Kind::Unsupported("playlist".into()),
                id: (*id).into(),
                album_id: None,
            }),
            _ => None,
        }
    })
}

#[derive(Debug, Clone)]
pub struct Track {
    pub link: MusicLink,
    pub title: String,
    pub artists: String,
    pub album: String,
    pub album_artist: String,
    pub year: Option<i32>,
    pub number: Option<u32>,
    pub disc: Option<u32>,
    pub duration: u32,
    pub cover_url: Option<String>,
}

impl Track {
    pub fn display_name(&self) -> String {
        format!("{} — {}", self.artists, self.title)
    }

    pub fn fallback(link: MusicLink) -> Self {
        Self {
            artists: link.source.label().into(),
            link,
            title: "Скачать по ссылке".into(),
            album: String::new(),
            album_artist: String::new(),
            year: None,
            number: None,
            disc: None,
            duration: 0,
            cover_url: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Album {
    pub label: String,
    pub tracks: Vec<MusicLink>,
}

#[derive(Debug, thiserror::Error)]
#[error("Проблема с авторизацией {0}. Проверь credentials/token и подписку.")]
pub struct AuthError(pub &'static str);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_links_in_messages() {
        let link = find_music_link(
            "@bot https://open.spotify.com/intl-ru/track/0hBUik7RITAPmSlnOGiWdm?si=x",
        )
        .unwrap();
        assert_eq!(link.source, Source::Spotify);
        let link = find_music_link("Смотри (https://music.yandex.kz/album/12/track/345).").unwrap();
        assert_eq!(link.id, "345");
        assert_eq!(link.album_id.as_deref(), Some("12"));
        assert_eq!(
            find_music_link("https://music.yandex.ru/album/12")
                .unwrap()
                .kind,
            Kind::Album
        );
    }

    #[test]
    fn rejects_spoofed_hosts_and_partial_ids() {
        for url in [
            "https://open.spotify.com.evil/track/0hBUik7RITAPmSlnOGiWdm",
            "https://music.yandex.ru@evil/album/12/track/345",
            "https://music.yandex.ru/album/12/track/345/evil",
            "https://open.spotify.com/track/short",
            "https://music.yandex.ru/album/12a",
        ] {
            assert!(find_music_link(url).is_none(), "{url}");
        }
    }
}
