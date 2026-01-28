// ========================================
// WebRTC Voice & Video Communication App
// Using Perfect Negotiation Pattern
// ========================================

// ICE Configuration - Multiple STUN servers + Free TURN
const ICE_SERVERS = {
    iceServers: [
        // Google STUN servers
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Free TURN servers (Metered - they offer free tier)
        {
            urls: 'turn:a.relay.metered.ca:80',
            username: 'e8dd65b92c62d5e89cb5e78f',
            credential: 'uWdWNmkhvyqTlSlg'
        },
        {
            urls: 'turn:a.relay.metered.ca:80?transport=tcp',
            username: 'e8dd65b92c62d5e89cb5e78f',
            credential: 'uWdWNmkhvyqTlSlg'
        },
        {
            urls: 'turn:a.relay.metered.ca:443',
            username: 'e8dd65b92c62d5e89cb5e78f',
            credential: 'uWdWNmkhvyqTlSlg'
        },
        {
            urls: 'turn:a.relay.metered.ca:443?transport=tcp',
            username: 'e8dd65b92c62d5e89cb5e78f',
            credential: 'uWdWNmkhvyqTlSlg'
        }
    ],
    iceCandidatePoolSize: 10
};

// State
let socket = null;
let localStream = null;
let currentRoomCode = null;
let isMuted = false;
let isVideoEnabled = false;
let isScreenSharing = false;
let userName = '';
let pendingAction = null;
let mySocketId = null;

// Peer connections map
const peers = new Map();

// DOM Elements
const elements = {
    landingView: document.getElementById('landing-view'),
    roomView: document.getElementById('room-view'),
    createRoomBtn: document.getElementById('create-room-btn'),
    joinRoomBtn: document.getElementById('join-room-btn'),
    roomCodeInput: document.getElementById('room-code-input'),
    errorMessage: document.getElementById('error-message'),
    currentRoomCode: document.getElementById('current-room-code'),
    copyCodeBtn: document.getElementById('copy-code-btn'),
    participantCountText: document.getElementById('participant-count-text'),
    participantsGrid: document.getElementById('participants-grid'),
    muteBtn: document.getElementById('mute-btn'),
    videoBtn: document.getElementById('video-btn'),
    screenBtn: document.getElementById('screen-btn'),
    leaveBtn: document.getElementById('leave-btn'),
    micOnIcon: document.getElementById('mic-on-icon'),
    micOffIcon: document.getElementById('mic-off-icon'),
    videoOnIcon: document.getElementById('video-on-icon'),
    videoOffIcon: document.getElementById('video-off-icon'),
    screenOnIcon: document.getElementById('screen-on-icon'),
    screenOffIcon: document.getElementById('screen-off-icon'),
    permissionModal: document.getElementById('permission-modal'),
    grantPermissionBtn: document.getElementById('grant-permission-btn'),
    nameModal: document.getElementById('name-modal'),
    userNameInput: document.getElementById('user-name-input'),
    confirmNameBtn: document.getElementById('confirm-name-btn'),
    remoteAudioContainer: document.getElementById('remote-audio-container')
};

// ========================================
// Debug Logging
// ========================================
function log(emoji, msg, ...args) {
    console.log(`${emoji} [${new Date().toLocaleTimeString()}] ${msg}`, ...args);
}

// ========================================
// Socket.IO Connection
// ========================================
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        mySocketId = socket.id;
        log('✅', `Connected to server: ${socket.id}`);
    });

    socket.on('disconnect', () => {
        log('❌', 'Disconnected from server');
        showError('Connection lost. Please refresh.');
    });

    // Someone joined - create connection to them
    socket.on('user-joined', async ({ odliterId, userName: peerName }) => {
        log('👤', `User joined: ${peerName} (${odliterId})`);

        // Don't connect to ourselves
        if (odliterId === mySocketId) return;

        addParticipantCard(odliterId, peerName);

        // We are "polite" peer - the one who was already here
        await setupPeerConnection(odliterId, peerName, true);
    });

    socket.on('user-left', ({ odliterId }) => {
        log('👋', `User left: ${odliterId}`);
        removePeer(odliterId);
    });

    // Signaling messages
    socket.on('signal', async ({ senderId, signal }) => {
        log('📨', `Signal from ${senderId}:`, signal.type || 'ice-candidate');
        await handleSignal(senderId, signal);
    });

    socket.on('participant-count', ({ count }) => {
        updateParticipantCount(count);
    });

    socket.on('user-mute-status', ({ odliterId, isMuted }) => {
        updatePeerMuteStatus(odliterId, isMuted);
    });

    socket.on('user-video-status', ({ odliterId, isVideoEnabled }) => {
        updatePeerVideoStatus(odliterId, isVideoEnabled);
    });
}

// ========================================
// Signaling
// ========================================
async function handleSignal(senderId, signal) {
    let peerData = peers.get(senderId);

    // If no peer connection yet, create one
    if (!peerData) {
        log('🔗', `Creating peer connection for ${senderId} (from signal)`);
        addParticipantCard(senderId, 'Participant');
        await setupPeerConnection(senderId, 'Participant', false);
        peerData = peers.get(senderId);
    }

    const pc = peerData.pc;

    try {
        if (signal.type === 'offer') {
            log('📥', `Received OFFER from ${senderId}`);

            // Perfect negotiation - handle offer
            const offerCollision = pc.signalingState !== 'stable';

            if (offerCollision && peerData.polite) {
                log('⚠️', 'Offer collision, we are polite - accepting');
            }

            if (offerCollision && !peerData.polite) {
                log('⚠️', 'Offer collision, we are impolite - ignoring');
                return;
            }

            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            log('📝', `Set remote description (offer) for ${senderId}`);

            // Process buffered ICE candidates
            await processIceBuffer(senderId);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            log('📤', `Sending ANSWER to ${senderId}`);

            sendSignal(senderId, pc.localDescription);

        } else if (signal.type === 'answer') {
            log('📥', `Received ANSWER from ${senderId}`);

            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                log('📝', `Set remote description (answer) for ${senderId}`);

                // Process buffered ICE candidates
                await processIceBuffer(senderId);
            } else {
                log('⚠️', `Cannot set answer in state: ${pc.signalingState}`);
            }

        } else if (signal.candidate) {
            log('🧊', `Received ICE candidate from ${senderId}`);

            if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(signal));
                log('🧊', `Added ICE candidate for ${senderId}`);
            } else {
                // Buffer the candidate
                peerData.iceBuffer.push(signal);
                log('🧊', `Buffered ICE candidate for ${senderId} (${peerData.iceBuffer.length} buffered)`);
            }
        }
    } catch (err) {
        log('❌', `Error handling signal:`, err);
    }
}

async function processIceBuffer(odliterId) {
    const peerData = peers.get(odliterId);
    if (!peerData || peerData.iceBuffer.length === 0) return;

    log('🧊', `Processing ${peerData.iceBuffer.length} buffered ICE candidates for ${odliterId}`);

    for (const candidate of peerData.iceBuffer) {
        try {
            await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            log('⚠️', 'Error adding buffered candidate:', e);
        }
    }
    peerData.iceBuffer = [];
}

function sendSignal(targetId, signal) {
    socket.emit('signal', { targetId, signal });
}

// ========================================
// WebRTC Peer Connection
// ========================================
async function setupPeerConnection(odliterId, peerName, polite) {
    if (peers.has(odliterId)) {
        log('⚠️', `Peer connection already exists for ${odliterId}`);
        return;
    }

    log('🔗', `Setting up peer connection for ${odliterId}, polite: ${polite}`);

    const pc = new RTCPeerConnection(ICE_SERVERS);

    const peerData = {
        pc,
        userName: peerName,
        polite,
        iceBuffer: [],
        makingOffer: false
    };

    peers.set(odliterId, peerData);

    // Add local tracks FIRST
    if (localStream) {
        log('🎤', `Adding ${localStream.getTracks().length} local tracks to ${odliterId}`);
        localStream.getTracks().forEach(track => {
            log('  →', `Adding ${track.kind} track: ${track.label}`);
            pc.addTrack(track, localStream);
        });
    } else {
        log('⚠️', 'No local stream available!');
    }

    // ICE candidate
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
            log('🧊', `Sending ICE candidate to ${odliterId}`);
            sendSignal(odliterId, candidate);
        }
    };

    // ICE connection state
    pc.oniceconnectionstatechange = () => {
        log('🧊', `ICE state [${odliterId}]: ${pc.iceConnectionState}`);

        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            updateStatusIndicator(odliterId, 'connected');
        } else if (pc.iceConnectionState === 'failed') {
            log('❌', `ICE failed for ${odliterId}, restarting...`);
            pc.restartIce();
            updateStatusIndicator(odliterId, 'failed');
        } else if (pc.iceConnectionState === 'disconnected') {
            updateStatusIndicator(odliterId, 'disconnected');
        }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
        log('🔌', `Connection state [${odliterId}]: ${pc.connectionState}`);

        if (pc.connectionState === 'connected') {
            log('✅', `CONNECTED with ${odliterId}!`);
            updateStatusIndicator(odliterId, 'connected');
        } else if (pc.connectionState === 'failed') {
            updateStatusIndicator(odliterId, 'failed');
        }
    };

    // Negotiation needed - create offer
    pc.onnegotiationneeded = async () => {
        log('🔄', `Negotiation needed for ${odliterId}`);

        try {
            peerData.makingOffer = true;
            const offer = await pc.createOffer();

            if (pc.signalingState !== 'stable') {
                log('⚠️', 'Signaling state changed during offer creation');
                return;
            }

            await pc.setLocalDescription(offer);
            log('📤', `Sending OFFER to ${odliterId}`);
            sendSignal(odliterId, pc.localDescription);

        } catch (err) {
            log('❌', 'Error in negotiation:', err);
        } finally {
            peerData.makingOffer = false;
        }
    };

    // Incoming tracks
    pc.ontrack = (event) => {
        log('🎵', `Received ${event.track.kind} track from ${odliterId}`);

        const [stream] = event.streams;
        if (!stream) {
            log('⚠️', 'No stream in track event');
            return;
        }

        if (event.track.kind === 'audio') {
            setupRemoteAudio(odliterId, stream);
        } else if (event.track.kind === 'video') {
            setupRemoteVideo(odliterId, stream);
        }
    };

    log('✅', `Peer connection created for ${odliterId}`);
}

function updateStatusIndicator(odliterId, status) {
    const statusEl = document.getElementById(`status-${odliterId}`);
    if (!statusEl) return;

    const span = statusEl.querySelector('span');
    if (!span) return;

    if (status === 'connected') {
        statusEl.style.background = 'rgba(39, 174, 96, 0.9)';
        span.textContent = 'Active';
    } else if (status === 'failed') {
        statusEl.style.background = 'rgba(231, 76, 60, 0.9)';
        span.textContent = 'Failed';
    } else if (status === 'disconnected') {
        statusEl.style.background = 'rgba(241, 196, 15, 0.9)';
        span.textContent = 'Reconnecting';
    }
}

function setupRemoteAudio(odliterId, stream) {
    log('🔊', `Setting up audio for ${odliterId}`);

    let audio = document.getElementById(`audio-${odliterId}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${odliterId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        elements.remoteAudioContainer.appendChild(audio);
    }

    audio.srcObject = stream;

    audio.play()
        .then(() => log('🔊', `Audio playing for ${odliterId}`))
        .catch(err => {
            log('⚠️', `Audio blocked for ${odliterId}:`, err.message);
            document.addEventListener('click', () => audio.play(), { once: true });
        });
}

function setupRemoteVideo(odliterId, stream) {
    log('📺', `Setting up video for ${odliterId}`);

    const card = document.getElementById(`participant-${odliterId}`);
    if (!card) return;

    let video = card.querySelector('video');
    if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        card.insertBefore(video, card.firstChild);
    }

    video.srcObject = stream;

    const avatar = card.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'none';

    video.play().catch(e => log('⚠️', 'Video play error:', e));
}

function removePeer(odliterId) {
    const peerData = peers.get(odliterId);
    if (peerData) {
        peerData.pc.close();
        peers.delete(odliterId);
    }

    const audio = document.getElementById(`audio-${odliterId}`);
    if (audio) audio.remove();

    const card = document.getElementById(`participant-${odliterId}`);
    if (card) card.remove();

    log('🗑️', `Removed peer ${odliterId}`);
}

// ========================================
// Media
// ========================================
async function getLocalStream() {
    try {
        log('🎤', 'Requesting microphone...');

        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

        const tracks = localStream.getTracks();
        log('✅', `Got ${tracks.length} audio tracks`);
        tracks.forEach(t => log('  →', `${t.kind}: ${t.label}, enabled: ${t.enabled}`));

        return true;
    } catch (err) {
        log('❌', 'Microphone error:', err);
        showError('Microphone access denied.');
        return false;
    }
}

function toggleMute() {
    if (!localStream) return;

    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
    });

    log('🎤', isMuted ? 'Muted' : 'Unmuted');

    elements.muteBtn.classList.toggle('muted', isMuted);
    elements.micOnIcon.classList.toggle('hidden', isMuted);
    elements.micOffIcon.classList.toggle('hidden', !isMuted);

    socket.emit('mute-status', { isMuted });

    const selfStatus = document.getElementById('status-self');
    if (selfStatus) {
        selfStatus.querySelector('span').textContent = isMuted ? 'Muted' : 'You';
    }
}

async function toggleVideo() {
    try {
        if (!isVideoEnabled) {
            log('📹', 'Enabling video...');

            const videoStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } }
            });

            const videoTrack = videoStream.getVideoTracks()[0];
            log('✅', `Got video: ${videoTrack.label}`);

            // Add to local stream
            localStream.addTrack(videoTrack);

            // Add to all peer connections
            peers.forEach((peerData, odliterId) => {
                log('📹', `Adding video track to ${odliterId}`);
                peerData.pc.addTrack(videoTrack, localStream);
            });

            showLocalVideo(videoStream);
            isVideoEnabled = true;

        } else {
            log('📹', 'Disabling video...');

            localStream.getVideoTracks().forEach(track => {
                track.stop();
                localStream.removeTrack(track);
            });

            peers.forEach(peerData => {
                const sender = peerData.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) peerData.pc.removeTrack(sender);
            });

            hideLocalVideo();
            isVideoEnabled = false;
        }

        elements.videoBtn.classList.toggle('active', isVideoEnabled);
        elements.videoOnIcon.classList.toggle('hidden', !isVideoEnabled);
        elements.videoOffIcon.classList.toggle('hidden', isVideoEnabled);
        socket.emit('video-status', { isVideoEnabled });

    } catch (err) {
        log('❌', 'Video error:', err);
        showError('Camera access denied.');
    }
}

function showLocalVideo(stream) {
    const selfCard = document.getElementById('participant-self');
    if (!selfCard) return;

    let video = selfCard.querySelector('video');
    if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.transform = 'scaleX(-1)';
        selfCard.insertBefore(video, selfCard.firstChild);
    }

    video.srcObject = stream;

    const avatar = selfCard.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'none';
}

function hideLocalVideo() {
    const selfCard = document.getElementById('participant-self');
    if (!selfCard) return;

    const video = selfCard.querySelector('video');
    if (video) video.remove();

    const avatar = selfCard.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'flex';
}

async function toggleScreenShare() {
    try {
        if (!isScreenSharing) {
            log('🖥️', 'Starting screen share...');

            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: false
            });

            const screenTrack = screenStream.getVideoTracks()[0];

            screenTrack.onended = () => {
                log('🖥️', 'Screen share ended');
                stopScreenShare();
            };

            peers.forEach((peerData, odliterId) => {
                log('🖥️', `Adding screen track to ${odliterId}`);
                peerData.pc.addTrack(screenTrack, screenStream);
            });

            addScreenShareCard(screenStream);
            isScreenSharing = true;

            elements.screenBtn.classList.add('active');

        } else {
            stopScreenShare();
        }
    } catch (err) {
        log('❌', 'Screen share error:', err);
    }
}

function stopScreenShare() {
    const card = document.getElementById('participant-screen');
    if (card) {
        const video = card.querySelector('video');
        if (video?.srcObject) {
            video.srcObject.getTracks().forEach(t => t.stop());
        }
        card.remove();
    }

    isScreenSharing = false;
    elements.screenBtn.classList.remove('active');
}

function addScreenShareCard(stream) {
    if (document.getElementById('participant-screen')) return;

    const card = document.createElement('div');
    card.id = 'participant-screen';
    card.className = 'participant-card';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    card.appendChild(video);

    const label = document.createElement('span');
    label.className = 'participant-name';
    label.textContent = 'Your Screen';
    card.appendChild(label);

    elements.participantsGrid.insertBefore(card, elements.participantsGrid.firstChild);
}

// ========================================
// Room Management
// ========================================
function showNameModal(action) {
    pendingAction = action;
    elements.nameModal.classList.remove('hidden');
    elements.userNameInput.focus();
}

function hideNameModal() {
    elements.nameModal.classList.add('hidden');
    elements.userNameInput.value = '';
    pendingAction = null;
}

async function confirmName() {
    const name = elements.userNameInput.value.trim();
    if (!name) {
        elements.userNameInput.style.borderColor = '#e74c3c';
        return;
    }

    userName = name;
    const action = pendingAction;
    hideNameModal();

    // Get microphone FIRST
    const ok = await getLocalStream();
    if (!ok) return;

    if (action === 'create') {
        socket.emit('create-room', (res) => {
            if (res.success) joinRoomInternal(res.roomCode);
            else showError('Failed to create room.');
        });
    } else if (action === 'join') {
        const code = elements.roomCodeInput.value.trim().toUpperCase().replace(/-/g, '');
        joinRoomInternal(code);
    }
}

function createRoom() {
    showNameModal('create');
}

function joinRoom() {
    const code = elements.roomCodeInput.value.trim().toUpperCase().replace(/-/g, '');
    if (!code || code.length < 4) {
        showError('Enter a valid room code.');
        return;
    }
    showNameModal('join');
}

function joinRoomInternal(roomCode) {
    socket.emit('join-room', { roomCode, userName }, async (res) => {
        if (res.success) {
            currentRoomCode = roomCode;
            showRoomView();
            addParticipantCard('self', userName, true);

            log('🚪', `Joined room ${roomCode} with ${res.participants.length} others`);

            // Add existing participants - they will send us offers
            for (const p of res.participants) {
                log('👤', `Existing participant: ${p.userName}`);
                addParticipantCard(p.odliterId, p.userName);
            }

            updateParticipantCount(res.participantCount);
        } else {
            showError(res.error || 'Failed to join.');
        }
    });
}

function leaveRoom() {
    socket.emit('leave-room');

    peers.forEach(p => p.pc.close());
    peers.clear();

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    elements.remoteAudioContainer.innerHTML = '';
    elements.participantsGrid.innerHTML = '';

    currentRoomCode = null;
    isMuted = false;
    isVideoEnabled = false;
    isScreenSharing = false;

    elements.muteBtn.classList.remove('muted');
    elements.micOnIcon.classList.remove('hidden');
    elements.micOffIcon.classList.add('hidden');
    elements.videoBtn.classList.remove('active');
    elements.screenBtn.classList.remove('active');

    showLandingView();
    log('🚪', 'Left room');
}

// ========================================
// UI
// ========================================
function showLandingView() {
    elements.landingView.classList.add('active');
    elements.roomView.classList.remove('active');
    elements.roomCodeInput.value = '';
    hideError();
}

function showRoomView() {
    elements.landingView.classList.remove('active');
    elements.roomView.classList.add('active');
    elements.currentRoomCode.textContent = formatRoomCode(currentRoomCode);
}

function formatRoomCode(code) {
    return code?.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code || '';
}

function showError(msg) {
    elements.errorMessage.textContent = msg;
    elements.errorMessage.classList.remove('hidden');
}

function hideError() {
    elements.errorMessage.classList.add('hidden');
}

function updateParticipantCount(count) {
    elements.participantCountText.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
}

function addParticipantCard(id, name, isSelf = false) {
    if (document.getElementById(`participant-${id}`)) return;

    const card = document.createElement('div');
    card.id = `participant-${id}`;
    card.className = 'participant-card' + (isSelf ? ' local-video-container' : '');

    card.innerHTML = `
        <div class="participant-avatar">${name.charAt(0).toUpperCase()}</div>
        <span class="participant-name">${name}</span>
        <div class="participant-status" id="status-${id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                <path d="M19 10v2a7 7 0 01-14 0v-2"/>
            </svg>
            <span>${isSelf ? 'You' : 'Connecting...'}</span>
        </div>
    `;

    elements.participantsGrid.appendChild(card);
}

function updatePeerMuteStatus(odliterId, isMuted) {
    const status = document.getElementById(`status-${odliterId}`);
    if (status) {
        status.classList.toggle('muted', isMuted);
        status.querySelector('span').textContent = isMuted ? 'Muted' : 'Active';
    }
}

function updatePeerVideoStatus(odliterId, isVideo) {
    const card = document.getElementById(`participant-${odliterId}`);
    if (card) {
        const avatar = card.querySelector('.participant-avatar');
        if (avatar) avatar.style.display = isVideo ? 'none' : 'flex';
    }
}

async function copyRoomCode() {
    try {
        await navigator.clipboard.writeText(currentRoomCode);
        const el = elements.currentRoomCode;
        const orig = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(() => el.textContent = orig, 1500);
    } catch (e) {
        log('❌', 'Copy failed:', e);
    }
}

// ========================================
// Event Listeners
// ========================================
function initEventListeners() {
    elements.createRoomBtn.addEventListener('click', createRoom);
    elements.joinRoomBtn.addEventListener('click', joinRoom);
    elements.roomCodeInput.addEventListener('keypress', e => e.key === 'Enter' && joinRoom());

    elements.muteBtn.addEventListener('click', toggleMute);
    elements.videoBtn.addEventListener('click', toggleVideo);
    elements.screenBtn.addEventListener('click', toggleScreenShare);
    elements.leaveBtn.addEventListener('click', leaveRoom);
    elements.copyCodeBtn.addEventListener('click', copyRoomCode);

    elements.confirmNameBtn.addEventListener('click', confirmName);
    elements.userNameInput.addEventListener('keypress', e => e.key === 'Enter' && confirmName());
    elements.userNameInput.addEventListener('input', () => elements.userNameInput.style.borderColor = '');

    elements.grantPermissionBtn.addEventListener('click', async () => {
        if (await getLocalStream()) elements.permissionModal.classList.add('hidden');
    });

    elements.roomCodeInput.addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        hideError();
    });
}

// ========================================
// Init
// ========================================
function init() {
    initSocket();
    initEventListeners();
    log('🚀', 'Voice Chat initialized');
    log('📡', `${ICE_SERVERS.iceServers.length} ICE servers configured`);
}

init();
