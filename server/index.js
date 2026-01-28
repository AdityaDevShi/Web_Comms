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

  // Handle WebRTC offer
  socket.on('offer', ({ targetId, offer }) => {
    socket.to(targetId).emit('offer', {
      senderId: socket.id,
      offer
    });
  });

  // Handle WebRTC answer
  socket.on('answer', ({ targetId, answer }) => {
    socket.to(targetId).emit('answer', {
      senderId: socket.id,
      answer
    });
  });

  // Handle ICE candidate
  socket.on('ice-candidate', ({ targetId, candidate }) => {
    socket.to(targetId).emit('ice-candidate', {
      senderId: socket.id,
      candidate
    });
  });

  // Handle renegotiation request
  socket.on('renegotiate', ({ targetId }) => {
    socket.to(targetId).emit('renegotiate', {
      senderId: socket.id
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
