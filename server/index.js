const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static PWA files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check for Cloud Run
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── State ───────────────────────────────────────────────
const rooms = new Map();       // roomCode → { host, listeners, videoState, createdAt }
const clientRooms = new Map(); // ws → { roomCode, userId, name, role }

// ─── Helpers ─────────────────────────────────────────────
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function broadcast(roomCode, message, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const payload = JSON.stringify(message);

    if (room.host?.ws && room.host.ws !== excludeWs && room.host.ws.readyState === 1) {
        room.host.ws.send(payload);
    }

    for (const [, listener] of room.listeners) {
        if (listener.ws && listener.ws !== excludeWs && listener.ws.readyState === 1) {
            listener.ws.send(payload);
        }
    }
}

function sendTo(ws, message) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(message));
    }
}

function getRoomInfo(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return null;

    const listeners = [];
    for (const [, l] of room.listeners) {
        listeners.push({ userId: l.userId, name: l.name });
    }

    return {
        roomCode,
        hostName: room.host?.name || 'Unknown',
        listeners,
        listenerCount: room.listeners.size,
        videoState: room.videoState || null,
        createdAt: room.createdAt
    };
}

// ─── WebSocket Handler ───────────────────────────────────
wss.on('connection', (ws) => {
    const userId = uuidv4().slice(0, 8);
    console.log(`[WS] Client connected: ${userId}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        switch (msg.type) {

            // ━━━ Room Management ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

            case 'CREATE_ROOM': {
                leaveRoom(ws);

                const roomCode = generateRoomCode();
                const name = (msg.name || 'Host').slice(0, 20);

                rooms.set(roomCode, {
                    host: { ws, userId, name },
                    listeners: new Map(),
                    videoState: null,
                    createdAt: Date.now()
                });

                clientRooms.set(ws, { roomCode, userId, name, role: 'host' });

                sendTo(ws, {
                    type: 'ROOM_CREATED',
                    roomCode,
                    userId,
                    roomInfo: getRoomInfo(roomCode)
                });

                console.log(`[ROOM] Created: ${roomCode} by ${name}`);
                break;
            }

            case 'JOIN_ROOM': {
                const code = (msg.roomCode || '').toUpperCase().trim();
                const name = (msg.name || 'Listener').slice(0, 20);
                const room = rooms.get(code);

                if (!room) {
                    sendTo(ws, { type: 'ERROR', message: 'Room not found. Check the code and try again.' });
                    return;
                }

                if (room.listeners.size >= 50) {
                    sendTo(ws, { type: 'ERROR', message: 'Room is full (max 50 listeners).' });
                    return;
                }

                leaveRoom(ws);

                room.listeners.set(userId, { ws, userId, name });
                clientRooms.set(ws, { roomCode: code, userId, name, role: 'listener' });

                // Tell the joiner (including current video state)
                sendTo(ws, {
                    type: 'ROOM_JOINED',
                    roomCode: code,
                    userId,
                    roomInfo: getRoomInfo(code)
                });

                // Tell everyone else
                broadcast(code, {
                    type: 'USER_JOINED',
                    userId,
                    name,
                    listenerCount: room.listeners.size,
                    roomInfo: getRoomInfo(code)
                }, ws);

                console.log(`[ROOM] ${name} joined ${code} (${room.listeners.size} listeners)`);
                break;
            }

            case 'LEAVE_ROOM': {
                leaveRoom(ws);
                sendTo(ws, { type: 'LEFT_ROOM' });
                break;
            }

            // ━━━ YouTube Sync ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

            case 'PLAY_URL': {
                // Host sends a YouTube URL to play
                const info = clientRooms.get(ws);
                if (!info || info.role !== 'host') return;

                const room = rooms.get(info.roomCode);
                if (!room) return;

                room.videoState = {
                    videoId: (msg.videoId || '').slice(0, 20),
                    title: (msg.title || 'Unknown').slice(0, 100),
                    isPlaying: true,
                    currentTime: 0,
                    timestamp: Date.now()
                };

                broadcast(info.roomCode, {
                    type: 'PLAY_URL',
                    ...room.videoState
                }, ws);

                console.log(`[VIDEO] Host playing: ${room.videoState.title} (${room.videoState.videoId})`);
                break;
            }

            case 'SYNC_STATE': {
                // Host syncs playback state (play/pause/seek)
                const info = clientRooms.get(ws);
                if (!info || info.role !== 'host') return;

                const room = rooms.get(info.roomCode);
                if (!room) return;

                // Update room's video state
                if (room.videoState) {
                    room.videoState.isPlaying = !!msg.isPlaying;
                    room.videoState.currentTime = msg.currentTime || 0;
                    room.videoState.timestamp = Date.now();
                }

                // Broadcast to listeners only (not back to host)
                broadcast(info.roomCode, {
                    type: 'SYNC_STATE',
                    action: msg.action, // 'play', 'pause', 'seek'
                    isPlaying: !!msg.isPlaying,
                    currentTime: msg.currentTime || 0
                }, ws);

                break;
            }

            // ━━━ Controls (Listener → Host) ━━━━━━━━━━━━━━━━━━━

            case 'CONTROL': {
                const info = clientRooms.get(ws);
                if (!info) return;

                const room = rooms.get(info.roomCode);
                if (!room) return;

                if (info.role === 'listener' && room.host?.ws) {
                    // Listener sends control to host
                    sendTo(room.host.ws, {
                        type: 'CONTROL',
                        action: msg.action,
                        fromName: info.name,
                        fromUserId: info.userId
                    });
                }
                break;
            }

            // ━━━ Chat & Reactions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

            case 'CHAT': {
                const info = clientRooms.get(ws);
                if (!info) return;

                broadcast(info.roomCode, {
                    type: 'CHAT',
                    userId: info.userId,
                    name: info.name,
                    message: (msg.message || '').slice(0, 500),
                    timestamp: Date.now()
                });
                console.log(`[CHAT] ${info.name}: ${(msg.message || '').slice(0, 50)}`);
                break;
            }

            case 'REACTION': {
                const info = clientRooms.get(ws);
                if (!info) return;

                broadcast(info.roomCode, {
                    type: 'REACTION',
                    userId: info.userId,
                    name: info.name,
                    emoji: (msg.emoji || '').slice(0, 4)
                }, ws);
                break;
            }

            // ━━━ Search (Listener → Host) ━━━━━━━━━━━━━━━━━━━━━

            case 'SEARCH': {
                const info = clientRooms.get(ws);
                if (!info) return;

                const room = rooms.get(info.roomCode);
                if (!room || !room.host?.ws) return;

                sendTo(room.host.ws, {
                    type: 'SEARCH',
                    query: (msg.query || '').slice(0, 200),
                    fromName: info.name
                });
                break;
            }

            default:
                break;
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${userId}`);
        leaveRoom(ws);
        clientRooms.delete(ws);
    });

    ws.on('error', () => {
        leaveRoom(ws);
        clientRooms.delete(ws);
    });
});

// ─── Leave Room Logic ────────────────────────────────────
function leaveRoom(ws) {
    const info = clientRooms.get(ws);
    if (!info) return;

    const room = rooms.get(info.roomCode);
    if (!room) return;

    if (info.role === 'host') {
        broadcast(info.roomCode, {
            type: 'ROOM_CLOSED',
            message: 'The host has ended the session.'
        }, ws);
        rooms.delete(info.roomCode);
        console.log(`[ROOM] Closed: ${info.roomCode} (host left)`);
    } else {
        room.listeners.delete(info.userId);
        broadcast(info.roomCode, {
            type: 'USER_LEFT',
            userId: info.userId,
            name: info.name,
            listenerCount: room.listeners.size,
            roomInfo: getRoomInfo(info.roomCode)
        });
        console.log(`[ROOM] ${info.name} left ${info.roomCode}`);
    }

    clientRooms.delete(ws);
}

// ─── Heartbeat ───────────────────────────────────────────
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            leaveRoom(ws);
            clientRooms.delete(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ─── Cleanup stale rooms ─────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (room.listeners.size === 0 && now - room.createdAt > 6 * 60 * 60 * 1000) {
            rooms.delete(code);
            console.log(`[CLEANUP] Removed stale room: ${code}`);
        }
    }
}, 5 * 60 * 1000);

// ─── Start Server ────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n  🎵 JamSync Server running on http://localhost:${PORT}\n`);
});
