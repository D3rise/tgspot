# tgspot

A Telegram bot that downloads music from **Spotify** (MP3 320 kbps via
[zotify](https://github.com/Googolplexed0/zotify)) and from **Yandex.Music**
(FLAC lossless via
[yandex-music-downloader](https://github.com/llistochek/yandex-music-downloader))
and sends them to whitelisted users in DMs or groups.

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
- **Live progress bar** in the status message, throttled to ~1 update/sec.
- Best-effort album downloads: individual track failures are reported at the
  end, the rest of the album still gets through.
- Stateless (in-memory queue, no database, no cache). A restart just means the
  user resends the link.

## Requirements

- Docker (recommended runtime).
- A **Spotify Premium** account (needed for 320 kbps streams).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A working Rust toolchain (`cargo`) for the one-time Spotify credentials
  setup via [librespot-auth](https://github.com/dspearson/librespot-auth).
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

### 2. Generate `credentials.json` with librespot-auth

Instead of typing your Spotify password anywhere, we use
[librespot-auth](https://github.com/dspearson/librespot-auth) — a small Rust
tool that advertises a fake Spotify Connect device and captures the session
credentials when you connect to it from the official Spotify app. The
resulting `credentials.json` uses librespot's format, which zotify reads
directly via its `--creds` flag.

**Prerequisites:** Rust toolchain (`cargo`). Install via
[rustup](https://rustup.rs/) if you don't have it.

1. Install librespot-auth:

   ```bash
   cargo install librespot-auth
   ```

   The binary lands at `~/.cargo/bin/librespot-auth`. Make sure `~/.cargo/bin`
   is on your `PATH`.

2. Run it in the directory where you want `credentials.json` to appear:

   ```bash
   cd /path/to/tgspot
   librespot-auth --name "tgspot-auth" --class computer
   ```

   It will start listening as a Spotify Connect device on your local network.

3. On the **same network**, open the Spotify app (mobile, desktop, or web),
   start playing any track, then open the device picker (Spotify Connect
   icon) and select **tgspot-auth** from the list.

4. As soon as Spotify hands off playback, librespot-auth captures the
   credentials, writes `credentials.json` next to itself, and exits (or you
   can `Ctrl+C` to stop it manually).

5. Verify the file exists:

   ```bash
   ls -l credentials.json
   ```

   It's a small JSON file containing `username`, `auth_type`, and
   `auth_data`. Keep it secret — it grants access to your Spotify account.
   If you ever suspect it's leaked, log out of "third-party apps" in your
   [Spotify account settings](https://www.spotify.com/account/apps/) and
   regenerate.

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

The token is used only to hit the official Yandex.Music API through
[yandex-music-downloader](https://github.com/llistochek/yandex-music-downloader).
Nothing is uploaded anywhere else.

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
| `ZOTIFY_CREDENTIALS_PATH` | Path to `credentials.json` inside the container. Defaults to `/data/credentials.json`. |
| `YANDEX_MUSIC_TOKEN` | *Optional.* OAuth token from step 3. Leave empty to disable Yandex.Music support. Enables Yandex inline search when set. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | *Optional.* Enable Spotify **inline search**. Register a free app at [developer.spotify.com](https://developer.spotify.com/dashboard), copy both values. |
| `STORAGE_CHAT_ID` | *Optional.* Numeric id of a private channel where the bot is admin. Enables inline files to land in the target chat (instead of DM). See [Inline: delivery into the target chat](#inline-delivery-into-the-target-chat). |

### 5. Run a local tgspot instance from GHCR

Complete steps 1–4 first. Run the commands below from the directory
containing your configured `.env` and Spotify `credentials.json`, with
Docker running.

The commands use `ghcr.io/d3rise/tgspot:latest`. This image and tag must
already be published to GitHub Container Registry; this repository does
not currently include an image-publishing workflow. If you published a
different tag, replace `latest` in the commands below.

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
test -f credentials.json

docker run -d \
  --name tgspot \
  --restart unless-stopped \
  --env-file .env \
  --mount "type=bind,source=$(pwd)/credentials.json,target=/data/credentials.json,readonly" \
  ghcr.io/d3rise/tgspot:latest
```

The credentials file must exist before starting the container. Keep
`ZOTIFY_CREDENTIALS_PATH=/data/credentials.json` in `.env` to match the
mount. For the default public Telegram API, leave `TELEGRAM_BOT_API_ROOT`
unset. No inbound port or database is needed. Run only one instance for
the same bot token.

Check logs:

```bash
docker logs -f tgspot
```

You should see `[bot] running as @your_bot_username`. Open the bot in
Telegram, press **Start**, and send a track link from a whitelisted account
to verify delivery.

To update the image, pull it again, remove the old container, and repeat
the `docker run` command above:

```bash
docker pull ghcr.io/d3rise/tgspot:latest
docker stop tgspot
docker rm tgspot
```

Your `.env` and `credentials.json` remain on the host. Removing the
container loses any queued downloads; resend unfinished links after startup.

If you want to build the image locally for development instead:

```bash
docker build -t tgspot:local .
```

Use `tgspot:local` instead of the GHCR image in the same `docker run` command.

## Usage

### Direct messages

Send the bot a Spotify link:

```
https://open.spotify.com/track/0hBUik7RITAPmSlnOGiWdm
```

The status message shows initialization, then a live progress bar:

```
⏳ Инициализация…
⬇️ Скачивание… [████████░░░░░░░░░░░░] 40%
```

When the download finishes, the status message is deleted and the audio file
is delivered as a reply to your message.

Albums work the same way — the status shows per-track progress:

```
Альбом Artist — Album (3/12) ⬇️ [██████░░░░░░░░░░░░░░] 30%
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
   [bot] using local Bot API server at http://tg-bot-api:8081 (2 GB upload limit)
   [bot] running as @your_bot_username
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

If Spotify invalidates the session (rare, but happens — e.g. after a
password change or a manual "log out everywhere"), the admin gets a
notification like `⚠️ Spotify auth error: …`. Regenerate `credentials.json`
via librespot-auth (step 2), replace the file mounted into the container,
and restart.

### Graceful shutdown

`docker stop tgspot` sends `SIGTERM`. The bot stops accepting new requests,
finishes the in-flight track (not the whole album), and exits cleanly.

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
- **Download speed.** Zotify streams from Spotify in real time or slightly
  faster and re-encodes to MP3 via ffmpeg. Expect a few seconds per short
  track; albums scale linearly. The main per-track overhead is the
  librespot session handshake, not the transcoding.
- **Statelessness.** If the bot restarts mid-download, the queue is lost —
  the user needs to resend the link.
- **`spotify-url-info`** (used to fetch album track lists) scrapes public
  Spotify embed pages. If Spotify changes their embed format, album downloads
  may temporarily break until the library is updated.

## Development

Local development without Docker:

```bash
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN, WHITELIST, etc.
# also make sure zotify is on PATH (pipx install …) and credentials.json exists
npm run build
node dist/index.js
```

Watch mode:

```bash
npm run dev  # tsc --watch, then run node dist/index.js in another terminal
```

Project layout:

```
src/
  index.ts               bootstrap + signal handling
  config.ts              env parsing
  domain/                pure types & URL parsing
  services/              framework-agnostic business logic
    downloader-types.ts  TrackDownloader interface + shared errors/types
    spotify-downloader.ts zotify wrapper (MP3 320, per-percent progress)
    yandex-downloader.ts yandex-music-downloader wrapper (FLAC lossless)
    spotify-search.ts    Spotify Web API client (client credentials)
    yandex-search.ts     Yandex Music search API client
    search-orchestrator.ts merges results from both sources
    metadata.ts          ID3 & cover extraction
    album-info.ts        album track list via spotify-url-info
    admin-notifier.ts    admin DM on auth errors
    queue.ts             per-user FIFO
    download-orchestrator.ts  track/album flow (framework-agnostic)
    job-reporter.ts      interface between orchestrator and Telegram
  telegram/              grammy-specific layer
    bot-runner.ts        composition root
    handlers.ts          message/command handlers
    telegram-reporter.ts JobReporter for direct-URL flow (same chat)
    inline-search.ts     inline_query handler → answered with SearchResult[]
    inline-callback.ts   callback_query handler → download + DM delivery
    inline-reporter.ts   JobReporter for inline flow (status → inline msg, file → DM)
    audio-sender.ts      shared sendAudio/sendDocument helper
    mention.ts           @mention detection
    lifecycle.ts         "accepting new requests" flag
```
