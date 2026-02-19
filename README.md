# 🎵 JamSync PWA

Listen to music together — anywhere in the world. A cross-network music sync app built as a Progressive Web App.

## Features
- **Room Codes** — Create a room, share the 6-digit code
- **Audio Streaming** — Host shares tab audio via WebRTC
- **Live Chat** — Real-time chat with room members
- **Reactions** — Floating emoji reactions (🔥❤️😂👏🎉👎)
- **Playback Controls** — Listeners can control playback
- **Search** — Search forwarded to host's music tab
- **PWA** — Install on mobile or desktop

## Run Locally

```bash
cd server
npm install
node index.js
# Open http://localhost:8080
```

## Deploy

### Render.com (recommended)
1. Fork/push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect repo → set **Build Command**: `cd server && npm install`
4. Set **Start Command**: `node server/index.js`
5. Deploy!

### Docker
```bash
docker build -t jamsync .
docker run -p 8080:8080 jamsync
```

## Tech Stack
- **Server**: Node.js + Express + WebSocket (ws)
- **Frontend**: Vanilla HTML/CSS/JS
- **Audio**: WebRTC with STUN
- **PWA**: Service Worker + Web App Manifest
