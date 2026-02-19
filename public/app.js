/* ═══════════════════════════════════════════════════════════
   JamSync PWA v2 — YouTube Sync
   No screen share, no WebRTC. Just paste a URL and play.
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
    let ytPlayer = null;
    let ytReady = false;
    let isSyncing = false;    // Flag to prevent sync loops

    // ─── Toast System ───────────────────────────────────────
    function showToast(message, isError = false) {
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
    let messageQueue = [];
    let reconnectAttempts = 0;

    function connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}`;

        console.log('[WS] Connecting to:', wsUrl);
        ws = new WebSocket(wsUrl);

        ws.addEventListener('open', () => {
            console.log('[WS] Connected!');
            reconnectAttempts = 0;

            while (messageQueue.length > 0) {
                const msg = messageQueue.shift();
                ws.send(JSON.stringify(msg));
                console.log('[WS] Sent queued:', msg.type);
            }
        });

        ws.addEventListener('message', (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            console.log('[WS] Received:', msg.type);
            handleServerMessage(msg);
        });

        ws.addEventListener('close', (event) => {
            console.log('[WS] Disconnected, code:', event.code);
            reconnectAttempts++;
            const delay = Math.min(1000 * reconnectAttempts, 10000);
            setTimeout(connectWebSocket, delay);
        });

        ws.addEventListener('error', (err) => {
            console.error('[WS] Error:', err);
        });
    }

    function send(message) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            console.log('[WS] Sent:', message.type);
        } else {
            console.log('[WS] Queued:', message.type);
            messageQueue.push(message);
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                connectWebSocket();
            }
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

            // ─── YouTube Sync ────────────────────
            case 'PLAY_URL':
                loadVideo(msg.videoId, msg.title);
                break;

            case 'SYNC_STATE':
                handleSyncState(msg);
                break;

            // ─── Controls (Listener → Host) ──────
            case 'CONTROL':
                if (myRole === 'host') {
                    handleControlFromListener(msg);
                }
                break;

            // ─── Chat & Reactions ────────────────
            case 'CHAT':
                addChatMessage(msg.name, msg.message, msg.userId === myUserId);
                break;

            case 'REACTION':
                showFloatingReaction(msg.emoji);
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

        // Show URL input for host, hide for listener
        if (myRole === 'host') {
            $('urlInputSection').classList.remove('hidden');
        } else {
            $('urlInputSection').classList.add('hidden');
        }

        // If room already has a video playing, load it
        if (roomInfo.videoState && roomInfo.videoState.videoId) {
            loadVideo(roomInfo.videoState.videoId, roomInfo.videoState.title);
            // Seek to current position if playing
            if (roomInfo.videoState.isPlaying && roomInfo.videoState.currentTime > 0) {
                const elapsed = (Date.now() - roomInfo.videoState.timestamp) / 1000;
                const seekTo = roomInfo.videoState.currentTime + elapsed;
                setTimeout(() => {
                    if (ytPlayer && ytReady) {
                        ytPlayer.seekTo(seekTo, true);
                        ytPlayer.playVideo();
                    }
                }, 1500);
            }
        }

        initYouTubePlayer();
    }

    // ─── YouTube IFrame Player ─────────────────────────────
    function initYouTubePlayer() {
        if (ytPlayer) return; // Already initialized

        // Load the YouTube IFrame API
        if (!window.YT) {
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(tag);

            window.onYouTubeIframeAPIReady = createPlayer;
        } else {
            createPlayer();
        }
    }

    function createPlayer() {
        ytPlayer = new YT.Player('ytPlayer', {
            height: '100%',
            width: '100%',
            playerVars: {
                autoplay: 0,
                controls: 0, // We use our own controls
                rel: 0,
                modestbranding: 1,
                fs: 0,
                playsinline: 1
            },
            events: {
                onReady: () => {
                    ytReady = true;
                    console.log('[YT] Player ready');
                },
                onStateChange: (event) => {
                    handlePlayerStateChange(event.data);
                },
                onError: (event) => {
                    console.error('[YT] Player error:', event.data);
                    showToast('Could not play this video. Try another URL.', true);
                }
            }
        });
    }

    function handlePlayerStateChange(state) {
        // YT.PlayerState: UNSTARTED=-1, ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
        if (isSyncing) return; // Don't sync back if we're receiving a sync

        if (myRole === 'host') {
            const currentTime = ytPlayer ? ytPlayer.getCurrentTime() : 0;

            if (state === 1) { // PLAYING
                updatePlayPauseUI(true);
                send({
                    type: 'SYNC_STATE',
                    action: 'play',
                    isPlaying: true,
                    currentTime
                });
            } else if (state === 2) { // PAUSED
                updatePlayPauseUI(false);
                send({
                    type: 'SYNC_STATE',
                    action: 'pause',
                    isPlaying: false,
                    currentTime
                });
            } else if (state === 0) { // ENDED
                updatePlayPauseUI(false);
                send({
                    type: 'SYNC_STATE',
                    action: 'pause',
                    isPlaying: false,
                    currentTime: 0
                });
            }
        } else {
            // Listener UI updates
            if (state === 1) updatePlayPauseUI(true);
            else if (state === 2 || state === 0) updatePlayPauseUI(false);
        }
    }

    function updatePlayPauseUI(isPlaying) {
        $('iconPlay').style.display = isPlaying ? 'none' : '';
        $('iconPause').style.display = isPlaying ? '' : 'none';
    }

    // ─── YouTube URL Helpers ───────────────────────────────
    function extractVideoId(url) {
        if (!url) return null;

        // Handle various YouTube URL formats
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/  // Just the ID
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    function loadVideo(videoId, title) {
        if (!videoId) return;

        // Show player, hide placeholder
        $('playerPlaceholder').style.display = 'none';
        $('ytPlayer').style.display = 'block';

        $('npTitle').textContent = title || 'Now Playing';

        if (ytPlayer && ytReady) {
            ytPlayer.loadVideoById(videoId);
        } else {
            // Player not ready yet, wait and retry
            const checkReady = setInterval(() => {
                if (ytPlayer && ytReady) {
                    clearInterval(checkReady);
                    ytPlayer.loadVideoById(videoId);
                }
            }, 500);
            // Give up after 10s
            setTimeout(() => clearInterval(checkReady), 10000);
        }
    }

    // ─── Sync Handler (Listener) ───────────────────────────
    function handleSyncState(msg) {
        if (!ytPlayer || !ytReady) return;

        isSyncing = true;

        if (msg.action === 'play') {
            const timeDiff = Math.abs(ytPlayer.getCurrentTime() - msg.currentTime);
            if (timeDiff > 2) {
                ytPlayer.seekTo(msg.currentTime, true);
            }
            ytPlayer.playVideo();
            updatePlayPauseUI(true);
        } else if (msg.action === 'pause') {
            ytPlayer.pauseVideo();
            updatePlayPauseUI(false);
        } else if (msg.action === 'seek') {
            ytPlayer.seekTo(msg.currentTime, true);
            if (msg.isPlaying) ytPlayer.playVideo();
        }

        setTimeout(() => { isSyncing = false; }, 500);
    }

    // ─── Host: Control from Listener ───────────────────────
    function handleControlFromListener(msg) {
        showToast(`${msg.fromName} pressed ${msg.action}`);
        // Actually execute the control
        if (ytPlayer && ytReady) {
            if (msg.action === 'TOGGLE') {
                const state = ytPlayer.getPlayerState();
                if (state === 1) ytPlayer.pauseVideo();
                else ytPlayer.playVideo();
            }
        }
    }

    // ─── Listener List ─────────────────────────────────────
    function updateListenerList(roomInfo) {
        const list = $('listenerList');
        list.innerHTML = '';

        const hostEl = createListenerItem(roomInfo.hostName, 'HOST');
        list.appendChild(hostEl);

        if (roomInfo.listeners && roomInfo.listeners.length > 0) {
            roomInfo.listeners.forEach(l => {
                list.appendChild(createListenerItem(l.name, 'LISTENER'));
            });
        }

        if (!roomInfo.listeners || roomInfo.listeners.length === 0) {
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

    // ─── Cleanup ───────────────────────────────────────────
    function cleanup() {
        if (ytPlayer && ytReady) {
            try { ytPlayer.stopVideo(); } catch (e) { }
        }
        currentRoom = null;
        myRole = null;

        // Reset UI
        $('chatMessages').innerHTML = '<div class="system-msg">Welcome to the room! Say hi 👋</div>';
        $('npTitle').textContent = 'No song playing';
        $('playerPlaceholder').style.display = '';
        $('ytPlayer').style.display = 'none';
        updatePlayPauseUI(false);
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

    // Room — Play YouTube URL (Host)
    function playUrl() {
        const url = $('urlInput').value.trim();
        if (!url) {
            showToast('Paste a YouTube URL', true);
            return;
        }

        const videoId = extractVideoId(url);
        if (!videoId) {
            showToast('Invalid YouTube URL. Try a youtube.com or youtu.be link.', true);
            return;
        }

        loadVideo(videoId, 'Loading...');

        // Broadcast to all listeners
        send({
            type: 'PLAY_URL',
            videoId,
            title: 'Now Playing'
        });

        // Update title when video info loads
        setTimeout(() => {
            if (ytPlayer && ytReady) {
                try {
                    const data = ytPlayer.getVideoData();
                    const title = data.title || 'Now Playing';
                    $('npTitle').textContent = title;
                    send({
                        type: 'PLAY_URL',
                        videoId,
                        title
                    });
                } catch (e) { }
            }
        }, 3000);

        $('urlInput').value = '';
        showToast('Loading video...');
    }

    $('btnPlayUrl').addEventListener('click', playUrl);
    $('urlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') playUrl();
    });

    // Room — Playback Controls
    $('btnToggle').addEventListener('click', () => {
        if (myRole === 'host' && ytPlayer && ytReady) {
            const state = ytPlayer.getPlayerState();
            if (state === 1) {
                ytPlayer.pauseVideo();
            } else {
                ytPlayer.playVideo();
            }
        } else if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'TOGGLE' });
        }
    });

    $('btnPrev').addEventListener('click', () => {
        if (myRole === 'host' && ytPlayer && ytReady) {
            ytPlayer.seekTo(0, true);
            send({
                type: 'SYNC_STATE',
                action: 'seek',
                isPlaying: true,
                currentTime: 0
            });
        } else if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'PREV' });
        }
    });

    $('btnNext').addEventListener('click', () => {
        if (myRole === 'host' && ytPlayer && ytReady) {
            // Skip to end
            const duration = ytPlayer.getDuration();
            ytPlayer.seekTo(duration, true);
        } else if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'NEXT' });
        }
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
