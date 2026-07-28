# Google OAuth2 — read-only metadata sync (design)

Goal: mirror the user's YouTube Music **playlist and like *names*** into the app as
organizational reference.

> **Note (2026-07)**: The original version of this doc referenced a "no yt-dlp"
> compliance stance (`COMPLIANCE.md`). That stance was reversed by the project
> owner — the app now fully supports yt-dlp-based search, streaming and downloads.
> This OAuth sync feature remains useful as a *metadata* bridge: it lets the user
> see their YouTube Music library (playlists, liked songs) inside the app and map
> them to local or streamable tracks, without manually re-searching everything.

## Scope

Request the narrowest read-only scope only:

```
https://www.googleapis.com/auth/youtube.readonly
```

This grants reading playlists/subscriptions metadata via the **YouTube Data API v3**.
It does **not** grant stream URLs (the API never exposes them).

## Flow (native desktop → loopback)

Desktop apps use the **loopback IP redirect** flow (no client secret shipped in the app):

1. App generates a PKCE `code_verifier` + `code_challenge`.
2. Opens the system browser to Google's consent screen with
   `redirect_uri=http://127.0.0.1:<random_port>` and the scope above.
3. A tiny local HTTP listener on that port catches the `?code=...` redirect.
4. App exchanges `code` + `code_verifier` for tokens at Google's token endpoint.
5. `refresh_token` is stored **encrypted at rest** (OS keychain via
   `keyring` crate — never in the repo, never in plain settings).

## Credentials

- Create an **OAuth Client ID** of type *Desktop app* in Google Cloud Console.
- Ship only the **client ID** (public by design for desktop PKCE). No secret in the binary.
- Put local dev config in `src-tauri/.env` (git-ignored).

## Where it plugs in

- New Rust module `src-tauri/src/sync.rs` (not created yet — roadmap item #4).
- Exposes commands: `oauth_begin()`, `oauth_status()`, `sync_playlists() -> Vec<RemotePlaylist>`.
- The frontend shows remote playlists as read-only reference; the user maps them to
  **local** tracks manually or via title/artist matching.

## Explicitly out of scope

- No direct playback through the YouTube Data API (it doesn't provide stream URLs).
- Streaming is handled separately by the yt-dlp pipeline (`youtube.rs` / `stream.rs`).
