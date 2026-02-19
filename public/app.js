/* ═══════════════════════════════════════════════════════════
   JamSync PWA v3 — Multi-Platform Audio + YouTube Sync
   Tab audio via WebRTC, YouTube embed, chat, reactions
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

    // YouTube
    let ytPlayer = null;
    let ytReady = false;
    let isSyncing = false;

    // WebRTC (Tab Audio)
    let localStream = null;    // Host's captured audio stream
    let peerConnections = {};  // Host: userId → RTCPeerConnection
    let remotePC = null;       // Listener: single RTCPeerConnection to host

    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

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
        ws = new WebSocket(wsUrl);

        ws.addEventListener('open', () => {
            reconnectAttempts = 0;
            while (messageQueue.length > 0) {
                ws.send(JSON.stringify(messageQueue.shift()));
            }
        });

        ws.addEventListener('message', (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            handleServerMessage(msg);
        });

        ws.addEventListener('close', () => {
            reconnectAttempts++;
            setTimeout(connectWebSocket, Math.min(1000 * reconnectAttempts, 10000));
        });

        ws.addEventListener('error', () => { });
    }

    function send(message) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        } else {
            messageQueue.push(message);
            if (!ws || ws.readyState === WebSocket.CLOSED) connectWebSocket();
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

            case 'CONTROL':
                if (myRole === 'host') handleControlFromListener(msg);
                break;

            // ─── WebRTC Signaling ────────────────
            case 'SIGNAL':
                handleSignal(msg);
                break;

            case 'INITIATE_PEER':
                if (myRole === 'host' && localStream) {
                    createOfferForListener(msg.targetUserId);
                }
                break;

            case 'PEER_LEFT':
                if (myRole === 'host' && peerConnections[msg.userId]) {
                    peerConnections[msg.userId].close();
                    delete peerConnections[msg.userId];
                }
                break;

            case 'STREAM_STATUS':
                if (myRole === 'listener') {
                    if (msg.isStreaming) {
                        $('streamingIndicator').classList.remove('hidden');
                        $('streamLabel').textContent = 'Host is streaming tab audio';
                    } else {
                        $('streamingIndicator').classList.add('hidden');
                    }
                }
                if (msg.roomInfo) updateListenerList(msg.roomInfo);
                break;

            // ─── Chat & Reactions ────────────────
            case 'CHAT':
                addChatMessage(msg.name, msg.message, msg.userId === myUserId);
                break;

            case 'REACTION':
                showFloatingReaction(msg.emoji);
                break;
        }
    }

    // ─── Enter Room UI ─────────────────────────────────────
    function enterRoom(roomInfo) {
        showScreen('roomScreen');
        $('roomCodeText').textContent = roomInfo.roomCode;
        updateListenerCount(roomInfo.listenerCount);
        updateListenerList(roomInfo);

        if (myRole === 'host') {
            // Show share button on desktop (getDisplayMedia not supported on mobile)
            const isDesktop = !(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
            if (isDesktop) {
                $('shareSection').classList.remove('hidden');
            }
            $('urlInputSection').classList.remove('hidden');
        } else {
            $('shareSection').classList.add('hidden');
            $('urlInputSection').classList.add('hidden');
        }

        // If room already has streaming or video
        if (roomInfo.isStreaming) {
            $('streamingIndicator').classList.remove('hidden');
            $('streamLabel').textContent = 'Host is streaming tab audio';
        }

        if (roomInfo.videoState && roomInfo.videoState.videoId) {
            loadVideo(roomInfo.videoState.videoId, roomInfo.videoState.title);
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

    // ═══════════════════════════════════════════════════════
    // TAB AUDIO SHARING (WebRTC + getDisplayMedia)
    // ═══════════════════════════════════════════════════════

    async function startTabAudioShare() {
        try {
            // Request screen share with audio
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000
                }
            });

            // Extract only audio tracks
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length === 0) {
                displayStream.getTracks().forEach(t => t.stop());
                showToast('No audio detected. Make sure "Share tab audio" is checked!', true);
                return;
            }

            // Stop video tracks (we only need audio)
            displayStream.getVideoTracks().forEach(t => t.stop());

            // Create audio-only stream
            localStream = new MediaStream(audioTracks);

            // Listen for track ending (user stops sharing)
            audioTracks[0].addEventListener('ended', () => {
                stopTabAudioShare();
            });

            // Update UI
            $('btnShareAudio').classList.add('streaming');
            $('shareLabel').textContent = 'Stop Sharing';
            $('streamingIndicator').classList.remove('hidden');
            $('streamLabel').textContent = 'Streaming tab audio';

            // Tell server we're streaming
            send({ type: 'STREAM_STATUS', isStreaming: true });

            showToast('Streaming audio! Everyone can hear your music.');

        } catch (err) {
            if (err.name === 'NotAllowedError') {
                showToast('Share was cancelled', true);
            } else {
                console.error('[Audio] Share failed:', err);
                showToast('Could not share audio. Try again.', true);
            }
        }
    }

    function stopTabAudioShare() {
        // Stop all tracks
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        // Close all peer connections
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};

        // Update UI
        $('btnShareAudio').classList.remove('streaming');
        $('shareLabel').textContent = 'Share Tab Audio';
        $('streamingIndicator').classList.add('hidden');

        // Tell server
        send({ type: 'STREAM_STATUS', isStreaming: false });

        showToast('Stopped sharing audio');
    }

    // ─── WebRTC: Host creates offer for listener ───────────
    function createOfferForListener(targetUserId) {
        if (!localStream) return;

        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerConnections[targetUserId] = pc;

        // Add audio tracks
        localStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });

        // ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                send({
                    type: 'SIGNAL',
                    targetUserId,
                    signal: { type: 'candidate', candidate: event.candidate }
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                pc.close();
                delete peerConnections[targetUserId];
            }
        };

        // Create and send offer
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                send({
                    type: 'SIGNAL',
                    targetUserId,
                    signal: { type: 'offer', sdp: pc.localDescription }
                });
            })
            .catch(err => console.error('[WebRTC] Offer failed:', err));
    }

    // ─── WebRTC: Handle incoming signal ────────────────────
    function handleSignal(msg) {
        const { fromUserId, signal } = msg;

        if (myRole === 'host') {
            // Host receives answer or ICE from listener
            const pc = peerConnections[fromUserId];
            if (!pc) return;

            if (signal.type === 'answer') {
                pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
                    .catch(err => console.error('[WebRTC] Answer error:', err));
            } else if (signal.type === 'candidate') {
                pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
                    .catch(() => { });
            }

        } else if (myRole === 'listener') {
            // Listener receives offer or ICE from host
            if (signal.type === 'offer') {
                // Create new peer connection for this offer
                if (remotePC) remotePC.close();
                remotePC = new RTCPeerConnection(RTC_CONFIG);

                remotePC.ontrack = (event) => {
                    const remoteAudio = $('remoteAudio');
                    remoteAudio.srcObject = event.streams[0];
                    remoteAudio.play().catch(() => { });
                    $('streamingIndicator').classList.remove('hidden');
                    $('streamLabel').textContent = 'Listening to host\'s audio';
                    showToast('Connected! You can hear the host\'s music.');
                };

                remotePC.onicecandidate = (event) => {
                    if (event.candidate) {
                        send({
                            type: 'SIGNAL',
                            targetUserId: fromUserId,
                            signal: { type: 'candidate', candidate: event.candidate }
                        });
                    }
                };

                remotePC.onconnectionstatechange = () => {
                    if (remotePC.connectionState === 'failed' || remotePC.connectionState === 'disconnected') {
                        $('streamingIndicator').classList.add('hidden');
                    }
                };

                remotePC.setRemoteDescription(new RTCSessionDescription(signal.sdp))
                    .then(() => remotePC.createAnswer())
                    .then(answer => remotePC.setLocalDescription(answer))
                    .then(() => {
                        send({
                            type: 'SIGNAL',
                            targetUserId: fromUserId,
                            signal: { type: 'answer', sdp: remotePC.localDescription }
                        });
                    })
                    .catch(err => console.error('[WebRTC] Answer creation failed:', err));

            } else if (signal.type === 'candidate' && remotePC) {
                remotePC.addIceCandidate(new RTCIceCandidate(signal.candidate))
                    .catch(() => { });
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // YOUTUBE IFRAME PLAYER
    // ═══════════════════════════════════════════════════════

    function initYouTubePlayer() {
        if (ytPlayer) return;
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
                controls: 0,
                rel: 0,
                modestbranding: 1,
                fs: 0,
                playsinline: 1
            },
            events: {
                onReady: () => { ytReady = true; },
                onStateChange: (event) => handlePlayerStateChange(event.data),
                onError: () => showToast('Could not play this video.', true)
            }
        });
    }

    function handlePlayerStateChange(state) {
        if (isSyncing) return;
        if (myRole === 'host') {
            const currentTime = ytPlayer ? ytPlayer.getCurrentTime() : 0;
            if (state === 1) {
                updatePlayPauseUI(true);
                send({ type: 'SYNC_STATE', action: 'play', isPlaying: true, currentTime });
            } else if (state === 2) {
                updatePlayPauseUI(false);
                send({ type: 'SYNC_STATE', action: 'pause', isPlaying: false, currentTime });
            } else if (state === 0) {
                updatePlayPauseUI(false);
                send({ type: 'SYNC_STATE', action: 'pause', isPlaying: false, currentTime: 0 });
            }
        } else {
            if (state === 1) updatePlayPauseUI(true);
            else if (state === 2 || state === 0) updatePlayPauseUI(false);
        }
    }

    function updatePlayPauseUI(isPlaying) {
        $('iconPlay').style.display = isPlaying ? 'none' : '';
        $('iconPause').style.display = isPlaying ? '' : 'none';
    }

    function extractVideoId(url) {
        if (!url) return null;
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    function loadVideo(videoId, title) {
        if (!videoId) return;
        $('playerPlaceholder').style.display = 'none';
        $('ytPlayer').style.display = 'block';
        $('npTitle').textContent = title || 'Now Playing';

        if (ytPlayer && ytReady) {
            ytPlayer.loadVideoById(videoId);
        } else {
            const checkReady = setInterval(() => {
                if (ytPlayer && ytReady) {
                    clearInterval(checkReady);
                    ytPlayer.loadVideoById(videoId);
                }
            }, 500);
            setTimeout(() => clearInterval(checkReady), 10000);
        }
    }

    function handleSyncState(msg) {
        if (!ytPlayer || !ytReady) return;
        isSyncing = true;
        if (msg.action === 'play') {
            const timeDiff = Math.abs(ytPlayer.getCurrentTime() - msg.currentTime);
            if (timeDiff > 2) ytPlayer.seekTo(msg.currentTime, true);
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

    function handleControlFromListener(msg) {
        showToast(`${msg.fromName} pressed ${msg.action}`);
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
        list.appendChild(createListenerItem(roomInfo.hostName, 'HOST'));
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
        // Stop tab audio
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};
        if (remotePC) { remotePC.close(); remotePC = null; }

        // Stop YouTube
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
        $('streamingIndicator').classList.add('hidden');
        $('shareSection').classList.add('hidden');
        $('urlInputSection').classList.add('hidden');
        $('btnShareAudio').classList.remove('streaming');
        $('shareLabel').textContent = 'Share Tab Audio';
        updatePlayPauseUI(false);
    }

    // ─── Utility ───────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ═══ Event Listeners ═══════════════════════════════════

    // Landing
    $('btnCreate').addEventListener('click', () => {
        myName = $('nameInput').value.trim() || 'Anonymous';
        send({ type: 'CREATE_ROOM', name: myName });
    });

    $('btnJoinToggle').addEventListener('click', () => {
        const section = $('joinSection');
        section.classList.toggle('hidden');
        if (!section.classList.contains('hidden')) $('codeInput').focus();
    });

    $('btnJoin').addEventListener('click', () => {
        myName = $('nameInput').value.trim() || 'Anonymous';
        const code = $('codeInput').value.trim().toUpperCase();
        if (!code) { showToast('Enter a room code', true); return; }
        send({ type: 'JOIN_ROOM', roomCode: code, name: myName });
    });

    $('codeInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('btnJoin').click();
    });

    // Room — Leave
    $('btnLeave').addEventListener('click', () => {
        if (confirm('Leave this room?')) send({ type: 'LEAVE_ROOM' });
    });

    // Room — Copy Code
    $('roomCodeBadge').addEventListener('click', () => {
        const code = $('roomCodeText').textContent;
        navigator.clipboard.writeText(code)
            .then(() => showToast('Room code copied!'))
            .catch(() => showToast(code));
    });

    // Room — Share Tab Audio (Host)
    $('btnShareAudio').addEventListener('click', () => {
        if (localStream) {
            stopTabAudioShare();
        } else {
            startTabAudioShare();
        }
    });

    // Room — YouTube URL (Host)
    function playUrl() {
        const url = $('urlInput').value.trim();
        if (!url) { showToast('Paste a YouTube URL', true); return; }
        const videoId = extractVideoId(url);
        if (!videoId) { showToast('Invalid YouTube URL', true); return; }

        loadVideo(videoId, 'Loading...');
        send({ type: 'PLAY_URL', videoId, title: 'Now Playing' });

        setTimeout(() => {
            if (ytPlayer && ytReady) {
                try {
                    const data = ytPlayer.getVideoData();
                    const title = data.title || 'Now Playing';
                    $('npTitle').textContent = title;
                    send({ type: 'PLAY_URL', videoId, title });
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
            if (state === 1) ytPlayer.pauseVideo();
            else ytPlayer.playVideo();
        } else if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'TOGGLE' });
        }
    });

    $('btnPrev').addEventListener('click', () => {
        if (myRole === 'host' && ytPlayer && ytReady) {
            ytPlayer.seekTo(0, true);
            send({ type: 'SYNC_STATE', action: 'seek', isPlaying: true, currentTime: 0 });
        } else if (myRole === 'listener') {
            send({ type: 'CONTROL', action: 'PREV' });
        }
    });

    $('btnNext').addEventListener('click', () => {
        if (myRole === 'host' && ytPlayer && ytReady) {
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

    // Room — Tabs
    $$('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            $$('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            $$('.tab-panel').forEach(p => p.classList.remove('active'));
            $(`panel${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
        });
    });

    // ─── PWA ───────────────────────────────────────────────
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(() => console.log('[PWA] SW registered'))
            .catch(err => console.log('[PWA] SW failed:', err));
    }

    // ─── Initialize ────────────────────────────────────────
    connectWebSocket();
})();
