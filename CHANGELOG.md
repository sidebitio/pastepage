# Changelog

All notable changes to PastePage are listed in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A Width setting (Normal or Wide) in the settings menu: Wide lets the session view use the full window width, so code lines have more room. The choice is remembered in the browser.
- Images in notes: paste a screenshot or drop image files (PNG, JPEG, WebP or GIF) anywhere in a session. They wait above the message box with their size until you send them; each image becomes its own note, encrypted like text, with the text in the box as the first one's caption. A large image is made smaller in the browser: losslessly to WebP first, then as high-quality WebP, then at a smaller size, and the card says so ("PNG 3.2 MB → WebP 640 KB"). GIFs are never converted, so they keep their animation; SVG and other files are refused. Image cards have Reply, Pin, Download, Delete, Copy (as PNG) and a full-size view, and work with reactions, pins and burn after reading. Hidden data in a picture file (GPS location, camera details, dates, comments) is removed in the browser before sending; the picture itself is not changed.
- Images are kept in the browsers instead of on the server. A browser saves each full image on its own disk (IndexedDB), encrypted with a key made from the session key and a value the server forgets when the session ends, so the copies can't be read afterwards. The server keeps a full image only until everyone who was in the session has it, then keeps a small preview (at most 480 px) for people who join later; they see it marked as a low-resolution preview. A new setting, `MAX_PREVIEW_BYTES` (96,000 by default), limits the preview's size. A browser that can't store images (a private window, for example) still works; the server then keeps the full image for it until that tab is reloaded or closed. Copies are removed when the session ends, a note is deleted or rolls off, Clear all is used or their expiry has passed, and beyond 500 MB per browser, oldest first. The server now sees which notes are images and which tab saved which image; see [docs/security.md](docs/security.md#images).
- Sessions roll over instead of refusing notes: when `MAX_SESSION_BYTES` or `MAX_EVENTS` would be exceeded, the oldest events are dropped. Open pages keep showing notes that rolled off, on a slightly different background, until reloaded, and show a notice once. A thin line under the header shows how full the session is.
- A Long notes setting (Fold or Show in full) in the settings menu: notes over 28 lines are folded behind "Show all" by default, and "Show in full" shows them completely. It applies at once to every note on screen and is remembered in the browser.

### Changed

- The server refuses to start when `MAX_SESSION_BYTES` is smaller than one image note can take (`MAX_NOTE_BYTES` + `MAX_PREVIEW_BYTES` + 96 bytes), instead of refusing every large image later with "too large".

### Fixed

- A pinned note's card no longer gets extra space above its header.

## [0.1.0] - 2026-10-23

The first public release.

### Added

- Live sessions for pasting text back and forth: what you paste arrives exactly as pasted, including Windows line endings, with syntax highlighting, line numbers, Wrap and Copy. Text typed or changed in the box is sent with plain LF line breaks.
- End-to-end encryption in the browser (PBKDF2-SHA256 with 600,000 iterations, AES-GCM-256). The server holds only encrypted data, in memory.
- Live updates over a WebSocket, with automatic reconnection and catching up.
- One link to join, a "Copy invite" text, and the option to send the link and password separately.
- Replies, reactions (👍 ❤️ 😂 🎉 👀 ✅) and pinned notes.
- Burn after reading: a note the first other person can open once, after which it is deleted for everyone.
- Light, dark and system themes.
- Interface in English, Dutch, German, French, Spanish and Japanese.
- Sessions that expire after 1 hour to 7 days, can be ended or cleared, and are deleted roughly 2-3 minutes after everyone has left.
- Per-IP wrong-password lockout, a limit on new sessions per IP, and per-note, per-session and server-wide size limits.
- The `pastepage` command, configuration through environment variables or a `.env` file, and example configurations for systemd, Caddy, nginx and Apache.

[Unreleased]: https://github.com/sidebitio/pastepage/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sidebitio/pastepage/releases/tag/v0.1.0
