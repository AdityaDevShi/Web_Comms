// ========================================
// WebRTC Voice & Video Communication App
// ========================================

// Configuration
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
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

// Track senders for replacement
let videoSender = null;
let screenSender = null;

// Peer connections map: odliterId -> { pc, userName, audioElement, videoElement }
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
// Socket.IO Connection
// ========================================
function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('✅ Connected to signaling server:', socket.id);
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnected from signaling server');
        showError('Connection lost. Please refresh the page.');
    });

    // New user joined - we are existing, so we create offer
    socket.on('user-joined', async ({ odliterId, userName: peerName }) => {
        console.log(`👤 User joined: ${odliterId} (${peerName})`);

        // Create peer connection and send offer
        await createPeerConnection(odliterId, peerName, true);
        addParticipantCard(odliterId, peerName);
    });

    socket.on('user-left', ({ odliterId }) => {
        console.log(`👤 User left: ${odliterId}`);
        removePeer(odliterId);
    });

    // Received offer - we are new or receiving from existing
    socket.on('offer', async ({ senderId, offer }) => {
        console.log(`📨 Received offer from: ${senderId}`);

        try {
            let peerData = peers.get(senderId);

            if (!peerData) {
                // Create new peer connection without sending offer
                await createPeerConnection(senderId, 'Participant', false);
                peerData = peers.get(senderId);
                addParticipantCard(senderId, 'Participant');
            }

            const pc = peerData.pc;

            // Set remote description (the offer)
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            console.log(`📝 Set remote description for ${senderId}`);

            // Create and send answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log(`📝 Set local description (answer) for ${senderId}`);

            socket.emit('answer', { targetId: senderId, answer });
            console.log(`📤 Sent answer to ${senderId}`);

        } catch (err) {
            console.error('Error handling offer:', err);
        }
    });

    // Received answer
    socket.on('answer', async ({ senderId, answer }) => {
        console.log(`📨 Received answer from: ${senderId}`);

        try {
            const peerData = peers.get(senderId);
            if (peerData) {
                await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
                console.log(`📝 Set remote description (answer) for ${senderId}`);
            }
        } catch (err) {
            console.error('Error handling answer:', err);
        }
    });

    // ICE candidate
    socket.on('ice-candidate', async ({ senderId, candidate }) => {
        if (!candidate) return;

        try {
            const peerData = peers.get(senderId);
            if (peerData && peerData.pc.remoteDescription) {
                await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
                console.log(`🧊 Added ICE candidate from ${senderId}`);
            }
        } catch (err) {
            console.error('Error adding ICE candidate:', err);
        }
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

    // Handle renegotiation needed from peer
    socket.on('renegotiate', async ({ senderId }) => {
        console.log(`🔄 Renegotiation requested by ${senderId}`);
        const peerData = peers.get(senderId);
        if (peerData) {
            await sendOffer(senderId, peerData.pc);
        }
    });
}

// ========================================
// WebRTC Peer Connection
// ========================================
async function createPeerConnection(odliterId, peerName, isInitiator) {
    console.log(`🔗 Creating peer connection for ${odliterId}, initiator: ${isInitiator}`);

    const pc = new RTCPeerConnection(ICE_SERVERS);

    // CRITICAL: Add local tracks BEFORE creating offer
    if (localStream) {
        console.log(`🎤 Adding ${localStream.getTracks().length} local tracks`);
        localStream.getTracks().forEach(track => {
            console.log(`  → Adding ${track.kind} track: ${track.label}`);
            pc.addTrack(track, localStream);
        });
    } else {
        console.warn('⚠️ No local stream available when creating peer connection');
    }

    // ICE candidate handler
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                targetId: odliterId,
                candidate: event.candidate
            });
        }
    };

    // ICE connection state
    pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE state with ${odliterId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            console.log('Restarting ICE...');
            pc.restartIce();
        }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
        console.log(`🔌 Connection state with ${odliterId}: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            console.log(`✅ Fully connected with ${odliterId}`);
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            console.log(`❌ Connection failed/disconnected with ${odliterId}`);
        }
    };

    // CRITICAL: Handle incoming tracks
    pc.ontrack = (event) => {
        console.log(`🎵 Received ${event.track.kind} track from ${odliterId}`);

        const peerData = peers.get(odliterId);
        if (!peerData) return;

        if (event.track.kind === 'audio') {
            handleRemoteAudio(odliterId, event.streams[0]);
        } else if (event.track.kind === 'video') {
            handleRemoteVideo(odliterId, event.streams[0]);
        }
    };

    // Handle negotiation needed (when tracks are added/removed)
    pc.onnegotiationneeded = async () => {
        console.log(`🔄 Negotiation needed with ${odliterId}`);
        // Only the initiator should send a new offer
        if (isInitiator) {
            await sendOffer(odliterId, pc);
        } else {
            // Ask the other peer to renegotiate
            socket.emit('renegotiate', { targetId: odliterId });
        }
    };

    // Store peer connection
    peers.set(odliterId, {
        pc,
        userName: peerName,
        isInitiator
    });

    // If initiator, send offer
    if (isInitiator) {
        await sendOffer(odliterId, pc);
    }

    return pc;
}

async function sendOffer(odliterId, pc) {
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`📤 Sending offer to ${odliterId}`);
        socket.emit('offer', { targetId: odliterId, offer });
    } catch (err) {
        console.error('Error creating/sending offer:', err);
    }
}

function handleRemoteAudio(odliterId, stream) {
    console.log(`🔊 Setting up remote audio for ${odliterId}`);

    let audio = document.getElementById(`audio-${odliterId}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${odliterId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        elements.remoteAudioContainer.appendChild(audio);
    }

    audio.srcObject = stream;

    // Handle autoplay issues
    audio.play().catch(err => {
        console.warn('Audio autoplay blocked, waiting for user interaction');
        document.addEventListener('click', () => {
            audio.play().catch(e => console.error('Still cannot play:', e));
        }, { once: true });
    });
}

function handleRemoteVideo(odliterId, stream) {
    console.log(`📺 Setting up remote video for ${odliterId}`);

    const card = document.getElementById(`participant-${odliterId}`);
    if (!card) {
        console.warn(`No card found for ${odliterId}`);
        return;
    }

    let video = card.querySelector('video');
    if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true; // Remote video should be muted (audio comes from audio element)
        card.insertBefore(video, card.firstChild);
    }

    video.srcObject = stream;

    // Hide avatar
    const avatar = card.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'none';

    video.play().catch(err => console.warn('Video autoplay issue:', err));
}

function removePeer(odliterId) {
    const peerData = peers.get(odliterId);
    if (peerData) {
        peerData.pc.close();
        peers.delete(odliterId);

        const audio = document.getElementById(`audio-${odliterId}`);
        if (audio) audio.remove();

        const card = document.getElementById(`participant-${odliterId}`);
        if (card) card.remove();

        console.log(`🗑️ Removed peer ${odliterId}`);
    }
}

// ========================================
// Media Stream
// ========================================
async function getLocalStream() {
    try {
        console.log('🎤 Requesting microphone access...');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        console.log('✅ Got local audio stream');
        return true;
    } catch (err) {
        console.error('❌ Error accessing microphone:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showError('Microphone access denied. Please allow microphone access.');
        } else if (err.name === 'NotFoundError') {
            showError('No microphone found. Please connect a microphone.');
        } else {
            showError('Could not access microphone: ' + err.message);
        }
        return false;
    }
}

function toggleMute() {
    if (!localStream) return;

    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
        console.log(`🎤 Mic ${isMuted ? 'muted' : 'unmuted'}`);
    });

    elements.muteBtn.classList.toggle('muted', isMuted);
    elements.micOnIcon.classList.toggle('hidden', isMuted);
    elements.micOffIcon.classList.toggle('hidden', !isMuted);

    socket.emit('mute-status', { isMuted });

    const selfStatus = document.getElementById('status-self');
    if (selfStatus) {
        selfStatus.classList.toggle('muted', isMuted);
        selfStatus.querySelector('span').textContent = isMuted ? 'Muted' : 'Active';
    }
}

async function toggleVideo() {
    try {
        if (!isVideoEnabled) {
            console.log('📹 Enabling video...');

            // Get video stream
            const videoStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });

            const videoTrack = videoStream.getVideoTracks()[0];
            console.log('✅ Got video track:', videoTrack.label);

            // Add video track to all peer connections
            peers.forEach((peerData, odliterId) => {
                const sender = peerData.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                    console.log(`📹 Replaced video track for ${odliterId}`);
                } else {
                    peerData.pc.addTrack(videoTrack, videoStream);
                    console.log(`📹 Added video track to ${odliterId}`);
                }
            });

            // Show local video preview
            showLocalVideo(videoStream);

            // Store track for cleanup
            localStream.addTrack(videoTrack);
            isVideoEnabled = true;

        } else {
            console.log('📹 Disabling video...');

            // Stop video tracks
            localStream.getVideoTracks().forEach(track => {
                track.stop();
                localStream.removeTrack(track);
            });

            // Remove from peer connections
            peers.forEach((peerData, odliterId) => {
                const sender = peerData.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    sender.replaceTrack(null);
                    console.log(`📹 Removed video track from ${odliterId}`);
                }
            });

            // Remove local video preview
            hideLocalVideo();
            isVideoEnabled = false;
        }

        // Update UI
        elements.videoBtn.classList.toggle('active', isVideoEnabled);
        elements.videoOnIcon.classList.toggle('hidden', !isVideoEnabled);
        elements.videoOffIcon.classList.toggle('hidden', isVideoEnabled);

        socket.emit('video-status', { isVideoEnabled });

    } catch (err) {
        console.error('❌ Error toggling video:', err);
        showError('Could not access camera. Please check permissions.');
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
            console.log('🖥️ Starting screen share...');

            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: false
            });

            const screenTrack = screenStream.getVideoTracks()[0];
            console.log('✅ Got screen track:', screenTrack.label);

            // Handle user stopping share via browser UI
            screenTrack.onended = () => {
                console.log('🖥️ Screen share ended by user');
                stopScreenShare();
            };

            // Add screen track to all peer connections
            peers.forEach((peerData, odliterId) => {
                peerData.pc.addTrack(screenTrack, screenStream);
                console.log(`🖥️ Added screen track to ${odliterId}`);
            });

            // Show screen share preview
            addScreenShareCard(screenStream);

            // Store for cleanup
            screenSender = screenTrack;
            isScreenSharing = true;

            // Update UI
            elements.screenBtn.classList.add('active');
            if (elements.screenOnIcon) elements.screenOnIcon.classList.add('hidden');
            if (elements.screenOffIcon) elements.screenOffIcon.classList.remove('hidden');

        } else {
            stopScreenShare();
        }

    } catch (err) {
        console.error('❌ Error toggling screen share:', err);
        if (err.name !== 'NotAllowedError') {
            showError('Could not share screen.');
        }
    }
}

function stopScreenShare() {
    if (screenSender) {
        screenSender.stop();
        screenSender = null;
    }

    // Remove screen share card
    const screenCard = document.getElementById('participant-screen');
    if (screenCard) screenCard.remove();

    isScreenSharing = false;

    // Update UI
    elements.screenBtn.classList.remove('active');
    if (elements.screenOnIcon) elements.screenOnIcon.classList.remove('hidden');
    if (elements.screenOffIcon) elements.screenOffIcon.classList.add('hidden');

    console.log('🖥️ Screen share stopped');
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

    const nameLabel = document.createElement('span');
    nameLabel.className = 'participant-name';
    nameLabel.textContent = 'Your Screen';
    card.appendChild(nameLabel);

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

    // CRITICAL: Get local stream BEFORE joining room
    const hasPermission = await getLocalStream();
    if (!hasPermission) return;

    if (action === 'create') {
        socket.emit('create-room', (response) => {
            if (response.success) {
                joinRoomInternal(response.roomCode);
            } else {
                showError('Failed to create room. Please try again.');
            }
        });
    } else if (action === 'join') {
        const roomCode = elements.roomCodeInput.value.trim().toUpperCase().replace(/-/g, '');
        joinRoomInternal(roomCode);
    }
}

function createRoom() {
    showNameModal('create');
}

function joinRoom() {
    const roomCode = elements.roomCodeInput.value.trim().toUpperCase().replace(/-/g, '');
    if (!roomCode || roomCode.length < 4) {
        showError('Please enter a valid room code.');
        return;
    }
    showNameModal('join');
}

function joinRoomInternal(roomCode) {
    socket.emit('join-room', { roomCode, userName }, async (response) => {
        if (response.success) {
            currentRoomCode = roomCode;
            showRoomView();
            addParticipantCard('self', userName, true);

            console.log(`🚪 Joined room ${roomCode} with ${response.participants.length} existing participants`);

            // Connect to existing participants (they will receive user-joined and send offers)
            // We wait for their offers, then create answers
            for (const participant of response.participants) {
                addParticipantCard(participant.odliterId, participant.userName);
            }

            updateParticipantCount(response.participantCount);
        } else {
            showError(response.error || 'Failed to join room.');
        }
    });
}

function leaveRoom() {
    socket.emit('leave-room');

    peers.forEach((peerData) => {
        peerData.pc.close();
    });
    peers.clear();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    elements.remoteAudioContainer.innerHTML = '';
    elements.participantsGrid.innerHTML = '';

    currentRoomCode = null;
    isMuted = false;
    isVideoEnabled = false;
    isScreenSharing = false;
    videoSender = null;
    screenSender = null;

    elements.muteBtn.classList.remove('muted');
    elements.micOnIcon.classList.remove('hidden');
    elements.micOffIcon.classList.add('hidden');

    elements.videoBtn.classList.remove('active');
    elements.videoOnIcon.classList.remove('hidden');
    elements.videoOffIcon.classList.add('hidden');

    elements.screenBtn.classList.remove('active');
    if (elements.screenOnIcon) elements.screenOnIcon.classList.remove('hidden');
    if (elements.screenOffIcon) elements.screenOffIcon.classList.add('hidden');

    showLandingView();
    console.log('🚪 Left room');
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
    elements.currentRoomCode.textContent = formatRoomCode(currentRoomCode);
}

function formatRoomCode(code) {
    if (code.length === 6) {
        return code.slice(0, 3) + '-' + code.slice(3);
    }
    return code;
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

function addParticipantCard(id, name, isSelf = false) {
    if (document.getElementById(`participant-${id}`)) return;

    const card = document.createElement('div');
    card.id = `participant-${id}`;
    card.className = 'participant-card' + (isSelf ? ' local-video-container' : '');

    const initial = name.charAt(0).toUpperCase();

    card.innerHTML = `
        <div class="participant-avatar">${initial}</div>
        <span class="participant-name">${name}</span>
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

function updatePeerVideoStatus(odliterId, isVideoEnabled) {
    const card = document.getElementById(`participant-${odliterId}`);
    if (card) {
        const avatar = card.querySelector('.participant-avatar');
        if (avatar) {
            avatar.style.display = isVideoEnabled ? 'none' : 'flex';
        }
    }
}

async function copyRoomCode() {
    try {
        await navigator.clipboard.writeText(currentRoomCode);
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
    elements.screenBtn.addEventListener('click', toggleScreenShare);
    elements.leaveBtn.addEventListener('click', leaveRoom);
    elements.copyCodeBtn.addEventListener('click', copyRoomCode);

    elements.confirmNameBtn.addEventListener('click', confirmName);
    elements.userNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmName();
    });
    elements.userNameInput.addEventListener('input', () => {
        elements.userNameInput.style.borderColor = '';
    });

    elements.grantPermissionBtn.addEventListener('click', async () => {
        const hasPermission = await getLocalStream();
        if (hasPermission) {
            elements.permissionModal.classList.add('hidden');
        }
    });

    elements.roomCodeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        hideError();
    });
}

// ========================================
// Initialize App
// ========================================
function init() {
    initSocket();
    initEventListeners();
    console.log('🚀 Voice Chat initialized');
}

init();
