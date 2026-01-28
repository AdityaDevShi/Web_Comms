// ========================================
// WebRTC Voice & Video Communication App
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
let localVideoStream = null;
let screenStream = null;
let currentRoomCode = null;
let isMuted = false;
let isVideoEnabled = false;
let isScreenSharing = false;
let userName = '';
let pendingAction = null; // 'create' or 'join'

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

    socket.on('user-joined', async ({ odliterId, userName }) => {
        console.log(`User joined: ${odliterId}`);
        await createPeerConnection(odliterId, userName, true);
    });

    socket.on('user-left', ({ odliterId }) => {
        console.log(`User left: ${odliterId}`);
        removePeer(odliterId);
    });

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

    socket.on('answer', async ({ senderId, answer }) => {
        console.log(`Received answer from: ${senderId}`);
        const peer = peers.get(senderId);
        if (peer) {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

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
// WebRTC Peer Connection
// ========================================
async function createPeerConnection(odliterId, peerName, isInitiator) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Add local audio track
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // Add local video track if enabled
    if (localVideoStream) {
        localVideoStream.getTracks().forEach(track => {
            pc.addTrack(track, localVideoStream);
        });
    }

    // Add screen share track if enabled
    if (screenStream) {
        screenStream.getTracks().forEach(track => {
            pc.addTrack(track, screenStream);
        });
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                targetId: odliterId,
                candidate: event.candidate
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${odliterId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            removePeer(odliterId);
        }
    };

    pc.ontrack = (event) => {
        console.log(`Received track from: ${odliterId}`, event.track.kind);
        const [remoteStream] = event.streams;
        const peer = peers.get(odliterId);
        if (peer) {
            peer.stream = remoteStream;
        }

        if (event.track.kind === 'audio') {
            let audio = document.getElementById(`audio-${odliterId}`);
            if (!audio) {
                audio = document.createElement('audio');
                audio.id = `audio-${odliterId}`;
                audio.autoplay = true;
                audio.playsInline = true;
                elements.remoteAudioContainer.appendChild(audio);
            }
            audio.srcObject = remoteStream;
        }

        if (event.track.kind === 'video') {
            const card = document.getElementById(`participant-${odliterId}`);
            if (card) {
                let video = card.querySelector('video');
                if (!video) {
                    video = document.createElement('video');
                    video.autoplay = true;
                    video.playsInline = true;
                    video.muted = true;
                    card.insertBefore(video, card.firstChild);
                }
                video.srcObject = remoteStream;

                // Hide avatar when video is on
                const avatar = card.querySelector('.participant-avatar');
                if (avatar) avatar.style.display = 'none';
            }
        }

        addParticipantCard(odliterId, peerName);
    };

    peers.set(odliterId, { pc, userName: peerName, stream: null, isMuted: false });

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

        const audio = document.getElementById(`audio-${odliterId}`);
        if (audio) audio.remove();

        const card = document.getElementById(`participant-${odliterId}`);
        if (card) card.remove();
    }
}

// ========================================
// Media Stream
// ========================================
async function getLocalStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        });
        return true;
    } catch (err) {
        console.error('Error accessing microphone:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showError('Microphone access denied. Please allow microphone access.');
        } else if (err.name === 'NotFoundError') {
            showError('No microphone found. Please connect a microphone.');
        } else {
            showError('Could not access microphone.');
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

    elements.muteBtn.classList.toggle('muted', isMuted);
    elements.micOnIcon.classList.toggle('hidden', isMuted);
    elements.micOffIcon.classList.toggle('hidden', !isMuted);

    socket.emit('mute-status', { isMuted });

    // Update self participant card
    const selfStatus = document.getElementById('status-self');
    if (selfStatus) {
        selfStatus.classList.toggle('muted', isMuted);
        selfStatus.querySelector('span').textContent = isMuted ? 'Muted' : 'Active';
    }
}

async function toggleVideo() {
    try {
        if (!isVideoEnabled) {
            // Request video stream
            localVideoStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 1280, height: 720 }
            });

            const videoTrack = localVideoStream.getVideoTracks()[0];

            // Add video track to all peer connections
            peers.forEach(peer => {
                const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                } else {
                    peer.pc.addTrack(videoTrack, localVideoStream);
                }
            });

            // Show local video preview
            const selfCard = document.getElementById('participant-self');
            if (selfCard) {
                let video = selfCard.querySelector('video');
                if (!video) {
                    video = document.createElement('video');
                    video.autoplay = true;
                    video.playsInline = true;
                    video.muted = true;
                    video.style.transform = 'scaleX(-1)';
                    selfCard.insertBefore(video, selfCard.firstChild);
                }
                video.srcObject = localVideoStream;

                // Hide avatar when video is on
                const avatar = selfCard.querySelector('.participant-avatar');
                if (avatar) avatar.style.display = 'none';
            }

            isVideoEnabled = true;
            console.log('Video enabled');
        } else {
            // Stop video stream
            if (localVideoStream) {
                localVideoStream.getTracks().forEach(track => track.stop());
                localVideoStream = null;
            }

            // Remove video tracks from peer connections
            peers.forEach(peer => {
                const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) {
                    peer.pc.removeTrack(sender);
                }
            });

            // Remove local video preview
            const selfCard = document.getElementById('participant-self');
            if (selfCard) {
                const video = selfCard.querySelector('video');
                if (video) video.remove();

                // Show avatar again
                const avatar = selfCard.querySelector('.participant-avatar');
                if (avatar) avatar.style.display = 'flex';
            }

            isVideoEnabled = false;
            console.log('Video disabled');
        }

        // Update button state
        elements.videoBtn.classList.toggle('active', isVideoEnabled);
        elements.videoOnIcon.classList.toggle('hidden', !isVideoEnabled);
        elements.videoOffIcon.classList.toggle('hidden', isVideoEnabled);

        // Notify others
        socket.emit('video-status', { isVideoEnabled });

    } catch (err) {
        console.error('Error toggling video:', err);
        showError('Could not access camera. Please check permissions.');
    }
}

async function toggleScreenShare() {
    try {
        if (!isScreenSharing) {
            // Request screen share
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: false
            });

            const screenTrack = screenStream.getVideoTracks()[0];

            // Handle when user stops sharing via browser UI
            screenTrack.onended = () => {
                stopScreenShare();
            };

            // Add screen track to all peer connections
            peers.forEach(peer => {
                peer.pc.addTrack(screenTrack, screenStream);
            });

            // Show screen share in a card
            addScreenShareCard();

            isScreenSharing = true;
            console.log('Screen sharing enabled');

            // Update button state
            elements.screenBtn.classList.add('active');
            if (elements.screenOnIcon) elements.screenOnIcon.classList.add('hidden');
            if (elements.screenOffIcon) elements.screenOffIcon.classList.remove('hidden');

        } else {
            stopScreenShare();
        }

    } catch (err) {
        console.error('Error toggling screen share:', err);
        if (err.name !== 'NotAllowedError') {
            showError('Could not share screen.');
        }
    }
}

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }

    // Remove screen share tracks from peer connections
    peers.forEach(peer => {
        const senders = peer.pc.getSenders();
        senders.forEach(sender => {
            if (sender.track && sender.track.kind === 'video' && sender.track.label.includes('screen')) {
                peer.pc.removeTrack(sender);
            }
        });
    });

    // Remove screen share card
    const screenCard = document.getElementById('participant-screen');
    if (screenCard) screenCard.remove();

    isScreenSharing = false;
    console.log('Screen sharing disabled');

    // Update button state
    elements.screenBtn.classList.remove('active');
    if (elements.screenOnIcon) elements.screenOnIcon.classList.remove('hidden');
    if (elements.screenOffIcon) elements.screenOffIcon.classList.add('hidden');
}

function addScreenShareCard() {
    if (document.getElementById('participant-screen')) return;

    const card = document.createElement('div');
    card.id = 'participant-screen';
    card.className = 'participant-card';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = screenStream;
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
    const action = pendingAction; // Save action before clearing
    hideNameModal();

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
    socket.emit('join-room', { roomCode, userName }, (response) => {
        if (response.success) {
            currentRoomCode = roomCode;
            showRoomView();

            response.participants.forEach(async (participant) => {
                await createPeerConnection(participant.odliterId, participant.userName, true);
            });

            updateParticipantCount(response.participantCount);
            addParticipantCard('self', userName, true);
        } else {
            showError(response.error || 'Failed to join room.');
        }
    });
}

function leaveRoom() {
    socket.emit('leave-room');

    peers.forEach((peer) => {
        peer.pc.close();
    });
    peers.clear();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (localVideoStream) {
        localVideoStream.getTracks().forEach(track => track.stop());
        localVideoStream = null;
    }

    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
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
    elements.videoOnIcon.classList.remove('hidden');
    elements.videoOffIcon.classList.add('hidden');

    elements.screenBtn.classList.remove('active');
    if (elements.screenOnIcon) elements.screenOnIcon.classList.remove('hidden');
    if (elements.screenOffIcon) elements.screenOffIcon.classList.add('hidden');

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

    // Name modal
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
    console.log('Voice Chat initialized');
}

init();
