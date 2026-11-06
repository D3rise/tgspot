#!/usr/bin/env python3
"""Yandex Music search / track lookup wrapper.

Invoked as a subprocess from Node when we can't hit the /search endpoint
directly (edge-blocked with an HTML 403). Uses the yandex-music-api SDK,
which is already installed in the yandex-music-downloader pipx venv.

Usage:
    yandex_search.py <token> search <query> [limit]
    yandex_search.py <token> track <trackId>[:<albumId>]

Writes JSON array to stdout on success (exit 0). Track mode returns at
most one element (empty array if the track is missing/unavailable).

On failure writes an error line to stderr and exits non-zero.
"""

from __future__ import annotations

import json
import sys
from typing import Any, List


def _dump(err: str, code: int = 1) -> None:
    print(err, file=sys.stderr)
    sys.exit(code)


def _serialize(t: Any, fallback_album_id: str | None = None) -> dict[str, Any] | None:
    album = t.albums[0] if t.albums else None
    album_id = str(album.id) if album and album.id else fallback_album_id
    if not album_id:
        # Yandex track URL is /album/<id>/track/<id> — no album, no URL.
        return None
    artists = ", ".join(a.name for a in (t.artists or []) if a.name) or "Unknown Artist"
    cover_uri = t.cover_uri or (album.cover_uri if album else None)
    return {
        "trackId": str(t.id),
        "albumId": album_id,
        "title": t.title or "Unknown",
        "version": t.version,
        "artists": artists,
        "album": album.title if album else None,
        "durationSec": (t.duration_ms // 1000) if t.duration_ms else None,
        "coverUri": cover_uri,
    }


def main() -> None:
    if len(sys.argv) < 4:
        _dump("usage: yandex_search.py <token> <search|track> <arg> [limit]", code=2)

    token = sys.argv[1]
    mode = sys.argv[2]
    arg = sys.argv[3]

    try:
        from yandex_music import Client  # type: ignore
    except ImportError as e:
        _dump(f"yandex-music package not importable: {e}")

    try:
        client = Client(token).init()
    except Exception as e:  # noqa: BLE001 — bubble up as JSON-friendly text
        _dump(f"Client init failed: {e.__class__.__name__}: {e}")

    out: List[dict[str, Any]] = []

    if mode == "search":
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 8
        try:
            result = client.search(arg, type_="track", nocorrect=False)
        except Exception as e:  # noqa: BLE001
            _dump(f"search failed: {e.__class__.__name__}: {e}")

        tracks = []
        if result and result.tracks and result.tracks.results:
            tracks = result.tracks.results[:limit]
        for t in tracks:
            if getattr(t, "available", True) is False:
                continue
            entry = _serialize(t)
            if entry:
                out.append(entry)
    elif mode == "track":
        # arg is "<trackId>" or "<trackId>:<albumId>". The album id lets us
        # keep the canonical URL even if the SDK-returned track omits it.
        if ":" in arg:
            track_id, hinted_album = arg.split(":", 1)
        else:
            track_id, hinted_album = arg, None
        try:
            tracks = client.tracks([track_id])
        except Exception as e:  # noqa: BLE001
            _dump(f"track fetch failed: {e.__class__.__name__}: {e}")
        t = tracks[0] if tracks else None
        if t is not None and getattr(t, "available", True) is not False:
            entry = _serialize(t, fallback_album_id=hinted_album)
            if entry:
                out.append(entry)
    else:
        _dump(f"unknown mode: {mode}", code=2)

    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
