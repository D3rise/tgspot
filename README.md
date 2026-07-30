# tgspot

A Telegram bot that downloads Spotify tracks and albums as MP3 320 kbps
(via [zotify](https://github.com/Googolplexed0/zotify)) and sends them to
whitelisted users in DMs or groups.

## Features

- Send a Spotify **track** or **album** URL → get MP3 files back with embedded
  ID3 tags and cover art.
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
- A working Rust toolchain (`cargo`) for the one-time credentials setup via
  [librespot-auth](https://github.com/dspearson/librespot-auth).

## Setup

### 1. Create a Telegram bot

- Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, follow the
  prompts, and save the token.
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

### 3. Configure environment variables

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

### 4. Build and run with Docker

```bash
docker build -t tgspot .

docker run -d \
  --name tgspot \
  --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/credentials.json:/data/credentials.json:ro" \
  tgspot
```

Check logs:

```bash
docker logs -f tgspot
```

You should see `[bot] running as @your_bot_username`.

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

### Supported link types

- ✅ `open.spotify.com/track/...`
- ✅ `open.spotify.com/album/...`
- ❌ Playlists, podcast episodes, artists — the bot will reply that only
  tracks and albums are supported.

## Operations

### Updating the whitelist

Edit `WHITELIST` in `.env`, then restart:

```bash
docker restart tgspot
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

- **50 MB per file.** Telegram Bot API caps uploads at 50 MB. A 320 kbps MP3
  fits any reasonable song length, but very long tracks (~35+ minutes) may
  hit the limit.
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
    downloader.ts        zotify wrapper with retry + progress
    metadata.ts          ID3 & cover extraction
    album-info.ts        album track list via spotify-url-info
    admin-notifier.ts    admin DM on auth errors
    queue.ts             per-user FIFO
    download-orchestrator.ts  track/album flow (framework-agnostic)
    job-reporter.ts      interface between orchestrator and Telegram
  telegram/              grammy-specific layer
    bot-runner.ts        composition root
    handlers.ts          message/command handlers
    telegram-reporter.ts JobReporter implementation with throttled edits
    mention.ts           @mention detection
    lifecycle.ts         "accepting new requests" flag
```
