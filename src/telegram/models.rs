use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct User {
    pub id: u64,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Entity {
    #[serde(rename = "type")]
    pub kind: String,
    pub offset: usize,
    pub length: usize,
    pub user: Option<User>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub message_id: i64,
    pub chat: Chat,
    pub from: Option<User>,
    pub text: Option<String>,
    #[serde(default)]
    pub entities: Vec<Entity>,
    pub reply_to_message: Option<Box<Message>>,
}

impl Message {
    pub fn mentions(&self, bot: &User) -> bool {
        if self
            .reply_to_message
            .as_ref()
            .and_then(|m| m.from.as_ref())
            .is_some_and(|u| u.id == bot.id)
        {
            return true;
        }
        let utf16: Vec<_> = self.text.as_deref().unwrap_or("").encode_utf16().collect();
        self.entities
            .iter()
            .any(|entity| match entity.kind.as_str() {
                "text_mention" => entity.user.as_ref().is_some_and(|u| u.id == bot.id),
                "mention" | "bot_command" => {
                    let Some(end) = entity.offset.checked_add(entity.length) else {
                        return false;
                    };
                    let Some(value) = utf16.get(entity.offset..end) else {
                        return false;
                    };
                    let value = String::from_utf16_lossy(value);
                    bot.username.as_ref().is_some_and(|name| {
                        value
                            .rsplit_once('@')
                            .is_some_and(|(_, mentioned)| mentioned.eq_ignore_ascii_case(name))
                    })
                }
                _ => false,
            })
    }
}

#[derive(Debug, Deserialize)]
pub struct InlineQuery {
    pub id: String,
    pub from: User,
    pub query: String,
}

#[derive(Debug, Deserialize)]
pub struct Callback {
    pub id: String,
    pub from: User,
    pub data: Option<String>,
    pub inline_message_id: Option<String>,
    pub message: Option<Message>,
}

#[derive(Debug, Deserialize)]
pub struct Update {
    pub update_id: i64,
    pub message: Option<Message>,
    pub inline_query: Option<InlineQuery>,
    pub callback_query: Option<Callback>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mentions_use_telegram_utf16_offsets() {
        let bot = User {
            id: 1,
            username: Some("MusicBot".into()),
        };
        let mut message: Message = serde_json::from_value(json!({"message_id":1,
            "chat":{"id":-1,"type":"group"},"text":"🎵 @musicbot test",
            "entities":[{"type":"mention","offset":3,"length":9}]}))
        .unwrap();
        assert!(message.mentions(&bot));
        message.entities[0].offset = usize::MAX;
        assert!(!message.mentions(&bot));
    }
}
