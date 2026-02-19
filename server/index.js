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

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── Data Structures ────────────────────────────────────
const rooms = new Map();       // roomCode → Room
const clientRooms = new Map(); // ws → { roomCode, userId, name, role }

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function getRoomInfo(room) {
    return {
        roomCode: room.code,
        hostName: room.hostName,
        listenerCount: room.listeners.size,
        listeners: Array.from(room.listeners.values()).map(l => ({
            userId: l.userId,
            name: l.name
        })),
        videoState: room.videoState || null,
        isStreaming: room.isStreaming || false
    };
}

function sendTo(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(room, data, excludeWs = null) {
    // Send to host
    if (room.hostWs !== excludeWs) sendTo(room.hostWs, data);
    // Send to all listeners
    for (const [, listener] of room.listeners) {
        if (listener.ws !== excludeWs) sendTo(listener.ws, data);
    }
}

// ─── WebSocket Handler ──────────────────────────────────
wss.on('connection', (ws) => {
    const clientId = uuidv4().slice(0, 8);
    console.log(`[WS] Client connected: ${clientId}`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            // ━━━ Create Room ━━━━━━━━━━━━━━━━━━━━━━━━━━
            case 'CREATE_ROOM': {
                const code = generateCode();
                const userId = uuidv4().slice(0, 8);
                const name = (msg.name || 'Host').slice(0, 30);

                const room = {
                    code,
                    hostWs: ws,
                    hostUserId: userId,
                    hostName: name,
                    listeners: new Map(),
                    videoState: null,
                    isStreaming: false
                };

                rooms.set(code, room);
                clientRooms.set(ws, { roomCode: code, userId, name, role: 'host' });

                sendTo(ws, {
                    type: 'ROOM_CREATED',
                    roomCode: code,
                    userId,
                    roomInfo: getRoomInfo(room)
                });

                console.log(`[ROOM] Created: ${code} by ${name}`);
                break;
            }

            // ━━━ Join Room ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            case 'JOIN_ROOM': {
                const code = (msg.roomCode || '').toUpperCase();
                const room = rooms.get(code);

                if (!room) {
                    sendTo(ws, { type: 'ERROR', message: 'Room not found' });
                    return;
                }

                const userId = uuidv4().slice(0, 8);
                const name = (msg.name || 'Listener').slice(0, 30);

                room.listeners.set(userId, { ws, userId, name });
                clientRooms.set(ws, { roomCode: code, userId, name, role: 'listener' });

                sendTo(ws, {
                    type: 'ROOM_JOINED',
                    roomCode: code,
                    userId,
                    roomInfo: getRoomInfo(room)
                });

                // Notify everyone else
                broadcast(room, {
                    type: 'USER_JOINED',
                    userId,
                    name,
                    listenerCount: room.listeners.size,
                    roomInfo: getRoomInfo(room)
                }, ws);

                console.log(`[ROOM] ${name} joined ${code} (${room.listeners.size} listeners)`);
                break;
            }

            // ━━━ Leave Room ━━━━━━━━━━━━━━━━━━━━━━━━━━━
            case 'LEAVE_ROOM': {
                handleLeave(ws);
                sendTo(ws, { type: 'LEFT_ROOM' });
                break;
            }

            // ━━━ Chat ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            case 'CHAT': {
                const info = clientRooms.get(ws);
                if (!info) return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                broadcast(room, {
                    type: 'CHAT',
                    userId: info.userId,
                    name: info.name,
                    message: (msg.message || '').slice(0, 500)
                });
                break;
            }

            // ━━━ Reaction ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            case 'REACTION': {
                const info = clientRooms.get(ws);
                if (!info) return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                broadcast(room, {
                    type: 'REACTION',
                    userId: info.userId,
                    emoji: (msg.emoji || '🎵').slice(0, 4)
                }, ws);
                break;
            }

            // ━━━ YouTube: Play URL ━━━━━━━━━━━━━━━━━━━
            case 'PLAY_URL': {
                const info = clientRooms.get(ws);
                if (!info) return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                room.videoState = {
                    videoId: msg.videoId,
                    title: msg.title || 'Now Playing',
                    isPlaying: true,
                    currentTime: 0,
                    timestamp: Date.now()
                };

                broadcast(room, {
                    type: 'PLAY_URL',
                    videoId: msg.videoId,
                    title: msg.title
                }, ws);
                break;
            }

            // ━━━ YouTube: Sync State ━━━━━━━━━━━━━━━━━
            case 'SYNC_STATE': {
                const info = clientRooms.get(ws);
                if (!info || info.role !== 'host') return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                if (room.videoState) {
                    room.videoState.isPlaying = msg.isPlaying;
                    room.videoState.currentTime = msg.currentTime;
                    room.videoState.timestamp = Date.now();
                }

                // Forward to all listeners
                for (const [, listener] of room.listeners) {
                    sendTo(listener.ws, {
                        type: 'SYNC_STATE',
                        action: msg.action,
                        isPlaying: msg.isPlaying,
                        currentTime: msg.currentTime
                    });
                }
                break;
            }

            // ━━━ Controls (Listener → Host) ━━━━━━━━━━
            case 'CONTROL': {
                const info = clientRooms.get(ws);
                if (!info) return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                if (info.role === 'listener') {
                    sendTo(room.hostWs, {
                        type: 'CONTROL',
                        action: msg.action,
                        fromUserId: info.userId,
                        fromName: info.name
                    });
                }
                break;
            }

            // ━━━ WebRTC Signaling ━━━━━━━━━━━━━━━━━━━━
            case 'SIGNAL': {
                const info = clientRooms.get(ws);
                if (!info) return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                const { targetUserId, signal } = msg;

                // Find target WebSocket
                let targetWs = null;
                if (targetUserId === room.hostUserId) {
                    targetWs = room.hostWs;
                } else {
                    const listener = room.listeners.get(targetUserId);
                    if (listener) targetWs = listener.ws;
                }

                if (targetWs) {
                    sendTo(targetWs, {
                        type: 'SIGNAL',
                        fromUserId: info.userId,
                        signal
                    });
                }
                break;
            }

            // ━━━ Stream Status ━━━━━━━━━━━━━━━━━━━━━━━
            case 'STREAM_STATUS': {
                const info = clientRooms.get(ws);
                if (!info || info.role !== 'host') return;
                const room = rooms.get(info.roomCode);
                if (!room) return;

                room.isStreaming = msg.isStreaming;

                broadcast(room, {
                    type: 'STREAM_STATUS',
                    isStreaming: msg.isStreaming,
                    roomInfo: getRoomInfo(room)
                }, ws);

                // If host started streaming, tell host about all listeners
                if (msg.isStreaming) {
                    for (const [, listener] of room.listeners) {
                        sendTo(ws, {
                            type: 'INITIATE_PEER',
                            targetUserId: listener.userId,
                            targetName: listener.name
                        });
                    }
                }
                break;
            }

            default:
                break;
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${clientId}`);
        handleLeave(ws);
    });
});

function handleLeave(ws) {
    const info = clientRooms.get(ws);
    if (!info) return;

    const room = rooms.get(info.roomCode);
    if (!room) { clientRooms.delete(ws); return; }

    if (info.role === 'host') {
        broadcast(room, {
            type: 'ROOM_CLOSED',
            message: 'Host closed the room'
        }, ws);
        rooms.delete(info.roomCode);
        console.log(`[ROOM] Closed: ${info.roomCode}`);
    } else {
        room.listeners.delete(info.userId);

        // Notify host to clean up WebRTC for this listener
        sendTo(room.hostWs, {
            type: 'PEER_LEFT',
            userId: info.userId
        });

        broadcast(room, {
            type: 'USER_LEFT',
            userId: info.userId,
            name: info.name,
            listenerCount: room.listeners.size,
            roomInfo: getRoomInfo(room)
        });
        console.log(`[ROOM] ${info.name} left ${info.roomCode} (${room.listeners.size} listeners)`);
    }

    clientRooms.delete(ws);
}

server.listen(PORT, () => {
    console.log(`\n  🎵 JamSync Server running on http://localhost:${PORT}\n`);
});
