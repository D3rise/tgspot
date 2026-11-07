use std::{collections::HashSet, env};

use anyhow::{Context, Result, ensure};
use url::Url;

pub struct Config {
    pub bot_token: String,
    pub whitelist: HashSet<String>,
    pub admin_username: Option<String>,
    pub spotify_credentials_json: String,
    pub yandex_token: Option<String>,
    pub telegram_api_root: Url,
    pub spotify_client: Option<(String, String)>,
    pub storage_chat_id: Option<i64>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::load(|key| env::var(key).ok())
    }

    fn load(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let value = |key| {
            get(key)
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        };
        let required =
            |key| value(key).with_context(|| format!("Missing environment variable: {key}"));
        let bot_token = required("TELEGRAM_BOT_TOKEN")?;
        ensure!(
            bot_token
                .split_once(':')
                .is_some_and(|(id, secret)| !id.is_empty()
                    && id.bytes().all(|b| b.is_ascii_digit())
                    && !secret.is_empty()
                    && secret
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')),
            "Invalid TELEGRAM_BOT_TOKEN format"
        );
        let whitelist = required("WHITELIST")?
            .split(',')
            .map(normalize_username)
            .filter(|s| !s.is_empty())
            .collect::<HashSet<_>>();
        ensure!(
            !whitelist.is_empty(),
            "WHITELIST must contain at least one username"
        );
        let spotify_client = match (value("SPOTIFY_CLIENT_ID"), value("SPOTIFY_CLIENT_SECRET")) {
            (Some(id), Some(secret)) => Some((id, secret)),
            (None, None) => None,
            _ => anyhow::bail!("Set both SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET"),
        };
        let telegram_api_root = Url::parse(
            &value("TELEGRAM_BOT_API_ROOT").unwrap_or_else(|| "https://api.telegram.org".into()),
        )?;
        ensure!(
            matches!(telegram_api_root.scheme(), "http" | "https")
                && telegram_api_root.host_str().is_some()
                && telegram_api_root.username().is_empty()
                && telegram_api_root.password().is_none()
                && telegram_api_root.query().is_none()
                && telegram_api_root.fragment().is_none(),
            "Invalid TELEGRAM_BOT_API_ROOT"
        );
        Ok(Self {
            bot_token,
            whitelist,
            admin_username: value("ADMIN_USERNAME").map(|s| normalize_username(&s)),
            spotify_credentials_json: required("SPOTIFY_CREDENTIALS_JSON")?,
            yandex_token: value("YANDEX_MUSIC_TOKEN"),
            telegram_api_root,
            spotify_client,
            storage_chat_id: value("STORAGE_CHAT_ID")
                .map(|s| {
                    s.parse()
                        .context("STORAGE_CHAT_ID must be a signed 64-bit integer")
                })
                .transpose()?,
        })
    }

    pub fn allows(&self, username: Option<&str>) -> bool {
        username.is_some_and(|name| self.whitelist.contains(&normalize_username(name)))
    }
}

fn normalize_username(value: &str) -> String {
    value.trim().trim_start_matches('@').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(extra: &[(&str, &str)]) -> Result<Config> {
        Config::load(|key| {
            extra
                .iter()
                .copied()
                .chain([
                    ("TELEGRAM_BOT_TOKEN", "123:secret"),
                    ("WHITELIST", " @Alice,BOB "),
                    ("SPOTIFY_CREDENTIALS_JSON", "{}"),
                ])
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_owned())
        })
    }

    #[test]
    fn normalizes_whitelist() {
        let c = config(&[]).unwrap();
        assert!(c.allows(Some("ALICE")));
        assert!(!c.allows(None));
        assert!(!c.allows(Some("mallory")));
    }

    #[test]
    fn rejects_invalid_configuration() {
        for pair in [
            ("WHITELIST", ", @, "),
            ("SPOTIFY_CREDENTIALS_JSON", ""),
            ("STORAGE_CHAT_ID", "1.5"),
            ("TELEGRAM_BOT_TOKEN", "123:../other"),
            ("SPOTIFY_CLIENT_ID", "id"),
            ("TELEGRAM_BOT_API_ROOT", "file:///tmp/api"),
        ] {
            assert!(config(&[pair]).is_err(), "{}", pair.0);
        }
    }
}
