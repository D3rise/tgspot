use super::{
    App,
    api::{self, TelegramError},
    reporter::{Reporter, Target},
};
use crate::domain::{AuthError, Kind, MusicLink, Quality, Source};
use serde_json::json;

impl App {
    pub(super) async fn download(&self, link: MusicLink, quality: Quality, target: Target) {
        let mut reporter = Reporter::new(self.api.clone(), target);
        if let Kind::Unsupported(kind) = &link.kind {
            reporter
                .finish(Some(&format!(
                    "Поддерживаются только треки и альбомы. Получил: {kind}."
                )))
                .await;
            return;
        }
        let tracks = if link.kind == Kind::Album {
            reporter.progress("⏳ Получаю список треков альбома…").await;
            match self.downloads.album(&link).await {
                Ok(album) => Some(album),
                Err(error) => {
                    self.download_error(&mut reporter, link.source, &error)
                        .await;
                    return;
                }
            }
        } else {
            None
        };
        let links = tracks
            .as_ref()
            .map(|a| a.tracks.clone())
            .unwrap_or_else(|| vec![link.clone()]);
        let mut failed = Vec::new();
        for (index, track) in links.iter().enumerate() {
            let prefix = tracks
                .as_ref()
                .map(|a| format!("Альбом {} ({}/{}) — ", a.label, index + 1, links.len()))
                .unwrap_or_default();
            let result = async {
                let file = reporter
                    .download(&self.downloads, track, quality, &prefix)
                    .await?;
                reporter.send(&file).await
            }
            .await;
            match result {
                Ok(()) => {
                    self.admin
                        .lock()
                        .expect("admin lock poisoned")
                        .delivered
                        .remove(&link.source);
                }
                Err(error) => {
                    tracing::warn!(source = link.source.label(), %error, "Track delivery failed");
                    if error.is::<AuthError>() {
                        self.notify_admin(link.source).await;
                    }
                    failed.push(format!(
                        "• {}: {}",
                        track.id,
                        api::truncate(&error.to_string(), 160)
                    ));
                    if tracks.is_none() {
                        self.download_error(&mut reporter, link.source, &error)
                            .await;
                        return;
                    }
                    if error.is::<AuthError>() {
                        let sent = index + 1 - failed.len();
                        failed.push(format!(
                            "Остальные {} треков не скачаны из-за авторизации.",
                            links.len() - index - 1
                        ));
                        reporter
                            .finish(Some(&format!(
                                "Отправлено: {sent}/{}.\n{}",
                                links.len(),
                                failed.join("\n")
                            )))
                            .await;
                        return;
                    }
                }
            }
        }
        if tracks.is_some() {
            reporter
                .finish(Some(&format!(
                    "Готово: {}/{}.{}",
                    links.len() - failed.len(),
                    links.len(),
                    if failed.is_empty() {
                        String::new()
                    } else {
                        format!("\nНе удалось:\n{}", failed.join("\n"))
                    }
                )))
                .await;
        } else {
            reporter.finish(None).await;
        }
    }

    async fn download_error(&self, reporter: &mut Reporter, source: Source, error: &anyhow::Error) {
        let message = if error.is::<AuthError>() {
            self.notify_admin(source).await;
            format!(
                "Не удалось скачать: проблема с авторизацией {}. Обратись к админу.",
                source.label()
            )
        } else if error
            .downcast_ref::<TelegramError>()
            .is_some_and(|e| e.code == 403)
        {
            format!(
                "Открой личный чат с @{} и нажми Start, затем попробуй ещё раз.",
                self.me.username.as_deref().unwrap_or("bot")
            )
        } else {
            format!(
                "Не удалось скачать или отправить: {}",
                api::truncate(&error.to_string(), 250)
            )
        };
        reporter.finish(Some(&message)).await;
    }

    async fn notify_admin(&self, source: Source) {
        let chat = {
            let mut admin = self.admin.lock().expect("admin lock poisoned");
            let chat = admin.chat;
            chat.filter(|_| admin.delivered.insert(source))
        };
        if let Some(chat) = chat
            && self
                .api
                .message(
                    chat,
                    &format!(
                        "⚠️ Проблема с авторизацией {}: проверь credentials/token и подписку.",
                        source.label()
                    ),
                    None,
                    json!({"inline_keyboard":[]}),
                )
                .await
                .is_err()
        {
            self.admin
                .lock()
                .expect("admin lock poisoned")
                .delivered
                .remove(&source);
        }
    }
}
