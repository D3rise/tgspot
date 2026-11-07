use std::{path::Path, time::Duration};

use anyhow::{Context, Result};
use reqwest::{
    Client,
    multipart::{Form, Part},
};
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use crate::media::{Downloaded, is_flac};

#[derive(Debug, thiserror::Error)]
#[error("Telegram {code}: {description}")]
pub struct TelegramError {
    pub code: i64,
    pub description: String,
}

#[derive(Clone)]
pub struct Api {
    client: Client,
    root: String,
}

#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    result: Option<Value>,
    error_code: Option<i64>,
    description: Option<String>,
}

pub struct Sent {
    pub file_id: String,
    pub kind: &'static str,
}

impl Api {
    pub fn new(root: &Url, token: &str) -> Result<Self> {
        // API requests carry the token in their URL; never follow redirects.
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            root: format!("{}/bot{token}/", root.as_str().trim_end_matches('/')),
        })
    }

    pub async fn call(&self, method: &str, data: Value) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}{method}", self.root))
            .timeout(Duration::from_secs(if method == "getUpdates" {
                40
            } else {
                15
            }))
            .json(&data)
            .send()
            .await
            .map_err(|e| e.without_url())?;
        decode(response).await
    }

    pub async fn message(
        &self,
        chat: i64,
        text: &str,
        reply: Option<i64>,
        markup: Value,
    ) -> Result<i64> {
        let mut data = json!({"chat_id":chat,"text":truncate(text, 4000),"reply_markup":markup});
        if let Some(reply) = reply {
            data["reply_parameters"] =
                json!({"message_id":reply,"allow_sending_without_reply":true});
        }
        let result = self.call("sendMessage", data).await?;
        result["message_id"]
            .as_i64()
            .context("Telegram response missing message_id")
    }

    pub async fn answer(&self, callback: &str, text: &str) -> Result<()> {
        self.call(
            "answerCallbackQuery",
            json!({"callback_query_id":callback,"text":text}),
        )
        .await?;
        Ok(())
    }

    pub async fn upload(&self, chat: i64, file: &Downloaded, reply: Option<i64>) -> Result<Sent> {
        let kind = if is_flac(&file.path) {
            "document"
        } else {
            "audio"
        };
        match self.upload_as(chat, file, reply, kind).await {
            Ok(sent) => Ok(sent),
            Err(error)
                if kind == "audio"
                    && error.downcast_ref::<TelegramError>().is_some_and(|e| {
                        e.code == 400
                            && (e.description.contains("AUDIO") || e.description.contains("audio"))
                    }) =>
            {
                self.upload_as(chat, file, reply, "document").await
            }
            Err(error) => Err(error),
        }
    }

    async fn upload_as(
        &self,
        chat: i64,
        file: &Downloaded,
        reply: Option<i64>,
        kind: &'static str,
    ) -> Result<Sent> {
        let part = file_part(&file.path).await?;
        let caption = match &file.warning {
            Some(warning) => format!("{}\n{warning}", file.track.display_name()),
            None => file.track.display_name(),
        };
        let mut form = Form::new()
            .text("chat_id", chat.to_string())
            .part(kind, part)
            .text("caption", truncate(&caption, 1000));
        if kind == "audio" {
            form = form
                .text("title", file.track.title.clone())
                .text("performer", file.track.artists.clone())
                .text("duration", file.track.duration.to_string());
        }
        if let Some(path) = &file.thumbnail {
            form = form.part("thumbnail", file_part(path).await?);
        }
        if let Some(id) = reply {
            form = form.text(
                "reply_parameters",
                json!({"message_id":id,"allow_sending_without_reply":true}).to_string(),
            );
        }
        let method = if kind == "audio" {
            "sendAudio"
        } else {
            "sendDocument"
        };
        let response = self
            .client
            .post(format!("{}{method}", self.root))
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.without_url())?;
        let result = decode(response).await?;
        Ok(Sent {
            file_id: result[kind]["file_id"]
                .as_str()
                .context("Telegram response missing file_id")?
                .into(),
            kind,
        })
    }
}

async fn file_part(path: &Path) -> Result<Part> {
    Part::file(path).await.context("Cannot open upload file")
}

async fn decode(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let envelope: Envelope = response
        .json()
        .await
        .map_err(|e| e.without_url())
        .with_context(|| format!("Invalid Telegram API response (HTTP {status})"))?;
    if !envelope.ok {
        return Err(TelegramError {
            code: envelope.error_code.unwrap_or(status.as_u16() as i64),
            description: envelope
                .description
                .unwrap_or_else(|| "Unknown API error".into()),
        }
        .into());
    }
    envelope.result.context("Telegram response missing result")
}

pub fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn errors_do_not_disclose_token_and_preserve_api_error_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            let body = r#"{"ok":false,"error_code":403,"description":"Forbidden"}"#;
            stream.write_all(format!("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let api = Api::new(&root, "123:secret").unwrap();
        let error = api.call("getMe", json!({})).await.unwrap_err();
        assert_eq!(error.downcast_ref::<TelegramError>().unwrap().code, 403);
        assert!(!format!("{error:?}").contains("123:secret"));
        server.await.unwrap();
        let error = api.call("getMe", json!({})).await.unwrap_err();
        assert!(!format!("{error:?}").contains("123:secret"));
    }
}
