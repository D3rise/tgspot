use super::{
    App, api,
    models::{Callback, InlineQuery, Message, Update},
    reporter::Target,
    views::{self, Session},
};
use crate::domain::{Kind, MusicLink, Quality, Track, find_music_link};
use anyhow::{Context, Result};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

impl App {
    pub(super) async fn handle(self: &Arc<Self>, update: Update) -> Result<()> {
        if let Some(message) = update.message {
            self.message(message).await?;
        } else if let Some(query) = update.inline_query {
            self.inline(query).await?;
        } else if let Some(callback) = update.callback_query
            && let Err(error) = self.callback(&callback).await
        {
            tracing::warn!(%error, "Callback failed");
            let _ = self
                .api
                .answer(
                    &callback.id,
                    "Не удалось обработать кнопку. Попробуй ещё раз.",
                )
                .await;
        }
        Ok(())
    }

    async fn message(self: &Arc<Self>, message: Message) -> Result<()> {
        let Some(user) = &message.from else {
            return Ok(());
        };
        if message.chat.kind == "private"
            && user
                .username
                .as_ref()
                .zip(self.config.admin_username.as_ref())
                .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            self.admin.lock().expect("admin lock poisoned").chat = Some(message.chat.id);
        }
        if !self.config.allows(user.username.as_deref()) {
            return Ok(());
        }
        let Some(text) = &message.text else {
            return Ok(());
        };
        let group = message.chat.kind != "private";
        if group && !message.mentions(&self.me) {
            return Ok(());
        }
        let command = text.split_whitespace().next().unwrap_or("");
        let (command, addressed) =
            command
                .split_once('@')
                .map_or((command, true), |(command, name)| {
                    (
                        command,
                        self.me
                            .username
                            .as_ref()
                            .is_some_and(|me| me.eq_ignore_ascii_case(name)),
                    )
                });
        if addressed && ["/start", "/help"].contains(&command) {
            self.api
                .message(
                    message.chat.id,
                    views::HELP,
                    Some(message.message_id),
                    json!({"inline_keyboard":[]}),
                )
                .await?;
            return Ok(());
        }
        if let Some(link) = find_music_link(text) {
            let target = Target::Chat {
                chat: message.chat.id,
                reply: Some(message.message_id),
            };
            if let Err(error) = self.enqueue(user.id, link, Quality::Lossless, target) {
                self.api
                    .message(
                        message.chat.id,
                        &error.to_string(),
                        Some(message.message_id),
                        json!({"inline_keyboard":[]}),
                    )
                    .await?;
            }
        } else if !group && !text.starts_with('/') {
            self.dm_search(user.id, &message, text).await?;
        }
        Ok(())
    }

    async fn dm_search(&self, user: u64, message: &Message, query: &str) -> Result<()> {
        if !self.search.enabled() {
            self.api
                .message(
                    message.chat.id,
                    "Поиск не настроен. Пришли ссылку на трек или альбом.",
                    Some(message.message_id),
                    json!({"inline_keyboard":[]}),
                )
                .await?;
            return Ok(());
        }
        let query = api::truncate(query.trim(), 300);
        let results =
            match tokio::time::timeout(Duration::from_secs(10), self.search.search(&query)).await {
                Ok(Ok(results)) => results,
                _ => {
                    self.api
                        .message(
                            message.chat.id,
                            "Поиск временно недоступен, попробуй ещё раз.",
                            Some(message.message_id),
                            json!({"inline_keyboard":[]}),
                        )
                        .await?;
                    return Ok(());
                }
            };
        if results.is_empty() {
            self.api
                .message(
                    message.chat.id,
                    &format!("Ничего не нашёл по «{query}»."),
                    Some(message.message_id),
                    json!({"inline_keyboard":[]}),
                )
                .await?;
            return Ok(());
        }
        let (id, text, keyboard) = {
            let mut sessions = self.sessions.lock().expect("sessions lock poisoned");
            let id = sessions.insert(Session {
                user,
                chat: message.chat.id,
                message: 0,
                query,
                results,
                page: 0,
                created: Instant::now(),
            });
            let session = sessions
                .get(&id, user, message.chat.id, 0)
                .expect("new session");
            let (text, keyboard) = views::results_page(&id, session);
            (id, text, keyboard)
        };
        let sent = self
            .api
            .message(message.chat.id, &text, Some(message.message_id), keyboard)
            .await?;
        if let Some(session) =
            self.sessions
                .lock()
                .expect("sessions lock poisoned")
                .get(&id, user, message.chat.id, 0)
        {
            session.message = sent;
        }
        Ok(())
    }

    async fn inline(&self, query: InlineQuery) -> Result<()> {
        let mut results = Vec::new();
        if self.config.allows(query.from.username.as_deref()) && !query.query.trim().is_empty() {
            let text = api::truncate(query.query.trim(), 300);
            if let Some(link) = find_music_link(&text) {
                if link.kind == Kind::Track {
                    let track = match tokio::time::timeout(
                        Duration::from_secs(6),
                        self.search.track(&link),
                    )
                    .await
                    {
                        Ok(Ok(track)) => track,
                        _ => Track::fallback(link),
                    };
                    results.push(views::inline_article(&track));
                }
            } else if let Ok(Ok(tracks)) =
                tokio::time::timeout(Duration::from_secs(6), self.search.search(&text)).await
            {
                results.extend(tracks.iter().map(views::inline_article));
            }
        }
        self.api.call("answerInlineQuery", json!({"inline_query_id":query.id,"results":results,"cache_time":15,"is_personal":true})).await?;
        Ok(())
    }

    async fn callback(self: &Arc<Self>, callback: &Callback) -> Result<()> {
        if !self.config.allows(callback.from.username.as_deref()) {
            return self.api.answer(&callback.id, "⛔ Нет доступа").await;
        }
        let data = callback.data.as_deref().unwrap_or("");
        if data.starts_with("dl|") || data.starts_with("sd|") {
            let Some((link, quality)) = views::parse_download(data) else {
                return self
                    .api
                    .answer(&callback.id, "Неверные данные кнопки")
                    .await;
            };
            let target = if data.starts_with("dl|") {
                Target::Inline {
                    message: callback
                        .inline_message_id
                        .clone()
                        .context("Missing inline_message_id")?,
                    user: i64::try_from(callback.from.id)?,
                    storage: self.config.storage_chat_id,
                }
            } else {
                let message = callback
                    .message
                    .as_ref()
                    .context("Missing message context")?;
                Target::Chat {
                    chat: message.chat.id,
                    reply: None,
                }
            };
            self.enqueue(callback.from.id, link, quality, target)?;
            self.api
                .answer(&callback.id, "⬇️ Добавил в очередь")
                .await?;
            if data.starts_with("sd|")
                && let Some(message) = &callback.message
            {
                let _ = self
                    .api
                    .call(
                        "deleteMessage",
                        json!({"chat_id":message.chat.id,"message_id":message.message_id}),
                    )
                    .await;
            }
            return Ok(());
        }
        let parts: Vec<_> = data.split('|').collect();
        let Some(message) = &callback.message else {
            return self
                .api
                .answer(&callback.id, "Нет контекста сообщения")
                .await;
        };
        let view = (|| {
            let mut sessions = self.sessions.lock().expect("sessions lock poisoned");
            let id = *parts.get(1)?;
            let session =
                sessions.get(id, callback.from.id, message.chat.id, message.message_id)?;
            match parts.first().copied()? {
                "sp" | "sb" => {
                    let page: usize = parts.get(2)?.parse().ok()?;
                    session.page = page.min(session.results.len().div_ceil(5).saturating_sub(1));
                    Some(Some(views::results_page(id, session)))
                }
                "st" => {
                    let index: usize = parts.get(2)?.parse().ok()?;
                    Some(Some(views::track_detail(
                        id,
                        session.results.get(index)?,
                        session.page,
                    )))
                }
                "sx" => {
                    sessions.remove(id);
                    Some(None)
                }
                _ => None,
            }
        })();
        match view {
            Some(Some((text, keyboard))) => {
                self.api.answer(&callback.id, "").await?;
                let _ = self
                    .api
                    .call(
                        "editMessageText",
                        json!({"chat_id":message.chat.id,"message_id":message.message_id,
                    "text":api::truncate(&text, 4000),"reply_markup":keyboard}),
                    )
                    .await;
            }
            Some(None) => {
                self.api.answer(&callback.id, "").await?;
                let _ = self
                    .api
                    .call(
                        "deleteMessage",
                        json!({"chat_id":message.chat.id,"message_id":message.message_id}),
                    )
                    .await;
            }
            None => {
                self.api
                    .answer(
                        &callback.id,
                        "Сессия поиска устарела или принадлежит другому пользователю.",
                    )
                    .await?
            }
        }
        Ok(())
    }

    fn enqueue(
        self: &Arc<Self>,
        user: u64,
        link: MusicLink,
        quality: Quality,
        target: Target,
    ) -> Result<()> {
        let app = self.clone();
        self.queue.enqueue(user, async move {
            app.download(link, quality, target).await;
        })
    }
}
