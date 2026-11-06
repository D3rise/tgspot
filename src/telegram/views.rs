use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::domain::{MusicLink, Quality, Source, Track};

pub const HELP: &str = "Пришли ссылку на трек или альбом Spotify / Яндекс.Музыки — я скачаю и отправлю.\nТекст без ссылки в личке — поиск.\nВ группе упомяни меня через @ или ответь на моё сообщение.\nInline: @имя_бота название трека.";
const PAGE_SIZE: usize = 5;

pub struct Session {
    pub user: u64,
    pub chat: i64,
    pub message: i64,
    pub query: String,
    pub results: Vec<Track>,
    pub page: usize,
    pub created: Instant,
}

#[derive(Default)]
pub struct Sessions {
    entries: HashMap<String, Session>,
}

impl Sessions {
    pub fn insert(&mut self, session: Session) -> String {
        static IDS: std::sync::LazyLock<AtomicU64> = std::sync::LazyLock::new(|| {
            AtomicU64::new(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos() as u64,
            )
        });
        self.entries
            .retain(|_, s| s.created.elapsed() < Duration::from_secs(1800));
        if self.entries.len() >= 500
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(k, _)| k.clone())
        {
            self.entries.remove(&oldest);
        }
        let id = format!("{:016x}", IDS.fetch_add(1, Ordering::Relaxed));
        self.entries.insert(id.clone(), session);
        id
    }

    pub fn get(&mut self, id: &str, user: u64, chat: i64, message: i64) -> Option<&mut Session> {
        let session = self.entries.get_mut(id)?;
        (session.user == user
            && session.chat == chat
            && session.message == message
            && session.created.elapsed() < Duration::from_secs(1800))
        .then_some(session)
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }
}

pub fn button(text: impl Into<String>, data: impl Into<String>) -> Value {
    json!({"text":text.into(),"callback_data":data.into()})
}

pub fn download_keyboard(track: &Track, inline: bool) -> Value {
    let prefix = if inline { "dl" } else { "sd" };
    let buttons = match track.link.source {
        Source::Spotify => vec![button(
            "🎵 Скачать MP3 320",
            format!("{prefix}|s|{}", track.link.id),
        )],
        Source::Yandex => [("🎵 M4A", "h"), ("💿 FLAC", "l")]
            .into_iter()
            .map(|(label, quality)| {
                button(
                    label,
                    format!(
                        "{prefix}|y|{quality}|{}|{}",
                        track.link.id,
                        track.link.album_id.as_deref().unwrap_or("0")
                    ),
                )
            })
            .collect(),
    };
    json!({"inline_keyboard":[buttons]})
}

pub fn parse_download(data: &str) -> Option<(MusicLink, Quality)> {
    if data.len() > 64 {
        return None;
    }
    let parts: Vec<_> = data.split('|').collect();
    let (link, quality) = match parts.as_slice() {
        ["dl" | "sd", "s", id] => (MusicLink::track(Source::Spotify, id, None)?, Quality::High),
        ["dl" | "sd", "y", quality @ ("h" | "l"), id, album] => (
            MusicLink::track(Source::Yandex, id, (*album != "0").then_some(*album))?,
            if *quality == "h" {
                Quality::High
            } else {
                Quality::Lossless
            },
        ),
        _ => return None,
    };
    Some((link, quality))
}

pub fn results_page(id: &str, session: &Session) -> (String, Value) {
    let pages = session.results.len().div_ceil(PAGE_SIZE).max(1);
    let page = session.page.min(pages - 1);
    let start = page * PAGE_SIZE;
    let mut text = format!(
        "🔎 «{}» — {} результатов\n",
        session.query,
        session.results.len()
    );
    let mut choices = Vec::new();
    for (index, track) in session
        .results
        .iter()
        .enumerate()
        .skip(start)
        .take(PAGE_SIZE)
    {
        text.push_str(&format!(
            "\n{}. {}\n    {} · {}",
            index + 1,
            track.display_name(),
            track.link.source.label(),
            duration(track.duration)
        ));
        choices.push(button((index + 1).to_string(), format!("st|{id}|{index}")));
    }
    let keyboard = json!({"inline_keyboard":[choices, [
        button("⬅", format!("sp|{id}|{}", page.saturating_sub(1))),
        button(format!("{}/{pages}", page + 1), format!("sp|{id}|{page}")),
        button("➡", format!("sp|{id}|{}", (page + 1).min(pages - 1)))],
        [button("✕ Закрыть", format!("sx|{id}"))]]});
    (text, keyboard)
}

pub fn track_detail(id: &str, track: &Track, page: usize) -> (String, Value) {
    let mut keyboard = download_keyboard(track, false);
    keyboard["inline_keyboard"]
        .as_array_mut()
        .unwrap()
        .push(json!([button(
            "⬅ К результатам",
            format!("sb|{id}|{page}")
        )]));
    (
        format!(
            "🎵 {}\n{} · {} · {}",
            track.display_name(),
            track.link.source.label(),
            duration(track.duration),
            track.album
        ),
        keyboard,
    )
}

pub fn inline_article(track: &Track) -> Value {
    let mut article = json!({"type":"article","id":format!("{}{}", if track.link.source == Source::Spotify { "s" } else { "y" }, track.link.id),
        "title":super::api::truncate(&track.display_name(), 200),
        "description":format!("{} · {} · {}", track.link.source.label(), duration(track.duration), track.album),
        "input_message_content":{"message_text":format!("🎵 {}\n{} · {}",track.display_name(),track.link.source.label(), duration(track.duration))},
        "reply_markup":download_keyboard(track, true)});
    if let Some(url) = &track.cover_url {
        article["thumbnail_url"] = json!(url);
    }
    article
}

fn duration(seconds: u32) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_validate_ids_quality_and_length() {
        for data in [
            "dl|s|../../etc/passwd",
            "sd|y|x|123|12",
            "dl|y|h|123|12/evil",
            "dl|s|",
            "dl|s|short",
        ] {
            assert!(parse_download(data).is_none(), "{data}");
        }
        let (link, quality) = parse_download("dl|y|l|123|12").unwrap();
        assert_eq!(link.id, "123");
        assert_eq!(quality, Quality::Lossless);
        let track = Track::fallback(link);
        for row in download_keyboard(&track, true)["inline_keyboard"]
            .as_array()
            .unwrap()
        {
            for button in row.as_array().unwrap() {
                let data = button["callback_data"].as_str().unwrap();
                assert!(data.len() <= 64 && parse_download(data).is_some());
            }
        }
    }

    #[test]
    fn sessions_are_scoped_to_owner_chat_and_message_and_expire() {
        let mut sessions = Sessions::default();
        let id = sessions.insert(Session {
            user: 1,
            chat: 2,
            message: 3,
            query: "q".into(),
            results: Vec::new(),
            page: 0,
            created: Instant::now(),
        });
        assert!(sessions.get(&id, 1, 2, 3).is_some());
        assert!(sessions.get(&id, 9, 2, 3).is_none());
        assert!(sessions.get(&id, 1, 2, 4).is_none());
        sessions.entries.get_mut(&id).unwrap().created -= Duration::from_secs(1801);
        assert!(sessions.get(&id, 1, 2, 3).is_none());
    }
}
