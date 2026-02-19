/* ═══════════════════════════════════════════════════════════
   JamSync PWA — Main Application
   WebSocket client, WebRTC audio, room management
   ═══════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    // ─── DOM Helpers ────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ─── State ──────────────────────────────────────────────
    let ws = null;
    let myUserId = null;
    let myName = '';
    let myRole = null;        // 'host' | 'listener'
    let currentRoom = null;
    let localStream = null;   // Host's captured audio stream
    let peerConnections = {}; // userId → RTCPeerConnection (Host manages these)

    // WebRTC config with public STUN/TURN
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    };

    // ─── Toast System ───────────────────────────────────────
    function showToast(message, isError = false) {
        // Remove existing toast
        document.querySelectorAll('.toast').forEach(t => t.remove());

        const toast = document.createElement('div');
        toast.className = `toast${isError ? ' error' : ''}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => toast.classList.add('show'));
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
        }, 3000);
    }

    // ─── Screen Navigation ─────────────────────────────────
    function showScreen(screenId) {
        $$('.screen').forEach(s => s.classList.remove('active'));
        $(screenId).classList.add('active');
    }

    // ─── WebSocket Connection ──────────────────────────────
    function connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}`;

        ws = new WebSocket(wsUrl);

        ws.addEventListener('open', () => {
            console.log('[WS] Connected');
        });

        ws.addEventListener('message', (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            handleServerMessage(msg);
        });

        ws.addEventListener('close', () => {
            console.log('[WS] Disconnected');
            // Auto-reconnect after 3s
            setTimeout(connectWebSocket, 3000);
        });

        ws.addEventListener('error', () => {
            console.log('[WS] Error');
        });
    }

    function send(message) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    // ─── Server Message Handler ────────────────────────────
    function handleServerMessage(msg) {
        switch (msg.type) {

            case 'ROOM_CREATED':
                myUserId = msg.userId;
                myRole = 'host';
                currentRoom = msg.roomCode;
                enterRoom(msg.roomInfo);
                showToast(`Room created! Code: ${msg.roomCode}`);
                break;

            case 'ROOM_JOINED':
                myUserId = msg.userId;
                myRole = 'listener';
                currentRoom = msg.roomCode;
                enterRoom(msg.roomInfo);
                showToast(`Joined room ${msg.roomCode}`);
                break;

            case 'ERROR':
                showToast(msg.message, true);
                break;

            case 'USER_JOINED':
                addSystemMessage(`${msg.name} joined the room`);
                updateListenerCount(msg.listenerCount);
                if (msg.roomInfo) updateListenerList(msg.roomInfo);
                break;

            case 'USER_LEFT':
                addSystemMessage(`${msg.name} left the room`);
                updateListenerCount(msg.listenerCount);
                if (msg.roomInfo) updateListenerList(msg.roomInfo);
                // Clean up peer connection if host
                if (myRole === 'host' && peerConnections[msg.userId]) {
                    peerConnections[msg.userId].close();
                    delete peerConnections[msg.userId];
                }
                break;

            case 'ROOM_CLOSED':
                showToast(msg.message, true);
                cleanup();
                showScreen('landingScreen');
                break;

            case 'LEFT_ROOM':
                cleanup();
                showScreen('landingScreen');
                break;

            // ─── WebRTC Signaling ───────────────
            case 'INITIATE_PEER':
                // Host: create offer for new listener
                if (myRole === 'host' && localStream) {
                    createPeerConnection(msg.targetUserId, true);
                }
                break;

            case 'SIGNAL':
                handleSignal(msg);
                break;

            // ─── Chat & Reactions ───────────────
            case 'CHAT':
                addChatMessage(msg.name, msg.message, msg.userId === myUserId);
                break;

            case 'REACTION':
                showFloatingReaction(msg.emoji);
                break;

            // ─── Playback ──────────────────────
            case 'TRACK_UPDATE':
                $('npTitle').textContent = msg.title || 'Unknown Track';
                $('npArtist').textContent = msg.artist || '';
                break;

            case 'CONTROL':
                // Host receives control from listener
                if (myRole === 'host') {
                    showToast(`${msg.fromName} pressed ${msg.action}`);
                    // In a real implementation, this would control the music player
                }
                break;

            case 'SEARCH':
                if (myRole === 'host') {
                    showToast(`${msg.fromName} searched: "${msg.query}"`);
                }
                break;
        }
    }

    // ─── Enter Room UI ─────────────────────────────────────
    function enterRoom(roomInfo) {
        showScreen('roomScreen');
        $('roomCodeText').textContent = roomInfo.roomCode;
        updateListenerCount(roomInfo.listenerCount);
        updateListenerList(roomInfo);

        // Show share audio button for host
        if (myRole === 'host') {
            $('btnShareAudio').classList.remove('hidden');
        } else {
            $('btnShareAudio').classList.add('hidden');
        }

        // Update track info if available
        if (roomInfo.trackInfo) {
            $('npTitle').textContent = roomInfo.trackInfo.title || 'Waiting for audio…';
            $('npArtist').textContent = roomInfo.trackInfo.artist || '';
        }
    }

    // ─── Listener List ─────────────────────────────────────
    function updateListenerList(roomInfo) {
        const list = $('listenerList');
        list.innerHTML = '';

        // Add host
        const hostEl = createListenerItem(roomInfo.hostName, 'HOST');
        list.appendChild(hostEl);

        // Add listeners
        if (roomInfo.listeners && roomInfo.listeners.length > 0) {
            roomInfo.listeners.forEach(l => {
                list.appendChild(createListenerItem(l.name, 'LISTENER'));
            });
        }

        if (roomInfo.listeners.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'Share the room code to invite listeners!';
            list.appendChild(empty);
        }
    }

    function createListenerItem(name, role) {
        const item = document.createElement('div');
        item.className = 'listener-item';
        item.innerHTML = `
      <div class="listener-avatar">${(name || '?')[0].toUpperCase()}</div>
      <span class="listener-name">${escapeHtml(name)}</span>
      <span class="listener-role${role === 'HOST' ? ' host' : ''}">${role}</span>
    `;
        return item;
    }

    function updateListenerCount(count) {
        $('listenerCount').textContent = `${count} listening`;
    }

    // ─── Chat ──────────────────────────────────────────────
    function addChatMessage(name, text, isSelf) {
        const container = $('chatMessages');
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble${isSelf ? ' self' : ''}`;
        bubble.innerHTML = `
      <div class="chat-name">${escapeHtml(name)}</div>
      <div class="chat-text">${escapeHtml(text)}</div>
    `;
        container.appendChild(bubble);
        container.scrollTop = container.scrollHeight;
    }

    function addSystemMessage(text) {
        const container = $('chatMessages');
        const msg = document.createElement('div');
        msg.className = 'system-msg';
        msg.textContent = text;
        container.appendChild(msg);
        container.scrollTop = container.scrollHeight;
    }

    // ─── Reactions ─────────────────────────────────────────
    function showFloatingReaction(emoji) {
        const container = $('reactionFloat');
        const el = document.createElement('div');
        el.className = 'floating-reaction';
        el.textContent = emoji;
        el.style.left = `${20 + Math.random() * 60}%`;
        container.appendChild(el);
        setTimeout(() => el.remove(), 2000);
    }

    // ─── WebRTC ────────────────────────────────────────────
    async function startScreenShare() {
        try {
            // Browsers require video:true for getDisplayMedia
            // We request both, then keep only audio
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            // Check if we got an audio track
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length === 0) {
                // Stop video tracks since we don't need them
                displayStream.getTracks().forEach(t => t.stop());
                showToast('No audio detected! Make sure to check "Share tab audio" in the share dialog.', true);
                return;
            }

            // Create a new stream with only the audio track
            localStream = new MediaStream(audioTracks);

            // Stop video tracks — we only need audio
            displayStream.getVideoTracks().forEach(t => t.stop());

            $('btnShareAudio').textContent = '🎵 Streaming Audio…';
            $('btnShareAudio').classList.add('streaming');
            $('npTitle').textContent = 'Streaming your audio';

            // Send track update
            send({
                type: 'TRACK_UPDATE',
                title: 'Live Audio Stream',
                artist: myName,
                platform: 'Screen Share',
                isPlaying: true
            });

            // Handle stream ending
            audioTracks[0].addEventListener('ended', () => {
                stopSharing();
            });

            showToast('Audio sharing started!');

            // Notify server to initiate peer connections for existing listeners
            send({ type: 'AUDIO_READY' });

        } catch (err) {
            console.error('[WebRTC] Screen share error:', err);
            if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
                showToast('Sharing cancelled. Click Share Tab Audio and select a tab to share.', true);
            } else if (err.name === 'NotSupportedError') {
                showToast('Your browser does not support screen sharing. Try Chrome or Edge on desktop.', true);
            } else {
                showToast(`Audio error: ${err.message || 'Unknown error'}. Try Chrome on desktop.`, true);
            }
        }
    }

    function stopSharing() {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        $('btnShareAudio').textContent = 'Share Tab Audio';
        $('btnShareAudio').classList.remove('streaming');
        $('npTitle').textContent = 'Waiting for audio…';
        $('npArtist').textContent = '';

        send({
            type: 'TRACK_UPDATE',
            title: 'Stream ended',
            isPlaying: false
        });
    }

    function createPeerConnection(targetUserId, isInitiator) {
        // Close existing connection if any
        if (peerConnections[targetUserId]) {
            peerConnections[targetUserId].close();
        }

        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[targetUserId] = pc;

        // Add local stream tracks (host sending audio)
        if (localStream && myRole === 'host') {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        // Handle incoming stream (listener receiving audio)
        pc.ontrack = (event) => {
            console.log('[WebRTC] Received remote track');
            const audio = $('remoteAudio');
            audio.srcObject = event.streams[0];
            audio.play().catch(e => console.log('Autoplay blocked:', e));
            $('npTitle').textContent = 'Receiving live audio…';
        };

        // ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                send({
                    type: 'SIGNAL',
                    targetUserId,
                    signal: { type: 'ice-candidate', candidate: event.candidate }
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[WebRTC] Connection state (${targetUserId}):`, pc.connectionState);
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                pc.close();
                delete peerConnections[targetUserId];
            }
        };

        // Create offer if initiator (host)
        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    send({
                        type: 'SIGNAL',
                        targetUserId,
                        signal: { type: 'offer', sdp: pc.localDescription }
                    });
                })
                .catch(err => console.error('[WebRTC] Offer error:', err));
        }

        return pc;
    }

    function handleSignal(msg) {
        const { fromUserId, signal } = msg;

        if (signal.type === 'offer') {
            // Listener received offer from host
            const pc = createPeerConnection(fromUserId, false);
            pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
                .then(() => pc.createAnswer())
                .then(answer => pc.setLocalDescription(answer))
                .then(() => {
                    send({
                        type: 'SIGNAL',
                        targetUserId: fromUserId,
                        signal: { type: 'answer', sdp: pc.localDescription }
                    });
                })
                .catch(err => console.error('[WebRTC] Answer error:', err));

        } else if (signal.type === 'answer') {
            // Host received answer from listener
            const pc = peerConnections[fromUserId];
            if (pc) {
                pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
                    .catch(err => console.error('[WebRTC] setRemoteDescription error:', err));
            }

        } else if (signal.type === 'ice-candidate') {
            const pc = peerConnections[fromUserId];
            if (pc) {
                pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
                    .catch(err => console.error('[WebRTC] ICE error:', err));
            }
        }
    }

    // ─── Cleanup ───────────────────────────────────────────
    function cleanup() {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};
        currentRoom = null;
        myRole = null;

        // Reset UI
        $('chatMessages').innerHTML = '<div class="system-msg">Welcome to the room! Say hi 👋</div>';
        $('npTitle').textContent = 'Waiting for audio…';
        $('npArtist').textContent = '';
        $('btnShareAudio').textContent = 'Share Tab Audio';
        $('btnShareAudio').classList.remove('streaming');
    }

    // ─── Utility ───────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ═══ Event Listeners ═══════════════════════════════════

    // Landing — Create Room
    $('btnCreate').addEventListener('click', () => {
        myName = $('nameInput').value.trim() || 'Anonymous';
        send({ type: 'CREATE_ROOM', name: myName });
    });

    // Landing — Toggle Join Section
    $('btnJoinToggle').addEventListener('click', () => {
        const section = $('joinSection');
        section.classList.toggle('hidden');
        if (!section.classList.contains('hidden')) {
            $('codeInput').focus();
        }
    });

    // Landing — Join Room
    $('btnJoin').addEventListener('click', () => {
        myName = $('nameInput').value.trim() || 'Anonymous';
        const code = $('codeInput').value.trim().toUpperCase();
        if (!code) {
            showToast('Enter a room code', true);
            return;
        }
        send({ type: 'JOIN_ROOM', roomCode: code, name: myName });
    });

    $('codeInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('btnJoin').click();
    });

    // Room — Leave
    $('btnLeave').addEventListener('click', () => {
        if (confirm('Leave this room?')) {
            send({ type: 'LEAVE_ROOM' });
        }
    });

    // Room — Copy Room Code
    $('roomCodeBadge').addEventListener('click', () => {
        const code = $('roomCodeText').textContent;
        navigator.clipboard.writeText(code).then(() => {
            showToast('Room code copied!');
        }).catch(() => {
            showToast(code);
        });
    });

    // Room — Share Audio (Host)
    $('btnShareAudio').addEventListener('click', () => {
        if (localStream) {
            stopSharing();
        } else {
            startScreenShare();
        }
    });

    // Room — Playback Controls
    $('btnToggle').addEventListener('click', () => {
        if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'TOGGLE' });
        }
    });
    $('btnPrev').addEventListener('click', () => {
        if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'PREV' });
        }
    });
    $('btnNext').addEventListener('click', () => {
        if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'NEXT' });
        }
    });

    // Room — Search
    function doSearch() {
        const query = $('searchInput').value.trim();
        if (!query) return;
        send({ type: 'SEARCH', query });
        $('searchInput').value = '';
        showToast(`Searching: "${query}"`);
    }
    $('btnSearch').addEventListener('click', doSearch);
    $('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    // Room — Chat
    function sendChat() {
        const text = $('chatInput').value.trim();
        if (!text) return;
        send({ type: 'CHAT', message: text });
        $('chatInput').value = '';
    }
    $('btnSend').addEventListener('click', sendChat);
    $('chatInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
    });

    // Room — Reactions
    $$('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const emoji = btn.dataset.emoji;
            send({ type: 'REACTION', emoji });
            showFloatingReaction(emoji);
        });
    });

    // Room — Tab Switching
    $$('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            $$('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            $$('.tab-panel').forEach(p => p.classList.remove('active'));
            $(`panel${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
        });
    });

    // ─── PWA Service Worker ────────────────────────────────
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(() => console.log('[PWA] Service worker registered'))
            .catch(err => console.log('[PWA] SW registration failed:', err));
    }

    // ─── Initialize ────────────────────────────────────────
    connectWebSocket();

})();
