use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::json;
use tokio::sync::watch;

use super::api::{Api, truncate};
use crate::{
    domain::{MusicLink, Quality},
    media::Downloaded,
    services::downloads::Downloads,
};

#[derive(Clone)]
pub enum Target {
    Chat {
        chat: i64,
        reply: Option<i64>,
    },
    Inline {
        message: String,
        user: i64,
        storage: Option<i64>,
    },
}

pub struct Reporter {
    api: Api,
    target: Target,
    status: Option<i64>,
    text: String,
    media_done: bool,
    last_action: Instant,
}

impl Reporter {
    pub fn new(api: Api, target: Target) -> Self {
        Self {
            api,
            target,
            status: None,
            text: String::new(),
            media_done: false,
            last_action: Instant::now() - Duration::from_secs(4),
        }
    }

    pub async fn progress(&mut self, text: &str) {
        if self.media_done || self.text == text {
            return;
        }
        let text = truncate(text, 4000);
        let result = match &self.target {
            Target::Chat { chat, reply } => match self.status {
                Some(id) => self
                    .api
                    .call(
                        "editMessageText",
                        json!({"chat_id":chat,"message_id":id,"text":text}),
                    )
                    .await
                    .map(|_| ()),
                None => self
                    .api
                    .message(*chat, &text, *reply, json!({"inline_keyboard":[]}))
                    .await
                    .map(|id| self.status = Some(id)),
            },
            Target::Inline { message, .. } => self
                .api
                .call(
                    "editMessageText",
                    json!({"inline_message_id":message,"text":text,
                "reply_markup":{"inline_keyboard":[]}}),
                )
                .await
                .map(|_| ()),
        };
        if result.is_ok() {
            self.text = text;
        } else {
            tracing::debug!("Could not update Telegram progress message");
        }
    }

    async fn action(&mut self) {
        if self.last_action.elapsed() < Duration::from_secs(4) {
            return;
        }
        if let Target::Chat { chat, .. } = &self.target {
            let _ = self
                .api
                .call(
                    "sendChatAction",
                    json!({"chat_id":chat,"action":"upload_document"}),
                )
                .await;
        }
        self.last_action = Instant::now();
    }

    pub async fn download(
        &mut self,
        downloads: &Downloads,
        link: &MusicLink,
        quality: Quality,
        prefix: &str,
    ) -> Result<Downloaded> {
        let (sender, receiver) = watch::channel("⏳ Инициализация…".to_owned());
        let task = downloads.track(link, quality, &sender);
        tokio::pin!(task);
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        tokio::select! {
            result = &mut task => result,
            _ = async {
                loop {
                    interval.tick().await;
                    let status = format!("{prefix}{}", receiver.borrow().as_str());
                    self.progress(&status).await;
                    self.action().await;
                }
            } => unreachable!("progress loop never completes"),
        }
    }

    pub async fn send(&mut self, file: &Downloaded) -> Result<()> {
        self.progress("⬆️ Отправляю файл…").await;
        let chat = match self.target {
            Target::Chat { chat, .. } => chat,
            Target::Inline { user, storage, .. } => storage.unwrap_or(user),
        };
        let reply = match self.target {
            Target::Chat { reply, .. } => reply,
            _ => None,
        };
        let api = self.api.clone();
        let upload = api.upload(chat, file, reply);
        tokio::pin!(upload);
        let mut interval = tokio::time::interval(Duration::from_secs(4));
        let sent = tokio::select! {
            result = &mut upload => result?,
            _ = async {
                loop { interval.tick().await; self.action().await; }
            } => unreachable!("chat action loop never completes"),
        };
        if let Target::Inline {
            message,
            storage: Some(_),
            ..
        } = &self.target
        {
            let mut media = json!({"type":sent.kind,"media":sent.file_id});
            let mut caption = file.track.display_name();
            if let Some(warning) = &file.warning {
                caption.push_str(&format!("\n{warning}"));
            }
            media["caption"] = json!(truncate(&caption, 1000));
            self.api
                .call(
                    "editMessageMedia",
                    json!({"inline_message_id":message,"media":media,
                "reply_markup":{"inline_keyboard":[]}}),
                )
                .await?;
            self.media_done = true;
        }
        Ok(())
    }

    pub async fn finish(&mut self, summary: Option<&str>) {
        if self.media_done {
            return;
        }
        if let Some(summary) = summary {
            self.progress(summary).await;
            return;
        }
        match &self.target {
            Target::Chat { chat, .. } => {
                if let Some(id) = self.status {
                    let _ = self
                        .api
                        .call("deleteMessage", json!({"chat_id":chat,"message_id":id}))
                        .await;
                }
            }
            Target::Inline { .. } => self.progress("✅ Готово, отправил в личку.").await,
        }
    }
}
