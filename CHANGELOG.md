# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-23

First stable release of the SparkChat API.

### Added

- A REST API with Express 5 for sign-in, uploads, avatars, GIFs, link previews, and call notifications, and a Socket.IO API with 142 typed events for everything else.
- Accounts that never receive the password: the browser derives a secret, the server stores an scrypt hash of it, and fake salts hide which nicknames exist.
- Sessions bound to a P-256 device key, with signed requests and nonces, and socket session recovery after short disconnections.
- Storage and delivery of end-to-end encrypted messages, files, reactions, group names, and profile photos, with room keys sealed for each member and rotated when someone leaves.
- Key transparency, an optional append-only Merkle log of account keys with signed heads and an external witness.
- Voice and video call signaling with Cloudflare TURN credentials, call transfer between devices, and per-pair call limits.
- SparkAI, an assistant powered by Google Gemini that joins its own end-to-end encrypted chat.
- Web Push notifications that carry only opaque ids.
- Encrypted media on Cloudflare R2 with byte-signature checks, size limits, a storage quota, and sweeps for orphaned and expired uploads.
- A GIF gallery with KLIPY and link previews guarded against server-side request forgery.
- Docs generated from Zod schemas at `/docs`, with the OpenAPI spec and the Socket.IO event list.
- CI with lint, type checks, 1,679 tests, a build, and a Docker image smoke test, plus CodeQL, OpenSSF Scorecard, Dependabot, and a pull request title check.
- A README in English and Portuguese, issue forms, a code of conduct, and code owners.

[1.0.0]: https://github.com/Plovatto/API-SparkChat/releases/tag/v1.0.0
