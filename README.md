# tgspot

A Telegram music bot written in **Rust**. Spotify downloads use
[librespot](https://github.com/librespot-org/librespot) directly and are encoded
as MP3 320 kbps. Yandex Music downloads, search, metadata, request signing and
AES-CTR decryption are implemented in Rust; lossless streams are remuxed to
native FLAC. FFmpeg handles encoding, containers, tags and cover art.
There is no Node.js, Python, zotify or yandex-music-downloader runtime.

## Features

- Send a Spotify **track** or **album** URL → get MP3 files back with embedded
  ID3 tags and cover art.
- Send a Yandex.Music **track** or **album** URL → get lossless `.flac`
  files with embedded metadata and cover art. Sent as documents (Telegram's
  music player only accepts MP3/M4A), so they land in the chat as attachments.
- **Inline search** — type `@your_bot_username Metallica Enter Sandman` in
  any chat and pick a track from the dropdown. Searches Spotify and
  Yandex.Music simultaneously; the file is downloaded on demand and
  delivered to your DM with the bot.
- Works in **direct messages** and in **group chats** (mention the bot with
  `@your_bot_username <spotify-url>`).
- **Username-based whitelist** — only listed users may trigger downloads;
  everyone else is silently ignored.
- **Per-user FIFO queue** — one user's album doesn't block others.
- **Live download progress** in the status message, throttled to ~1 update/sec.
- Best-effort album downloads: individual track failures are reported at the
  end, the rest of the album still gets through.
- Stateless (in-memory queue, no database, no cache). An interrupted download can be retried by
  resending the link.

## Requirements

- Docker (recommended runtime).
- A **Spotify Premium** account (needed for 320 kbps streams).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A [librespot 0.8 binary](https://github.com/librespot-org/librespot/releases)
  for the one-time Spotify OAuth setup.
- **Optional:** a Yandex.Music subscription and an OAuth token to enable
  Yandex.Music downloads. Without it the bot still works — Yandex links just
  get a "not configured" reply.
- **Optional:** Spotify Client ID / Secret (free, from
  [developer.spotify.com](https://developer.spotify.com/dashboard)) to
  enable Spotify inline search. Without it inline search covers Yandex only.

## Setup

### 1. Create a Telegram bot

- Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, follow the
  prompts, and save the token.
- **To use inline search:** run `/setinline` on your bot in BotFather and
  provide a short placeholder, e.g. `search Spotify or Yandex.Music`. Without
  this step `@your_bot_username query` won't work.
- **Required:** run `/setprivacy` → **Enable** privacy mode. The bot is
  designed to operate without read access to arbitrary group messages —
  in groups it only ever acts on messages that explicitly `@`-mention it
  (or are replies to its own messages, or `/cmd@botname` commands). Privacy
  mode enforces this at the Telegram side, so unrelated conversations in
  the group never reach the bot at all. DMs are unaffected by privacy mode
  and continue to work normally.

  > If the bot was already added to a group before you enabled privacy mode,
  > remove it and re-add it — Telegram only applies the new setting to
  > groups joined after the change.

### 2. Configure Spotify credentials in the environment

Use a [librespot 0.8 binary](https://github.com/librespot-org/librespot/releases)
to sign in once with [interactive OAuth](https://github.com/librespot-org/librespot/wiki/Options):

```bash
librespot --enable-oauth --cache ./spotify-auth --disable-audio-cache \
  --disable-discovery --backend pipe --device /dev/null
```

Complete the browser login, wait for the connection to succeed, then stop
librespot with Ctrl+C. Its `spotify-auth/credentials.json` contains the native
`username`, `auth_type` and `auth_data` fields. Spotify Premium is required
for the 320 kbps stream. The temporary setup directory is not used by tgspot.

Put the **entire JSON** in `SPOTIFY_CREDENTIALS_JSON` in your `.env`, as a
single compact line without outer shell quotes (the values below are placeholders):

```dotenv
SPOTIFY_CREDENTIALS_JSON={"username":"your-user","auth_type":1,"auth_data":"your-base64-data"}
```

`docker run --env-file` keeps literal quote characters, so use the unquoted
JSON line above in `.env`; it also works with Compose. When using a shell
`export`, quote the JSON normally.

To compact the generated JSON before copying it:

```bash
python3 -c 'import json; print(json.dumps(json.load(open("spotify-auth/credentials.json")), separators=(",", ":")))'
```

The bot reads credentials directly from this variable at startup. **No file or volume
mount is required at runtime**, and the bot does not write credentials back
to disk. Keep `.env` private: `auth_data` grants access to your Spotify account.
To rotate credentials, replace the variable and recreate the container.

Only native librespot JSON is accepted. Authentication is environment-only;
no file fallback, legacy format conversion or runtime credential writes.

### 3. (Optional) Get a Yandex.Music OAuth token

Skip this section if you don't need Yandex.Music support — the bot will run
Spotify-only and reply "not configured" to any Yandex link.

1. Open [ym.marshal.dev/token](https://ym.marshal.dev/token/#implicit-oauth)
   and follow the "Implicit OAuth" flow — you'll be redirected to Yandex,
   sign in, approve access, and the page will show a token starting with
   `y0_...`.
2. Copy the token. This is your `YANDEX_MUSIC_TOKEN`.
3. Keep it secret — it grants access to your Yandex account. You can revoke
   it any time from your
   [Yandex account app list](https://id.yandex.ru/security/apps).

The Rust client uses this token only for Yandex Music API requests. Audio
and cover downloads use the URLs returned by Yandex; the OAuth header is
not forwarded to the CDN.

### 4. Configure environment variables

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather. |
| `WHITELIST` | Comma-separated Telegram usernames allowed to use the bot, without `@`. Example: `alice,bob,charlie`. Case-insensitive. Users without a username cannot be whitelisted. |
| `ADMIN_USERNAME` | Username (without `@`) that receives auth-error notifications. The bot can only DM the admin after the admin has messaged the bot at least once. |
| `SPOTIFY_CREDENTIALS_JSON` | Required native librespot credentials JSON; no file needed. |
| `YANDEX_MUSIC_TOKEN` | *Optional.* OAuth token from step 3. Leave empty to disable Yandex.Music support. Enables Yandex inline search when set. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | *Optional.* Enable Spotify **inline search**. Register a free app at [developer.spotify.com](https://developer.spotify.com/dashboard), copy both values. |
| `STORAGE_CHAT_ID` | *Optional.* Numeric id of a private channel where the bot is admin. Enables inline files to land in the target chat (instead of DM). See [Inline: delivery into the target chat](#inline-delivery-into-the-target-chat). |

### 5. Run a local tgspot instance from GHCR

Complete steps 1–4 first. Run the commands below from the directory
containing your configured `.env` (including `SPOTIFY_CREDENTIALS_JSON`),
with Docker running.

The commands use `ghcr.io/d3rise/tgspot:latest`. This image and tag must
already be published to GitHub Container Registry. The current Gitea
workflow publishes to `registry.nerv.dev/d3rise/tgspot` instead; replace
the registry/image and login host below if using that build. If you
published a different tag, replace `latest` in the commands below.

For a private package, log in first using your GitHub username and a
personal access token (classic) with `read:packages` and access to the package
(see [GHCR authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)):

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME
# Paste the token at the password prompt.
```

Public packages can be pulled without logging in.

Pull the image and start the bot:

```bash
docker pull ghcr.io/d3rise/tgspot:latest

docker run -d \
  --name tgspot \
  --restart unless-stopped \
  --env-file .env \
  ghcr.io/d3rise/tgspot:latest
```

No credentials mount, inbound port or database is needed. For the default
public Telegram API, leave `TELEGRAM_BOT_API_ROOT` unset. Run only one
instance for the same bot token. For long queues, give Docker enough time
to stop: `docker stop --time 3600 tgspot`.

Check logs:

```bash
docker logs -f tgspot
```

You should see `Bot ready` with your bot username. Open the bot in
Telegram, press **Start**, and send a track link from a whitelisted account
to verify delivery.

To update the image, pull it again, remove the old container, and repeat
the `docker run` command above:

```bash
docker pull ghcr.io/d3rise/tgspot:latest
docker stop tgspot
docker rm tgspot
```

Your `.env` remains on the host. Removing the
container loses any queued downloads; resend unfinished links after startup.

If you want to build the image locally for development instead:

```bash
docker build -t tgspot:local .
```

Use `tgspot:local` instead of the GHCR image in the same `docker run` command.

### 6. Deploy to Kubernetes with Argo CD

[`charts/tgspot/`](charts/tgspot/) is a Helm chart with a Deployment and
ConfigMap. [`values.yaml`](charts/tgspot/values.yaml) configures the image,
resource limits, Bot API URL, and existing Secret names. Tokens and
credentials stay in separately provisioned Kubernetes Secrets.

Create `tgspot-env`, `tgspot-spotify`, and `tgspot-registry` using the
[chart instructions](charts/tgspot/README.md) before the first sync. Stop
any other instance using the same bot token.

From the repository root, validate, preview, and package the chart:

```bash
helm lint charts/tgspot
helm template tgspot charts/tgspot --namespace tgspot
helm package charts/tgspot --destination dist/charts
```

The package is `dist/charts/tgspot-0.1.0.tgz`. To use Argo CD directly from
Git, commit and push the chart and
[`argocd/application.yaml`](argocd/application.yaml) to the configured
branch. The Application uses repository
`ssh://git@git.nerv.dev/D3rise/tgspot.git`, revision `main`, path
`charts/tgspot`, release `tgspot`, and namespace `tgspot`. Argo CD must
already have read access to the Git repository; adjust these settings for
your installation. A separate Helm repository is not required.

Register the Application (automatic sync, pruning, and self-healing are enabled):

```bash
kubectl apply -f argocd/application.yaml
```

## Usage

### Direct messages

Send the bot a Spotify link:

```
https://open.spotify.com/track/0hBUik7RITAPmSlnOGiWdm
```

The status message shows initialization, then live download progress:

```
⏳ Инициализация…
⬇️ Скачивание… 40%
```

When the download finishes, the status message is deleted and the audio file
is delivered as a reply to your message.

Albums work the same way — the status shows per-track progress:

```
Альбом Artist — Album (3/12) ⬇️ 30%
```

At the end you get a summary and, for any tracks that failed, the reason.

### Inline search (any chat)

In any chat (DM, group, or one where the bot is not even a member), type:

```
@your_bot_username Metallica Enter Sandman
```

You'll see a dropdown with tracks from Spotify and Yandex.Music. Pick one to
post a message with format buttons:

- **Spotify** results have a single `🎵 Скачать MP3 320` button.
- **Yandex** results have two buttons: `🎵 M4A` (AAC 192, quick) and
  `💿 FLAC` (lossless when available).

After you click a button, the bot downloads the track. **Where the file
appears depends on whether you configured a storage channel** — see
[Inline: delivery into the target chat](#inline-delivery-into-the-target-chat).

- **With `STORAGE_CHAT_ID`** — the file replaces the stub message directly
  in the chat where you triggered inline (group, DM, anywhere). Works
  regardless of whether the bot is a member of that chat.
- **Without `STORAGE_CHAT_ID`** — the file is delivered to your DM with
  the bot; the stub message updates to `✅ Отправил в личку`. Requires you
  to have pressed `Start` in the DM at least once.

### Group chats

Add the bot to the group, then mention it in a message that also contains a
Spotify URL:

```
@your_bot_username https://open.spotify.com/track/0hBUik7RITAPmSlnOGiWdm
```

The bot replies in the same group chat. The whitelist check still applies —
only whitelisted senders trigger a download; other members are ignored.

Because the bot runs with Telegram privacy mode enabled, it does **not**
see any group messages that don't mention it. If you send a plain Spotify
URL in a group without `@`-mentioning the bot, nothing happens — that's by
design.

### Inline: delivery into the target chat

By default, files picked via inline search go to your DM with the bot. That
side-steps a real Telegram Bot API limitation: `editMessageMedia` on an
inline-posted message **doesn't allow uploading a new file** — you can
only reference a file that already exists on Telegram (by `file_id`).

The workaround the "Miro-style" inline bots use: keep a dedicated **storage
channel** where the bot has posting rights. When a user picks a track:

1. Bot downloads the file to disk.
2. Bot uploads it to the storage channel — this puts the file on
   Telegram's servers and gives us a `file_id`.
3. Bot calls `editMessageMedia(inline_message_id, { media: file_id })`.
   The inline stub in the user's chat turns into the actual audio message.

The result: **the file appears in the chat where the user did the inline
query**, even if the bot isn't a member of that chat.

**One-time setup:**

1. Create a **new private channel** (any name — it stays hidden). The
   channel exists only as a staging area; you don't need to read it.
2. Add your bot as an **admin** with the "Post Messages" permission.
3. Get the channel's numeric id:
   - Forward any message from the channel to
     [@userinfobot](https://t.me/userinfobot). It will show
     `Origin chat: -100...`. Take that number **including the leading `-100`**.
4. Put it in `.env`:

   ```
   STORAGE_CHAT_ID=-1001234567890
   ```

5. Restart the bot. On startup you should see:

   ```
   [bot] inline delivery: via storage chat -1001234567890 (file appears in the target chat)
   ```

**If `STORAGE_CHAT_ID` is not set**, inline delivery falls back to DM as
documented above — everything still works, just less "magical".

**A note on storage growth:** every inline download goes through the
channel and stays there indefinitely. This is normal and doesn't affect
correctness (Telegram deduplicates identical files by hash internally),
but if you want to keep the channel tidy you can periodically clear old
messages manually — the `file_id`s remain valid.

### Supported link types

Spotify:
- ✅ `open.spotify.com/track/...`
- ✅ `open.spotify.com/album/...`

Yandex.Music (only if `YANDEX_MUSIC_TOKEN` is set):
- ✅ `music.yandex.ru/album/<id>/track/<id>`
- ✅ `music.yandex.ru/album/<id>`

Everything else (Spotify playlists/episodes/artists, Yandex artists, Yandex
playlists, etc.) — the bot replies that only tracks and albums are supported.

## Raising the 50 MB limit

Telegram's public Bot API caps uploads at 50 MB. If you run your own
[Local Bot API Server](https://github.com/tdlib/telegram-bot-api), the same
bot can upload files up to **2 GB** per file. This is officially supported
by Telegram — no third-party hacks, no user-account impersonation.

### One-time setup

1. **Get an API ID and hash** at [my.telegram.org](https://my.telegram.org) →
   "API development tools". Any Telegram account works; the ID/hash aren't
   tied to your bot.

2. **Fill them in `.env`:**

   ```
   TELEGRAM_API_ID=1234567
   TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
   ```

3. **Log the bot out of the public API** — required exactly once, before
   moving to the local server, otherwise it will refuse to authorize on the
   new endpoint. Run this from any machine:

   ```bash
   curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/logOut"
   ```

   You should see `{"ok":true,"result":true}`. From now on the bot only
   works via a local Bot API server; if you ever want to go back to the
   public API, run `logOut` against the local server first.

4. **Start the whole stack via docker-compose:**

   ```bash
   docker compose up -d --build
   ```

   `docker-compose.yml` brings up two services:
   - `tg-bot-api` — the local Bot API server, exposing `http://tg-bot-api:8081`
     on the internal Docker network.
   - `tgspot` — the bot itself, with `TELEGRAM_BOT_API_ROOT` already pointed
     at the sidecar.

   Follow logs:

   ```bash
   docker compose logs -f tgspot
   ```

   On startup you should see:

   ```
   INFO tgspot::telegram: Bot ready username="your_bot_username" search=true
   ```

### Trade-offs

- **+1 container**, a few tens of MB RAM. The `tg-bot-api` process is
  otherwise idle when the bot is idle.
- Once you switch to local API, this bot can't fall back to the public
  Telegram API without another `logOut` — pick one and stick with it.
- The local server keeps a small amount of state (auth session, cached
  file references) in the `tg-bot-api-data` Docker volume. Don't delete
  it unless you also plan to re-authorize the bot.
- File **download** from Telegram (not relevant for us — we only upload) is
  also lifted to 4 GB, in case you extend the bot to accept uploads later.

## Operations

### Updating the whitelist

Edit `WHITELIST` in `.env`, then recreate the container using the
`docker run` command from step 5 so Docker reads the updated environment:

```bash
docker stop tgspot
docker rm tgspot
```

### Rotating Spotify credentials

If Spotify invalidates the session, repeat the librespot OAuth login,
replace `SPOTIFY_CREDENTIALS_JSON` in `.env`, then recreate the container.
The environment is read at startup; `docker restart` does not reload `.env`.
The admin must have opened the bot's private chat to receive auth notifications.

### Graceful shutdown

`docker stop tgspot` sends `SIGTERM`. The bot stops accepting new requests,
drains all already accepted jobs, including albums, and exits cleanly.
Compose sets a one-hour stop grace period; a forced kill still loses the queue.

## Limitations

- **50 MB per file** (default). Telegram Bot API caps uploads at 50 MB. A
  320 kbps MP3 fits any reasonable song length (~35+ minutes before the cap).
  FLAC from Yandex is ~30–40 MB per typical 4-minute track — long tracks
  (~7+ min) can hit the limit and will fail to upload. **This can be lifted
  to 2 GB** by running a local Bot API server — see
  [Raising the 50 MB limit](#raising-the-50-mb-limit) below.
- **Yandex tracks are sent as documents**, not as music-player audio. FLAC
  isn't supported by Telegram's `sendAudio`, so we fall back to
  `sendDocument`. The file still has embedded tags and cover art, but it
  won't appear in the in-chat music player.
- **Quality.** Spotify's 320 kbps Vorbis stream is transcoded to MP3 320;
  this is lossy conversion. If a Yandex track has no lossless master, the bot
  keeps the returned AAC/MP3 format and includes a warning in the caption.
- **Provider compatibility.** Yandex's API is unofficial. The implementation
  follows [yandex-music-downloader's signing and decryption](https://github.com/llistochek/yandex-music-downloader/blob/main/ymd/api.py)
  and [yandex-music-api](https://github.com/MarshalX/yandex-music-api).
  Provider changes can require an update. Spotify metadata and album lists
  come from librespot rather than HTML scraping.
- **Resource limits.** At most four simultaneous track downloads, 20 pending
  jobs per user, and 2 GB per source file. Temporary directories are removed
  after successful and failed jobs. Abrupt process termination can leave
  temporary files for the OS to reclaim.
- **Statelessness.** Queues, search sessions and the admin chat ID live in
  memory. A forced restart loses them. Search sessions expire after 30 minutes.

## Development

Requires Rust 1.90+ and FFmpeg (`ffmpeg` and `ffprobe` on `PATH`).
The application reads process environment variables; it does not implicitly
load `.env`. Compose / `docker run --env-file` load it for you.

```bash
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --all-targets --locked
cargo build --release --locked
# Export your configured variables first, then:
cargo run --release --locked
```

Tests cover configuration, URL/callback validation, UTF-16 Telegram entity
offsets, FIFO queue isolation/shutdown, search-session ownership, Yandex
metadata/signatures/AES, token-safe Telegram HTTP errors, and real FFmpeg
encoding/tagging. They use no provider credentials and send no Telegram messages.

Opt-in live provider checks download one track each and never contact Telegram:

```bash
# Export SPOTIFY_CREDENTIALS_JSON and/or YANDEX_MUSIC_TOKEN first.
cargo test --locked --test live_providers spotify_download -- --ignored
cargo test --locked --test live_providers yandex_download -- --ignored
```

Docker builds run formatting, Clippy and offline tests before producing the
release binary. Commit `Cargo.lock` and use `--locked`: librespot 0.8's build
requires `vergen` 9.0.6; an unconstrained update to 9.1 is incompatible with
its `vergen-gitcl` dependency.

Project layout:

```text
src/
  main.rs                bootstrap and signal handling
  config.rs              validated environment configuration
  domain.rs              music links, metadata, quality, auth errors
  media.rs               FFmpeg, tags, covers, temporary file ownership
  providers/
    spotify.rs           reusable librespot session, metadata and downloads
    yandex.rs            HTTP API, request signing, AES-CTR, metadata
    search.rs            Spotify Web API and concurrent merged search
    mod.rs               HTTP client, cover downloads and network errors
  services/
    downloads.rs         provider routing, retry and concurrency limits
    queue.rs             bounded per-user FIFO and drain
  telegram/
    mod.rs               composition and long polling
    handlers.rs          messages, inline queries, callbacks and search
    jobs.rs              album delivery and admin notification flow
    api.rs               Bot API and streaming multipart uploads
    models.rs            typed updates and mention detection
    views.rs             keyboards, pagination and scoped search sessions
    reporter.rs          throttled progress and inline/DM delivery
```

`domain` has no Telegram or network dependencies. Providers handle their own
protocols; download services select providers and schedule work; the Telegram
layer renders views and delivers files. Temporary file lifetime is tied to the
Rust download result, so an error during upload also releases the files.
