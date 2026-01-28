const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from client folder
app.use(express.static(path.join(__dirname, '../client')));

// ICE server configuration endpoint
// Free TURN servers from: https://gist.github.com/sagivo/3a4b2f2c7ac6e1b5267c2f1f59ac6c6b
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    // Google STUN (always works)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },

    // Free TURN servers
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
  ];

  console.log('ICE servers requested');
  res.json({ iceServers });
});

// Room management
const rooms = new Map();

// Generate unique 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Get room participants count
function getRoomParticipants(roomCode) {
  const room = rooms.get(roomCode);
  return room ? room.participants.size : 0;
}

// Broadcast participant count to room
function broadcastParticipantCount(roomCode) {
  const count = getRoomParticipants(roomCode);
  io.to(roomCode).emit('participant-count', { count });
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  let currentRoom = null;

  // Create a new room
  socket.on('create-room', (callback) => {
    let roomCode = generateRoomCode();

    // Ensure unique code
    while (rooms.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    rooms.set(roomCode, {
      participants: new Map(),
      createdAt: Date.now()
    });

    console.log(`Room created: ${roomCode}`);
    callback({ success: true, roomCode });
  });

  // Join an existing room
  socket.on('join-room', ({ roomCode, userName }, callback) => {
    roomCode = roomCode.toUpperCase();

    if (!rooms.has(roomCode)) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    const room = rooms.get(roomCode);

    // Leave previous room if any
    if (currentRoom) {
      socket.leave(currentRoom);
      const prevRoom = rooms.get(currentRoom);
      if (prevRoom) {
        prevRoom.participants.delete(socket.id);
        broadcastParticipantCount(currentRoom);
        socket.to(currentRoom).emit('user-left', { odliterId: socket.id });
      }
    }

    // Join new room
    socket.join(roomCode);
    currentRoom = roomCode;
    room.participants.set(socket.id, { userName: userName || 'Anonymous', joinedAt: Date.now() });

    // Get existing participants
    const existingParticipants = [];
    room.participants.forEach((data, odliterId) => {
      if (odliterId !== socket.id) {
        existingParticipants.push({ odliterId, userName: data.userName });
      }
    });

    console.log(`User ${socket.id} joined room ${roomCode}`);

    // Notify others in room
    socket.to(roomCode).emit('user-joined', {
      odliterId: socket.id,
      userName: userName || 'Anonymous'
    });

    broadcastParticipantCount(roomCode);

    callback({
      success: true,
      participants: existingParticipants,
      participantCount: room.participants.size
    });
  });

  // Unified signal handler for WebRTC (offers, answers, ICE candidates)
  socket.on('signal', ({ targetId, signal }) => {
    console.log(`Signal from ${socket.id} to ${targetId}:`, signal.type || 'ice-candidate');
    socket.to(targetId).emit('signal', {
      senderId: socket.id,
      signal
    });
  });

  // Handle mute status
  socket.on('mute-status', ({ isMuted }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-mute-status', {
        odliterId: socket.id,
        isMuted
      });
    }
  });

  // Handle video status
  socket.on('video-status', ({ isVideoEnabled }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-video-status', {
        odliterId: socket.id,
        isVideoEnabled
      });
    }
  });

  // Handle leave room
  socket.on('leave-room', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.participants.delete(socket.id);
        socket.to(currentRoom).emit('user-left', { odliterId: socket.id });
        broadcastParticipantCount(currentRoom);

        // Clean up empty rooms
        if (room.participants.size === 0) {
          rooms.delete(currentRoom);
          console.log(`Room ${currentRoom} deleted (empty)`);
        }
      }
      socket.leave(currentRoom);
      currentRoom = null;
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.participants.delete(socket.id);
        socket.to(currentRoom).emit('user-left', { odliterId: socket.id });
        broadcastParticipantCount(currentRoom);

        // Clean up empty rooms
        if (room.participants.size === 0) {
          rooms.delete(currentRoom);
          console.log(`Room ${currentRoom} deleted (empty)`);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
