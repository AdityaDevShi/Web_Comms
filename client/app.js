// ========================================
// WebRTC Voice & Video Communication App
// ========================================

// ICE Servers - fetched from server or fallback
let iceConfig = null;

// Fallback ICE servers
const FALLBACK_ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Free TURN servers from gist
        {
            urls: 'turn:numb.viagenie.ca',
            username: 'webrtc@live.com',
            credential: 'muazkh'
        },
        {
            urls: 'turn:turn.bistri.com:80',
            username: 'homeo',
            credential: 'homeo'
        },
        {
            urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
            username: 'webrtc',
            credential: 'webrtc'
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

// Peer connections
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

// Logging
function log(emoji, msg, ...args) {
    const time = new Date().toLocaleTimeString();
    console.log(`${emoji} [${time}] ${msg}`, ...args);
}

// ========================================
// Fetch ICE Servers
// ========================================
async function fetchIceServers() {
    try {
        const res = await fetch('/api/ice-servers');
        const data = await res.json();
        iceConfig = { iceServers: data.iceServers, iceCandidatePoolSize: 10 };
        log('📡', `Got ${data.iceServers.length} ICE servers from API`);
    } catch (e) {
        log('⚠️', 'Using fallback ICE servers');
        iceConfig = FALLBACK_ICE_SERVERS;
    }
}

// ========================================
// Socket.IO Connection
// ========================================
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        mySocketId = socket.id;
        log('✅', `Connected: ${socket.id}`);
    });

    socket.on('disconnect', () => {
        log('❌', 'Disconnected');
        showError('Connection lost. Please refresh.');
    });

    socket.on('user-joined', async ({ odliterId, userName: peerName }) => {
        log('👤', `User joined: ${peerName} (${odliterId})`);
        if (odliterId === mySocketId) return;

        addParticipantCard(odliterId, peerName);
        await createConnection(odliterId, peerName, true);
    });

    socket.on('user-left', ({ odliterId }) => {
        log('👋', `User left: ${odliterId}`);
        removePeer(odliterId);
    });

    socket.on('signal', async ({ senderId, signal }) => {
        log('📨', `Signal from ${senderId}:`, signal.type || 'candidate');
        await handleSignal(senderId, signal);
    });

    socket.on('participant-count', ({ count }) => updateParticipantCount(count));
    socket.on('user-mute-status', ({ odliterId, isMuted }) => updatePeerMuteStatus(odliterId, isMuted));
    socket.on('user-video-status', ({ odliterId, isVideoEnabled }) => updatePeerVideoStatus(odliterId, isVideoEnabled));
}

// ========================================
// Signaling
// ========================================
async function handleSignal(senderId, signal) {
    let peerData = peers.get(senderId);

    if (!peerData) {
        log('🔗', `Creating connection for ${senderId} (received signal first)`);
        addParticipantCard(senderId, 'Participant');
        await createConnection(senderId, 'Participant', false);
        peerData = peers.get(senderId);
    }

    const pc = peerData.pc;

    try {
        if (signal.type === 'offer') {
            log('📥', `Got OFFER from ${senderId}, state: ${pc.signalingState}`);

            // Handle offer collision
            const collision = pc.signalingState !== 'stable';
            if (collision) {
                if (!peerData.polite) {
                    log('⚠️', 'Collision - we are impolite, ignoring offer');
                    return;
                }
                log('⚠️', 'Collision - we are polite, rolling back');
                await pc.setLocalDescription({ type: 'rollback' });
            }

            await pc.setRemoteDescription(signal);
            log('📝', `Remote desc set for ${senderId}`);

            // Flush ICE buffer
            for (const c of peerData.iceBuffer) {
                try { await pc.addIceCandidate(c); } catch (e) { }
            }
            peerData.iceBuffer = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            log('📤', `Sending ANSWER to ${senderId}`);
            sendSignal(senderId, pc.localDescription);

        } else if (signal.type === 'answer') {
            log('📥', `Got ANSWER from ${senderId}, state: ${pc.signalingState}`);

            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(signal);
                log('📝', `Remote desc (answer) set for ${senderId}`);

                // Flush ICE buffer
                for (const c of peerData.iceBuffer) {
                    try { await pc.addIceCandidate(c); } catch (e) { }
                }
                peerData.iceBuffer = [];
            }

        } else if (signal.candidate) {
            if (pc.remoteDescription) {
                await pc.addIceCandidate(signal);
                log('🧊', `Added ICE candidate from ${senderId}`);
            } else {
                peerData.iceBuffer.push(signal);
                log('🧊', `Buffered ICE candidate from ${senderId}`);
            }
        }
    } catch (err) {
        log('❌', 'Signal error:', err.message);
    }
}

function sendSignal(targetId, signal) {
    socket.emit('signal', { targetId, signal });
}

// ========================================
// Peer Connection
// ========================================
async function createConnection(odliterId, peerName, initiator) {
    if (peers.has(odliterId)) {
        log('⚠️', `Connection already exists for ${odliterId}`);
        return;
    }

    log('🔗', `Creating connection to ${odliterId}, initiator: ${initiator}`);

    const pc = new RTCPeerConnection(iceConfig || FALLBACK_ICE_SERVERS);

    // Store peer data
    peers.set(odliterId, {
        pc,
        userName: peerName,
        polite: !initiator,
        iceBuffer: []
    });

    // Add local tracks
    if (localStream) {
        const tracks = localStream.getTracks();
        log('🎤', `Adding ${tracks.length} local tracks`);
        tracks.forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // ICE candidate
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
            log('🧊', `Sending ICE to ${odliterId}`);
            sendSignal(odliterId, candidate);
        }
    };

    // ICE gathering state
    pc.onicegatheringstatechange = () => {
        log('🧊', `ICE gathering [${odliterId}]: ${pc.iceGatheringState}`);
    };

    // ICE connection state
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        log('🧊', `ICE connection [${odliterId}]: ${state}`);

        if (state === 'connected' || state === 'completed') {
            log('✅', `ICE CONNECTED with ${odliterId}!`);
            updateStatus(odliterId, 'connected');
        } else if (state === 'checking') {
            updateStatus(odliterId, 'checking');
        } else if (state === 'failed') {
            log('❌', `ICE FAILED with ${odliterId}`);
            updateStatus(odliterId, 'failed');
            pc.restartIce();
        } else if (state === 'disconnected') {
            updateStatus(odliterId, 'disconnected');
        }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
        log('🔌', `Connection [${odliterId}]: ${pc.connectionState}`);
    };

    // Incoming tracks
    pc.ontrack = (event) => {
        log('🎵', `Got ${event.track.kind} from ${odliterId}`);

        if (event.streams && event.streams[0]) {
            if (event.track.kind === 'audio') {
                setupAudio(odliterId, event.streams[0]);
            } else if (event.track.kind === 'video') {
                setupVideo(odliterId, event.streams[0]);
            }
        }
    };

    // Negotiation needed
    pc.onnegotiationneeded = async () => {
        log('🔄', `Negotiation needed for ${odliterId}`);
        try {
            const offer = await pc.createOffer();
            if (pc.signalingState !== 'stable') return;
            await pc.setLocalDescription(offer);
            log('📤', `Sending OFFER to ${odliterId}`);
            sendSignal(odliterId, pc.localDescription);
        } catch (e) {
            log('❌', 'Negotiation error:', e);
        }
    };

    log('✅', `Peer connection created for ${odliterId}`);
}

function updateStatus(odliterId, state) {
    const el = document.getElementById(`status-${odliterId}`);
    if (!el) return;

    const span = el.querySelector('span');

    switch (state) {
        case 'connected':
            el.style.background = 'rgba(39, 174, 96, 0.9)';
            span.textContent = 'Connected';
            break;
        case 'checking':
            el.style.background = 'rgba(241, 196, 15, 0.9)';
            span.textContent = 'Connecting...';
            break;
        case 'failed':
            el.style.background = 'rgba(231, 76, 60, 0.9)';
            span.textContent = 'Failed';
            break;
        case 'disconnected':
            el.style.background = 'rgba(241, 196, 15, 0.9)';
            span.textContent = 'Reconnecting...';
            break;
    }
}

function setupAudio(odliterId, stream) {
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
    audio.play().then(() => {
        log('🔊', `Audio playing for ${odliterId}`);
    }).catch(err => {
        log('⚠️', `Audio blocked for ${odliterId}`);
        document.onclick = () => {
            audio.play();
            document.onclick = null;
        };
    });
}

function setupVideo(odliterId, stream) {
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
}

function removePeer(odliterId) {
    const p = peers.get(odliterId);
    if (p) {
        p.pc.close();
        peers.delete(odliterId);
    }
    document.getElementById(`audio-${odliterId}`)?.remove();
    document.getElementById(`participant-${odliterId}`)?.remove();
}

// ========================================
// Media
// ========================================
async function getLocalStream() {
    try {
        log('🎤', 'Getting microphone...');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false
        });
        log('✅', 'Got microphone');
        return true;
    } catch (err) {
        log('❌', 'Mic error:', err);
        showError('Microphone access denied.');
        return false;
    }
}

function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);

    elements.muteBtn.classList.toggle('muted', isMuted);
    elements.micOnIcon.classList.toggle('hidden', isMuted);
    elements.micOffIcon.classList.toggle('hidden', !isMuted);
    socket.emit('mute-status', { isMuted });

    const s = document.getElementById('status-self');
    if (s) s.querySelector('span').textContent = isMuted ? 'Muted' : 'You';
}

async function toggleVideo() {
    try {
        if (!isVideoEnabled) {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            const track = stream.getVideoTracks()[0];
            localStream.addTrack(track);

            peers.forEach(p => p.pc.addTrack(track, localStream));

            showLocalVideo(stream);
            isVideoEnabled = true;
        } else {
            localStream.getVideoTracks().forEach(t => {
                t.stop();
                localStream.removeTrack(t);
            });
            hideLocalVideo();
            isVideoEnabled = false;
        }

        elements.videoBtn.classList.toggle('active', isVideoEnabled);
        socket.emit('video-status', { isVideoEnabled });
    } catch (e) {
        log('❌', 'Video error:', e);
    }
}

function showLocalVideo(stream) {
    const card = document.getElementById('participant-self');
    if (!card) return;

    let video = card.querySelector('video');
    if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.transform = 'scaleX(-1)';
        card.insertBefore(video, card.firstChild);
    }
    video.srcObject = stream;

    const avatar = card.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'none';
}

function hideLocalVideo() {
    const card = document.getElementById('participant-self');
    if (!card) return;
    card.querySelector('video')?.remove();
    const avatar = card.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'flex';
}

async function toggleScreenShare() {
    try {
        if (!isScreenSharing) {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const track = stream.getVideoTracks()[0];
            track.onended = () => stopScreenShare();

            peers.forEach(p => p.pc.addTrack(track, stream));
            addScreenCard(stream);
            isScreenSharing = true;
            elements.screenBtn.classList.add('active');
        } else {
            stopScreenShare();
        }
    } catch (e) {
        log('❌', 'Screen error:', e);
    }
}

function stopScreenShare() {
    const card = document.getElementById('participant-screen');
    if (card) {
        const v = card.querySelector('video');
        if (v?.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
        card.remove();
    }
    isScreenSharing = false;
    elements.screenBtn.classList.remove('active');
}

function addScreenCard(stream) {
    if (document.getElementById('participant-screen')) return;

    const card = document.createElement('div');
    card.id = 'participant-screen';
    card.className = 'participant-card';

    const video = document.createElement('video');
    video.autoplay = true;
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
    pendingAction = null;
}

async function confirmName() {
    const name = elements.userNameInput.value.trim();
    if (!name) return;

    userName = name;
    const action = pendingAction;
    hideNameModal();

    if (!await getLocalStream()) return;

    if (action === 'create') {
        socket.emit('create-room', res => {
            if (res.success) joinRoomInternal(res.roomCode);
        });
    } else {
        const code = elements.roomCodeInput.value.trim().toUpperCase().replace(/-/g, '');
        joinRoomInternal(code);
    }
}

function createRoom() { showNameModal('create'); }

function joinRoom() {
    const code = elements.roomCodeInput.value.trim();
    if (!code || code.length < 4) {
        showError('Enter a valid room code.');
        return;
    }
    showNameModal('join');
}

function joinRoomInternal(roomCode) {
    socket.emit('join-room', { roomCode, userName }, res => {
        if (res.success) {
            currentRoomCode = roomCode;
            showRoomView();
            addParticipantCard('self', userName, true);

            log('🚪', `Joined ${roomCode} with ${res.participants.length} others`);

            res.participants.forEach(p => {
                addParticipantCard(p.odliterId, p.userName);
            });

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
    elements.videoBtn.classList.remove('active');
    elements.screenBtn.classList.remove('active');

    showLandingView();
}

// ========================================
// UI
// ========================================
function showLandingView() {
    elements.landingView.classList.add('active');
    elements.roomView.classList.remove('active');
    hideError();
}

function showRoomView() {
    elements.landingView.classList.remove('active');
    elements.roomView.classList.add('active');
    elements.currentRoomCode.textContent = currentRoomCode?.length === 6
        ? `${currentRoomCode.slice(0, 3)}-${currentRoomCode.slice(3)}`
        : currentRoomCode;
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

function updatePeerMuteStatus(id, muted) {
    const el = document.getElementById(`status-${id}`);
    if (el) {
        el.classList.toggle('muted', muted);
        el.querySelector('span').textContent = muted ? 'Muted' : 'Active';
    }
}

function updatePeerVideoStatus(id, enabled) {
    const card = document.getElementById(`participant-${id}`);
    if (card) {
        const avatar = card.querySelector('.participant-avatar');
        if (avatar) avatar.style.display = enabled ? 'none' : 'flex';
    }
}

async function copyRoomCode() {
    await navigator.clipboard.writeText(currentRoomCode);
    const el = elements.currentRoomCode;
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => el.textContent = orig, 1500);
}

// ========================================
// Event Listeners
// ========================================
function initEventListeners() {
    if (!elements.createRoomBtn) {
        console.error('DOM elements not found');
        return false;
    }

    elements.createRoomBtn.addEventListener('click', createRoom);
    elements.joinRoomBtn.addEventListener('click', joinRoom);
    elements.roomCodeInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') joinRoom();
    });

    elements.muteBtn.addEventListener('click', toggleMute);
    elements.videoBtn.addEventListener('click', toggleVideo);
    elements.screenBtn.addEventListener('click', toggleScreenShare);
    elements.leaveBtn.addEventListener('click', leaveRoom);
    elements.copyCodeBtn.addEventListener('click', copyRoomCode);

    elements.confirmNameBtn.addEventListener('click', confirmName);
    elements.userNameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') confirmName();
    });

    elements.grantPermissionBtn.addEventListener('click', async () => {
        if (await getLocalStream()) elements.permissionModal.classList.add('hidden');
    });

    elements.roomCodeInput.addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        hideError();
    });

    return true;
}

// ========================================
// Init
// ========================================
async function init() {
    await fetchIceServers();
    initSocket();
    if (initEventListeners()) {
        log('🚀', 'App initialized');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
