// ========================================
// WebRTC Voice & Video Communication App
// ========================================

// ICE Configuration with STUN and TURN servers
// TURN servers are CRITICAL for production - they relay media when direct connection fails
const ICE_SERVERS = {
    iceServers: [
        // STUN servers - help discover public IP
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Free TURN servers from OpenRelay project
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
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

// Peer connections map: odliterId -> { pc, userName, iceCandidateBuffer, remoteDescriptionSet }
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
        addParticipantCard(odliterId, peerName);
        await createPeerConnection(odliterId, peerName, true);
    });

    socket.on('user-left', ({ odliterId }) => {
        console.log(`👤 User left: ${odliterId}`);
        removePeer(odliterId);
    });

    // Received offer
    socket.on('offer', async ({ senderId, offer }) => {
        console.log(`📨 Received offer from: ${senderId}`);
        await handleOffer(senderId, offer);
    });

    // Received answer
    socket.on('answer', async ({ senderId, answer }) => {
        console.log(`📨 Received answer from: ${senderId}`);
        await handleAnswer(senderId, answer);
    });

    // ICE candidate
    socket.on('ice-candidate', async ({ senderId, candidate }) => {
        if (!candidate) return;
        await handleIceCandidate(senderId, candidate);
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
// Offer/Answer/ICE Handlers
// ========================================
async function handleOffer(senderId, offer) {
    try {
        let peerData = peers.get(senderId);

        if (!peerData) {
            // New peer - create connection first
            addParticipantCard(senderId, 'Participant');
            await createPeerConnection(senderId, 'Participant', false);
            peerData = peers.get(senderId);
        }

        const pc = peerData.pc;

        // Check if we can set remote description
        if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
            console.warn(`Cannot set remote offer in state: ${pc.signalingState}`);
            return;
        }

        // Set remote description
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        peerData.remoteDescriptionSet = true;
        console.log(`📝 Remote description (offer) set for ${senderId}`);

        // Flush buffered ICE candidates
        await flushIceCandidates(senderId);

        // Create and send answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`📝 Local description (answer) set for ${senderId}`);

        socket.emit('answer', { targetId: senderId, answer });
        console.log(`📤 Sent answer to ${senderId}`);

    } catch (err) {
        console.error('Error handling offer:', err);
    }
}

async function handleAnswer(senderId, answer) {
    try {
        const peerData = peers.get(senderId);
        if (!peerData) {
            console.warn(`No peer found for ${senderId}`);
            return;
        }

        const pc = peerData.pc;

        if (pc.signalingState !== 'have-local-offer') {
            console.warn(`Cannot set remote answer in state: ${pc.signalingState}`);
            return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        peerData.remoteDescriptionSet = true;
        console.log(`📝 Remote description (answer) set for ${senderId}`);

        // Flush buffered ICE candidates
        await flushIceCandidates(senderId);

    } catch (err) {
        console.error('Error handling answer:', err);
    }
}

async function handleIceCandidate(senderId, candidate) {
    try {
        let peerData = peers.get(senderId);

        // If no peer yet, buffer the candidate
        if (!peerData) {
            console.log(`🧊 Buffering ICE candidate (no peer yet) from ${senderId}`);
            // We'll receive the offer soon, store candidates temporarily
            return;
        }

        // If remote description not set, buffer the candidate
        if (!peerData.remoteDescriptionSet) {
            console.log(`🧊 Buffering ICE candidate from ${senderId}`);
            peerData.iceCandidateBuffer.push(candidate);
            return;
        }

        // Add ICE candidate directly
        await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`🧊 Added ICE candidate from ${senderId}`);

    } catch (err) {
        console.error('Error handling ICE candidate:', err);
    }
}

async function flushIceCandidates(odliterId) {
    const peerData = peers.get(odliterId);
    if (!peerData || !peerData.iceCandidateBuffer.length) return;

    console.log(`🧊 Flushing ${peerData.iceCandidateBuffer.length} buffered ICE candidates for ${odliterId}`);

    for (const candidate of peerData.iceCandidateBuffer) {
        try {
            await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('Error adding buffered ICE candidate:', err);
        }
    }
    peerData.iceCandidateBuffer = [];
}

// ========================================
// WebRTC Peer Connection
// ========================================
async function createPeerConnection(odliterId, peerName, isInitiator) {
    console.log(`🔗 Creating peer connection for ${odliterId}, initiator: ${isInitiator}`);

    // Check if connection already exists
    if (peers.has(odliterId)) {
        console.log(`Connection already exists for ${odliterId}`);
        return peers.get(odliterId).pc;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Store peer data FIRST (before adding tracks which triggers negotiationneeded)
    peers.set(odliterId, {
        pc,
        userName: peerName,
        isInitiator,
        remoteDescriptionSet: false,
        iceCandidateBuffer: [],
        makingOffer: false,
        ignoreOffer: false
    });

    // Add local audio tracks
    if (localStream) {
        console.log(`🎤 Adding ${localStream.getTracks().length} local tracks to ${odliterId}`);
        localStream.getTracks().forEach(track => {
            console.log(`  → Adding ${track.kind} track: ${track.label}, enabled: ${track.enabled}`);
            pc.addTrack(track, localStream);
        });
    } else {
        console.warn('⚠️ No localStream when creating peer connection!');
    }

    // ICE candidate handler
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 Sending ICE candidate to ${odliterId}`);
            socket.emit('ice-candidate', {
                targetId: odliterId,
                candidate: event.candidate
            });
        }
    };

    // ICE gathering state
    pc.onicegatheringstatechange = () => {
        console.log(`🧊 ICE gathering state with ${odliterId}: ${pc.iceGatheringState}`);
    };

    // ICE connection state
    pc.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE connection state with ${odliterId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            console.log('⚠️ ICE failed, attempting restart...');
            pc.restartIce();
        }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
        console.log(`🔌 Connection state with ${odliterId}: ${pc.connectionState}`);
        updateConnectionIndicator(odliterId, pc.connectionState);
    };

    // CRITICAL: Handle incoming tracks
    pc.ontrack = (event) => {
        console.log(`🎵 Received ${event.track.kind} track from ${odliterId}`);
        console.log(`   Track ID: ${event.track.id}, Label: ${event.track.label}`);
        console.log(`   Streams: ${event.streams.length}`);

        if (event.track.kind === 'audio') {
            handleRemoteAudio(odliterId, event.streams[0], event.track);
        } else if (event.track.kind === 'video') {
            handleRemoteVideo(odliterId, event.streams[0], event.track);
        }
    };

    // If initiator, create and send offer
    if (isInitiator) {
        try {
            console.log(`📤 Creating offer for ${odliterId}...`);
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await pc.setLocalDescription(offer);
            console.log(`📝 Local description (offer) set for ${odliterId}`);

            socket.emit('offer', { targetId: odliterId, offer });
            console.log(`📤 Sent offer to ${odliterId}`);
        } catch (err) {
            console.error('Error creating offer:', err);
        }
    }

    return pc;
}

function updateConnectionIndicator(odliterId, state) {
    const card = document.getElementById(`participant-${odliterId}`);
    if (!card) return;

    const status = card.querySelector('.participant-status');
    if (!status) return;

    if (state === 'connected') {
        status.style.background = 'rgba(39, 174, 96, 0.8)';
        console.log(`✅ Fully connected with ${odliterId}`);
    } else if (state === 'connecting' || state === 'new') {
        status.style.background = 'rgba(241, 196, 15, 0.8)';
    } else if (state === 'failed' || state === 'disconnected') {
        status.style.background = 'rgba(231, 76, 60, 0.8)';
    }
}

function handleRemoteAudio(odliterId, stream, track) {
    console.log(`🔊 Setting up remote audio for ${odliterId}`);

    let audio = document.getElementById(`audio-${odliterId}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${odliterId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.volume = 1.0;
        elements.remoteAudioContainer.appendChild(audio);
        console.log(`🔊 Created audio element for ${odliterId}`);
    }

    // Set the stream as source
    audio.srcObject = stream;

    // Monitor track state
    track.onunmute = () => {
        console.log(`🔊 Audio track unmuted from ${odliterId}`);
    };
    track.onmute = () => {
        console.log(`🔇 Audio track muted from ${odliterId}`);
    };

    // Force play
    const playPromise = audio.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            console.log(`🔊 Audio playing for ${odliterId}`);
        }).catch(err => {
            console.warn(`⚠️ Audio autoplay blocked for ${odliterId}:`, err.message);
            // Add click handler to resume
            const resumeAudio = () => {
                audio.play().then(() => {
                    console.log(`🔊 Audio resumed for ${odliterId}`);
                }).catch(e => console.error('Still blocked:', e));
                document.removeEventListener('click', resumeAudio);
            };
            document.addEventListener('click', resumeAudio);
        });
    }
}

function handleRemoteVideo(odliterId, stream, track) {
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
        video.muted = true; // Mute video element (audio comes from separate audio element)
        card.insertBefore(video, card.firstChild);
    }

    video.srcObject = stream;

    // Hide avatar
    const avatar = card.querySelector('.participant-avatar');
    if (avatar) avatar.style.display = 'none';

    video.play().catch(err => console.warn('Video play issue:', err));
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

        // Verify we got tracks
        const audioTracks = localStream.getAudioTracks();
        console.log(`✅ Got ${audioTracks.length} audio tracks`);
        audioTracks.forEach(track => {
            console.log(`   Track: ${track.label}, enabled: ${track.enabled}, muted: ${track.muted}`);
        });

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
        console.log(`🎤 Track ${track.label} enabled: ${track.enabled}`);
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
                video: { width: { ideal: 1280 }, height: { ideal: 720 } }
            });

            const videoTrack = videoStream.getVideoTracks()[0];
            console.log('✅ Got video track:', videoTrack.label);

            // Add video track to local stream
            localStream.addTrack(videoTrack);

            // Add to all peer connections and renegotiate
            for (const [odliterId, peerData] of peers) {
                peerData.pc.addTrack(videoTrack, localStream);
                console.log(`📹 Added video track to ${odliterId}`);

                // Renegotiate
                if (peerData.isInitiator) {
                    const offer = await peerData.pc.createOffer();
                    await peerData.pc.setLocalDescription(offer);
                    socket.emit('offer', { targetId: odliterId, offer });
                }
            }

            // Show local video preview
            showLocalVideo(videoStream);
            isVideoEnabled = true;

        } else {
            console.log('📹 Disabling video...');

            // Stop and remove video track
            localStream.getVideoTracks().forEach(track => {
                track.stop();
                localStream.removeTrack(track);
            });

            // Remove from peer connections
            peers.forEach((peerData) => {
                const senders = peerData.pc.getSenders();
                const videoSender = senders.find(s => s.track?.kind === 'video');
                if (videoSender) {
                    peerData.pc.removeTrack(videoSender);
                }
            });

            hideLocalVideo();
            isVideoEnabled = false;
        }

        elements.videoBtn.classList.toggle('active', isVideoEnabled);
        elements.videoOnIcon.classList.toggle('hidden', !isVideoEnabled);
        elements.videoOffIcon.classList.toggle('hidden', isVideoEnabled);
        socket.emit('video-status', { isVideoEnabled });

    } catch (err) {
        console.error('❌ Error toggling video:', err);
        showError('Could not access camera.');
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

            screenTrack.onended = () => {
                console.log('🖥️ Screen share ended by user');
                stopScreenShare();
            };

            // Add to all peer connections
            peers.forEach((peerData, odliterId) => {
                peerData.pc.addTrack(screenTrack, screenStream);
                console.log(`🖥️ Added screen track to ${odliterId}`);
            });

            addScreenShareCard(screenStream);
            isScreenSharing = true;

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
    const screenCard = document.getElementById('participant-screen');
    if (screenCard) {
        const video = screenCard.querySelector('video');
        if (video && video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
        }
        screenCard.remove();
    }

    isScreenSharing = false;
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

    // CRITICAL: Get microphone FIRST
    const hasPermission = await getLocalStream();
    if (!hasPermission) return;

    if (action === 'create') {
        socket.emit('create-room', (response) => {
            if (response.success) {
                joinRoomInternal(response.roomCode);
            } else {
                showError('Failed to create room.');
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

            console.log(`🚪 Joined room ${roomCode}`);
            console.log(`👥 Existing participants: ${response.participants.length}`);

            // Add cards for existing participants
            // They will send us offers when they receive the 'user-joined' event
            for (const participant of response.participants) {
                console.log(`  → ${participant.userName} (${participant.odliterId})`);
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
    if (code && code.length === 6) {
        return code.slice(0, 3) + '-' + code.slice(3);
    }
    return code || '';
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
    console.log('📡 ICE servers configured:', ICE_SERVERS.iceServers.length);
}

init();
