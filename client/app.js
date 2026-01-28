// ========================================
// WebRTC Voice Communication App
// ========================================

// Configuration
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// State
let socket = null;
let localStream = null;
let currentRoomCode = null;
let isMuted = false;
let isVideoEnabled = false;
let userName = 'You';

// Peer connections map: odliterId -> { pc: RTCPeerConnection, stream: MediaStream }
const peers = new Map();

// DOM Elements
const elements = {
    // Views
    landingView: document.getElementById('landing-view'),
    roomView: document.getElementById('room-view'),

    // Landing
    createRoomBtn: document.getElementById('create-room-btn'),
    joinRoomBtn: document.getElementById('join-room-btn'),
    roomCodeInput: document.getElementById('room-code-input'),
    errorMessage: document.getElementById('error-message'),

    // Room
    currentRoomCode: document.getElementById('current-room-code'),
    copyCodeBtn: document.getElementById('copy-code-btn'),
    participantCountText: document.getElementById('participant-count-text'),
    participantsGrid: document.getElementById('participants-grid'),
    connectionStatus: document.getElementById('connection-status'),

    // Controls
    muteBtn: document.getElementById('mute-btn'),
    videoBtn: document.getElementById('video-btn'),
    leaveBtn: document.getElementById('leave-btn'),
    micOnIcon: document.getElementById('mic-on-icon'),
    micOffIcon: document.getElementById('mic-off-icon'),
    videoOnIcon: document.getElementById('video-on-icon'),
    videoOffIcon: document.getElementById('video-off-icon'),

    // Modal
    permissionModal: document.getElementById('permission-modal'),
    grantPermissionBtn: document.getElementById('grant-permission-btn'),

    // Audio
    remoteAudioContainer: document.getElementById('remote-audio-container')
};

// ========================================
// Socket.IO Connection
// ========================================
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Connected to signaling server');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from signaling server');
        showError('Connection lost. Please refresh the page.');
    });

    // New user joined the room
    socket.on('user-joined', async ({ odliterId, userName }) => {
        console.log(`User joined: ${odliterId}`);
        await createPeerConnection(odliterId, userName, true);
    });

    // User left the room
    socket.on('user-left', ({ odliterId }) => {
        console.log(`User left: ${odliterId}`);
        removePeer(odliterId);
    });

    // Receive offer from remote peer
    socket.on('offer', async ({ senderId, offer }) => {
        console.log(`Received offer from: ${senderId}`);

        let peer = peers.get(senderId);
        if (!peer) {
            await createPeerConnection(senderId, 'Participant', false);
            peer = peers.get(senderId);
        }

        await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);

        socket.emit('answer', { targetId: senderId, answer });
    });

    // Receive answer from remote peer
    socket.on('answer', async ({ senderId, answer }) => {
        console.log(`Received answer from: ${senderId}`);
        const peer = peers.get(senderId);
        if (peer) {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    // Receive ICE candidate
    socket.on('ice-candidate', async ({ senderId, candidate }) => {
        const peer = peers.get(senderId);
        if (peer && candidate) {
            try {
                await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('Error adding ICE candidate:', err);
            }
        }
    });

    // Participant count update
    socket.on('participant-count', ({ count }) => {
        updateParticipantCount(count);
    });

    // User mute status change
    socket.on('user-mute-status', ({ odliterId, isMuted }) => {
        updatePeerMuteStatus(odliterId, isMuted);
    });
}

// ========================================
// WebRTC Peer Connection
// ========================================
async function createPeerConnection(odliterId, peerName, isInitiator) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Add local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                targetId: odliterId,
                candidate: event.candidate
            });
        }
    };

    // Handle connection state change
    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${odliterId}: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            updateConnectionStatus('Connected', true);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            removePeer(odliterId);
        }
    };

    // Handle remote stream
    pc.ontrack = (event) => {
        console.log(`Received track from: ${odliterId}`);
        const [remoteStream] = event.streams;

        // Update peer data
        const peer = peers.get(odliterId);
        if (peer) {
            peer.stream = remoteStream;
        }

        // Create or update audio element
        let audio = document.getElementById(`audio-${odliterId}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${odliterId}`;
            audio.autoplay = true;
            audio.playsInline = true;
            elements.remoteAudioContainer.appendChild(audio);
        }
        audio.srcObject = remoteStream;

        // Add participant card
        addParticipantCard(odliterId, peerName);
    };

    // Store peer connection
    peers.set(odliterId, { pc, userName: peerName, stream: null, isMuted: false });

    // Create offer if initiator
    if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { targetId: odliterId, offer });
    }

    return pc;
}

function removePeer(odliterId) {
    const peer = peers.get(odliterId);
    if (peer) {
        peer.pc.close();
        peers.delete(odliterId);

        // Remove audio element
        const audio = document.getElementById(`audio-${odliterId}`);
        if (audio) {
            audio.remove();
        }

        // Remove participant card
        const card = document.getElementById(`participant-${odliterId}`);
        if (card) {
            card.remove();
        }
    }
}

// ========================================
// Media Stream
// ========================================
async function getLocalStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false // Video disabled by default
        });
        return true;
    } catch (err) {
        console.error('Error accessing microphone:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showError('Microphone access denied. Please allow microphone access to join voice rooms.');
        } else if (err.name === 'NotFoundError') {
            showError('No microphone found. Please connect a microphone and try again.');
        } else {
            showError('Could not access microphone. Please check your device settings.');
        }
        return false;
    }
}

function toggleMute() {
    if (!localStream) return;

    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
    });

    // Update UI
    elements.muteBtn.classList.toggle('muted', isMuted);
    elements.micOnIcon.classList.toggle('hidden', isMuted);
    elements.micOffIcon.classList.toggle('hidden', !isMuted);
    elements.muteBtn.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';

    // Notify other participants
    socket.emit('mute-status', { isMuted });
}

async function toggleVideo() {
    if (!localStream) return;

    const videoTracks = localStream.getVideoTracks();

    if (videoTracks.length === 0 && !isVideoEnabled) {
        // Request video
        try {
            const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const videoTrack = videoStream.getVideoTracks()[0];
            localStream.addTrack(videoTrack);

            // Add track to all peer connections
            peers.forEach(peer => {
                peer.pc.addTrack(videoTrack, localStream);
            });

            isVideoEnabled = true;
        } catch (err) {
            console.error('Error accessing camera:', err);
            showError('Could not access camera.');
            return;
        }
    } else {
        // Toggle existing video tracks
        isVideoEnabled = !isVideoEnabled;
        videoTracks.forEach(track => {
            track.enabled = isVideoEnabled;
        });
    }

    // Update UI
    elements.videoBtn.classList.toggle('active', isVideoEnabled);
    elements.videoOnIcon.classList.toggle('hidden', !isVideoEnabled);
    elements.videoOffIcon.classList.toggle('hidden', isVideoEnabled);
    elements.videoBtn.querySelector('span').textContent = isVideoEnabled ? 'Stop' : 'Video';
}

// ========================================
// Room Management
// ========================================
async function createRoom() {
    // Get microphone permission first
    const hasPermission = await getLocalStream();
    if (!hasPermission) return;

    socket.emit('create-room', (response) => {
        if (response.success) {
            joinRoomInternal(response.roomCode);
        } else {
            showError('Failed to create room. Please try again.');
        }
    });
}

async function joinRoom() {
    const roomCode = elements.roomCodeInput.value.trim().toUpperCase();

    if (!roomCode || roomCode.length < 4) {
        showError('Please enter a valid room code.');
        return;
    }

    // Get microphone permission first
    const hasPermission = await getLocalStream();
    if (!hasPermission) return;

    joinRoomInternal(roomCode);
}

function joinRoomInternal(roomCode) {
    socket.emit('join-room', { roomCode, userName }, (response) => {
        if (response.success) {
            currentRoomCode = roomCode;
            showRoomView();

            // Connect to existing participants
            response.participants.forEach(async (participant) => {
                await createPeerConnection(participant.odliterId, participant.userName, true);
            });

            updateParticipantCount(response.participantCount);
            updateConnectionStatus('Connected', true);

            // Add self to participants
            addParticipantCard('self', userName, true);
        } else {
            showError(response.error || 'Failed to join room.');
        }
    });
}

function leaveRoom() {
    socket.emit('leave-room');

    // Close all peer connections
    peers.forEach((peer, odliterId) => {
        peer.pc.close();
    });
    peers.clear();

    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Clear audio elements
    elements.remoteAudioContainer.innerHTML = '';

    // Clear participant cards
    elements.participantsGrid.innerHTML = '';

    // Reset state
    currentRoomCode = null;
    isMuted = false;
    isVideoEnabled = false;

    // Update UI
    elements.muteBtn.classList.remove('muted');
    elements.micOnIcon.classList.remove('hidden');
    elements.micOffIcon.classList.add('hidden');
    elements.muteBtn.querySelector('span').textContent = 'Mute';

    elements.videoBtn.classList.remove('active');
    elements.videoOnIcon.classList.remove('hidden');
    elements.videoOffIcon.classList.add('hidden');
    elements.videoBtn.querySelector('span').textContent = 'Video';

    showLandingView();
}

// ========================================
// UI Updates
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
    elements.currentRoomCode.textContent = currentRoomCode;
}

function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.remove('hidden');
}

function hideError() {
    elements.errorMessage.classList.add('hidden');
}

function updateParticipantCount(count) {
    elements.participantCountText.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
}

function updateConnectionStatus(text, connected) {
    elements.connectionStatus.textContent = text;
    elements.connectionStatus.classList.toggle('connected', connected);
}

function addParticipantCard(id, name, isSelf = false) {
    // Check if card already exists
    if (document.getElementById(`participant-${id}`)) return;

    const card = document.createElement('div');
    card.id = `participant-${id}`;
    card.className = 'participant-card';
    if (isSelf) card.classList.add('self');

    const initial = name.charAt(0).toUpperCase();

    card.innerHTML = `
    <div class="participant-avatar">${initial}</div>
    <span class="participant-name">${isSelf ? 'You' : name}</span>
    <div class="participant-status" id="status-${id}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
        <path d="M19 10v2a7 7 0 01-14 0v-2"/>
      </svg>
      <span>Active</span>
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

async function copyRoomCode() {
    try {
        await navigator.clipboard.writeText(currentRoomCode);
        // Show brief feedback
        const originalText = elements.currentRoomCode.textContent;
        elements.currentRoomCode.textContent = 'Copied!';
        setTimeout(() => {
            elements.currentRoomCode.textContent = originalText;
        }, 1500);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
}

// ========================================
// Event Listeners
// ========================================
function initEventListeners() {
    elements.createRoomBtn.addEventListener('click', createRoom);
    elements.joinRoomBtn.addEventListener('click', joinRoom);
    elements.roomCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    elements.muteBtn.addEventListener('click', toggleMute);
    elements.videoBtn.addEventListener('click', toggleVideo);
    elements.leaveBtn.addEventListener('click', leaveRoom);
    elements.copyCodeBtn.addEventListener('click', copyRoomCode);

    elements.grantPermissionBtn.addEventListener('click', async () => {
        const hasPermission = await getLocalStream();
        if (hasPermission) {
            elements.permissionModal.classList.add('hidden');
        }
    });

    // Auto-uppercase room code input
    elements.roomCodeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase();
        hideError();
    });
}

// ========================================
// Initialize App
// ========================================
function init() {
    initSocket();
    initEventListeners();
    console.log('Web Comms initialized');
}

// Start the app
init();
