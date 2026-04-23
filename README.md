# QuickDrop

> Instant, peer-to-peer file sharing across devices on the same network — no uploads, no accounts, no cloud.

QuickDrop is a self-hosted alternative to Snapdrop / PairDrop that solves one of the most annoying problems in a multi-device workflow: moving files between your phone, laptop, tablet, and desktop without involving email, chat apps, cables, or a third-party cloud.

Everything stays on your network. The server only helps devices discover each other and exchange a WebRTC handshake; the files themselves travel directly between browsers over an encrypted data channel.

## Why this exists

If you've ever:

- AirDropped a file from your iPhone only to realize you need to get it to a Windows machine
- Emailed a PDF to yourself just to open it on another device
- Plugged in a USB cable to move a single screenshot
- Uploaded a 400 MB file to Drive/Dropbox just to download it again five seconds later on the laptop right next to you

…this is for you. QuickDrop works in any modern browser, on any OS, with zero setup on the client side. If a device can open a web page, it can send and receive files.

## Features

- **True P2P transfer** — files move browser-to-browser via WebRTC data channels; the server never sees your data
- **Cross-platform by default** — Windows, macOS, Linux, iOS, Android, ChromeOS; anything with a modern browser
- **Automatic device discovery** — devices on the same local subnet find each other automatically, Snapdrop-style
- **Rooms for cross-network sharing** — join the same room code on two devices to connect them even when they're on different networks
- **Text and link sharing** — send a URL or snippet of text, not just files
- **Drag-and-drop** + file picker + multi-file selection
- **Transfer acceptance flow** — the receiver explicitly accepts or declines every transfer
- **Installable PWA** — add it to your home screen / desktop and it behaves like a native app
- **Dark glass UI** with animated radar visualization of nearby devices

## Architecture

```
┌─────────────┐                ┌─────────────┐
│  Browser A  │                │  Browser B  │
│             │                │             │
│   app.js    │                │   app.js    │
└──────┬──────┘                └──────┬──────┘
       │                              │
       │   WebSocket (signaling)      │
       └──────────────┬───────────────┘
                      │
              ┌───────▼────────┐
              │  Node server   │
              │  (server.js)   │
              │                │
              │ - Presence     │
              │ - Codenames    │
              │ - SDP relay    │
              │ - ICE relay    │
              └────────────────┘

       ╔══════════════════════════════╗
       ║     WebRTC DataChannel       ║
       ║  (files flow directly here,  ║
       ║   never through the server)  ║
       ╚══════════════════════════════╝
```

**Signaling (Node + `ws`)** handles three things and nothing else: assigning each connected browser a random codename (e.g. *Silent Fox*, *Thunder Panda*), grouping devices by subnet or by room code, and relaying WebRTC SDP offers/answers and ICE candidates between peers. There is no database, no file storage, and no user accounts.

**Data plane (WebRTC)** carries every byte of every file. Once two browsers complete the ICE handshake, the signaling server is no longer in the path. Transfers are chunked at 16 KB and flow-controlled with `bufferedAmountLowThreshold` so large files don't blow up memory.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Server runtime | Node.js + Express 5 | Static asset delivery, tiny surface area |
| Signaling | `ws` WebSocket server | Low-overhead bidirectional channel |
| Session IDs | `uuid` v4 | Collision-free peer identification |
| Transport | WebRTC DataChannel | Encrypted, direct, no server bandwidth cost |
| Client | Vanilla JS (no framework) | Zero build step, loads instantly |
| Styling | Hand-written CSS with glassmorphism | No Tailwind/PostCSS toolchain |
| Offline | Service Worker (PWA) | Installable, works after first load |

## Getting started

Requires Node.js 18 or later.

```bash
# 1. Install dependencies
npm install

# 2. Run the server
node server.js
```

You'll see output like:

```
  QuickDrop signaling server running!

  Local:   http://localhost:3000
  Network: http://192.168.1.42:3000
```

Open the **Network** URL on every device you want to share between. They should appear on each other's radar within a second or two.

### Sharing a file

1. Open the Network URL on two devices connected to the same Wi-Fi / LAN
2. Each device shows up on the other's radar with a random codename
3. Click the target device → drop a file (or type a message) → it asks the recipient to accept
4. Recipient accepts → transfer runs → downloaded file appears in the Activity log

### Cross-network sharing (rooms)

Devices on different networks won't auto-discover each other. To connect them:

1. Click the **Room** button in the header on both devices
2. Enter the same code (e.g. `myroom`) on both
3. They now see each other and can transfer exactly as if they were on the same LAN

Note: WebRTC may need a TURN server to punch through strict NATs. QuickDrop ships with STUN only; you can add TURN servers to `ICE_SERVERS` in `public/app.js` if you need it for hostile network environments.

## File structure

```
QuickDrop/
├── server.js              # Signaling server (WebSocket + static hosting)
├── package.json
└── public/
    ├── index.html         # UI shell
    ├── app.js             # All client logic: signaling, WebRTC, chunking, UI
    ├── style.css          # Glass UI + radar animations
    ├── manifest.json      # PWA manifest
    └── sw.js              # Service worker (offline shell)
```

The entire codebase is small on purpose. If you want to audit it before running it on your network, you can read every line in an afternoon.

## Privacy & security

- **No files touch the server.** The server relays ~5 KB of handshake JSON per connection and nothing else.
- **No accounts, no tracking, no analytics.** There is no telemetry of any kind.
- **WebRTC data channels are encrypted** (DTLS/SRTP) end-to-end by the browser.
- **Session IDs and codenames are regenerated every connection** — nothing persists across restarts.
- **IP-based rate limiting** caps the number of concurrent connections per source IP to prevent abuse when hosted on the open internet.

## Configuration

All tunables are near the top of `server.js` and `public/app.js`:

| Setting | Location | Default | Purpose |
|---|---|---|---|
| `PORT` | env var | `3000` | Port the server listens on |
| `MAX_CONNECTIONS_PER_IP` | `server.js` | `10` | Anti-abuse cap |
| `MAX_ROOM_SIZE` | `server.js` | `10` | Devices per room |
| `STALE_TIMEOUT` | `server.js` | `30000` ms | Drop dead sessions after this |
| `CHUNK_SIZE` | `app.js` | `16 KB` | File chunk size over the data channel |
| `BUFFER_THRESHOLD` | `app.js` | `4 MB` | Backpressure high-water mark |
| `ICE_SERVERS` | `app.js` | Google STUN | Add TURN here if needed |

## Roadmap

These are things that could reasonably land without bloating the project:

- [ ] Optional TURN server config via environment variables
- [ ] Resumable transfers for very large files
- [ ] End-to-end integrity check (SHA-256 per file)
- [ ] Mobile-specific UI polish (the radar gets tight on small phones)
- [ ] Keyboard shortcuts for power users
- [ ] Transfer queue / cancellation mid-flight

## Known limitations

- Requires a modern browser with WebRTC (≥ 2018 effectively — not a concern in practice)
- Devices connecting via `localhost` and devices connecting via the LAN IP are treated as being on different subnets and won't see each other — use the LAN IP on both, or use a Room
- Very strict corporate/symmetric NATs may block P2P without a TURN server
- Not designed for transfers across the public internet at scale — use rooms sparingly there

## License

ISC — do whatever you want. Attribution appreciated but not required.

## Credits

Inspired by [Snapdrop](https://snapdrop.net/) and [PairDrop](https://pairdrop.net/), which pioneered this style of local-network browser-to-browser sharing. QuickDrop is a ground-up reimplementation, not a fork.

---

*Built to scratch a personal itch: I was tired of emailing files to myself.*
