# Changelog

All notable changes to PastePage are listed in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A Width setting (Normal or Wide) in the settings menu: Wide lets the session view use the full window width, so code lines have more room. The choice is remembered in the browser.

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
