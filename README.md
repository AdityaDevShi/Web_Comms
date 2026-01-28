# Web Comms - Real-Time Voice & Video Communication

A full-stack real-time voice and video communication web application using WebRTC with room-based joining system.

![Web Comms](https://via.placeholder.com/800x400/0a0a0f/6366f1?text=Web+Comms)

## Features

- 🎤 **Real-time voice communication** using WebRTC
- 📹 **Optional video support** (toggleable)
- 🚪 **Room-based system** with unique 6-character join codes
- 👥 **Multi-user support** in a single room
- 🔇 **Mute/unmute** microphone
- 📊 **Participant count** display
- 🎨 **Modern dark UI** with glassmorphism design
- 🔒 **Secure connections** (HTTPS compatible)
- ⚡ **No login required** - instant access

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express, Socket.IO
- **Real-time Communication**: WebRTC (RTCPeerConnection)
- **Signaling**: Socket.IO WebSockets

## Project Structure

```
WEb_RTC_Live_Comms/
├── server/
│   └── index.js          # Socket.IO signaling server
├── client/
│   ├── index.html        # Main HTML
│   ├── styles.css        # Dark-mode UI styles
│   └── app.js            # WebRTC + UI logic
├── package.json
├── .gitignore
└── README.md
```

## Local Development

### Prerequisites

- Node.js 16+ installed
- A modern browser (Chrome, Firefox, Edge, Safari)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Web_Comms.git
   cd Web_Comms
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open your browser to `http://localhost:3000`

### Testing Multi-User

1. Open `http://localhost:3000` in one browser tab
2. Click "Create Room" and note the room code
3. Open another browser tab (or incognito window)
4. Enter the room code and click "Join"
5. Both users should now be able to communicate via voice

## Deployment

### Render (Recommended)

1. Push your code to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your GitHub repository
4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
5. Deploy!

### Vercel

> ⚠️ Vercel is primarily for static/serverless deployments. For WebSocket support, use Render or Railway.

### Railway

1. Push your code to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repository
4. Railway will auto-detect and deploy

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |

## STUN/TURN Servers

The app uses Google's public STUN servers for development:
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

For production, consider using a TURN server for users behind restrictive NATs. Options include:
- [Twilio TURN](https://www.twilio.com/stun-turn)
- [Xirsys](https://xirsys.com/)
- Self-hosted [coturn](https://github.com/coturn/coturn)

## Usage

1. **Create a Room**: Click "Create Room" to generate a unique 6-character code
2. **Share the Code**: Send the room code to others
3. **Join a Room**: Enter a room code and click "Join"
4. **Mute/Unmute**: Toggle your microphone
5. **Video**: Optionally enable video (click Video button)
6. **Leave**: Click "Leave" to exit the room

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome | ✅ Full |
| Firefox | ✅ Full |
| Edge | ✅ Full |
| Safari | ✅ Full |

## License

MIT License - feel free to use this project for personal or commercial purposes.

---

Built with ❤️ using WebRTC and Socket.IO
