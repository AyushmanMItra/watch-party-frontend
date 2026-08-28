import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css'; 

const BACKEND_URL = 'https://watch-party-backend-production-8f66.up.railway.app';
const socket = io(BACKEND_URL);

function App() {
  const [roomId, setRoomId] = useState('');
  const [inRoom, setInRoom] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [localVideoSrc, setLocalVideoSrc] = useState(null); // Replaces Cloudinary URL
  const [isConnected, setIsConnected] = useState(socket.connected);
  
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  const videoRef = useRef(null);
  const myVideoRef = useRef(null);
  const partnerVideoRef = useRef(null);
  const [myStream, setMyStream] = useState(null);
  const peerConnectionRef = useRef(null);

  // 1. Connection Auto-Rejoin
  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      if (inRoom && roomId) socket.emit('join-room', roomId);
    };
    const onDisconnect = () => setIsConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, [inRoom, roomId]);

  // 2. Initialize Webcam
  useEffect(() => {
    if (inRoom) {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then((stream) => {
          setMyStream(stream);
          if (myVideoRef.current) myVideoRef.current.srcObject = stream;
          socket.emit('user-ready-for-video', roomId);
        })
        .catch((error) => console.error('Camera blocked or unavailable:', error));
    }
  }, [inRoom, roomId]);

  // 3. WebRTC and Playback Sync
  useEffect(() => {
    if (!inRoom) return;

    // Timeline Syncing Listeners
    socket.on('sync-play', (time) => { if (videoRef.current) { videoRef.current.currentTime = time; videoRef.current.play(); }});
    socket.on('sync-pause', () => { if (videoRef.current) videoRef.current.pause(); });
    socket.on('sync-seek', (time) => { if (videoRef.current) videoRef.current.currentTime = time; });
    socket.on('receive-message', (data) => setMessages((prev) => [...prev, data]));

    // WebRTC Peer Connection
    const createPeerConnection = () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      if (myStream) myStream.getTracks().forEach(track => pc.addTrack(track, myStream));
      pc.ontrack = (event) => { if (partnerVideoRef.current) partnerVideoRef.current.srcObject = event.streams[0]; };
      pc.onicecandidate = (event) => { if (event.candidate) socket.emit('webrtc-ice-candidate', roomId, event.candidate); };
      return pc;
    };

    socket.on('user-ready-for-video', async () => {
      peerConnectionRef.current = createPeerConnection();
      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      socket.emit('webrtc-offer', roomId, offer);
    });

    socket.on('webrtc-offer', async (offer) => {
      peerConnectionRef.current = createPeerConnection();
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socket.emit('webrtc-answer', roomId, answer);
    });

    socket.on('webrtc-answer', async (answer) => {
      if (peerConnectionRef.current) await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('webrtc-ice-candidate', async (candidate) => {
      if (peerConnectionRef.current) await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    });

    return () => {
      socket.off('sync-play'); socket.off('sync-pause'); socket.off('sync-seek'); socket.off('receive-message'); 
      socket.off('user-ready-for-video'); socket.off('webrtc-offer'); socket.off('webrtc-answer'); socket.off('webrtc-ice-candidate');
    };
  }, [inRoom, myStream, roomId]);

  // --- UI ACTIONS ---
  const handleCreateRoom = () => {
    const newRoomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    setRoomId(newRoomCode); setIsAdmin(true); socket.emit('join-room', newRoomCode); setInRoom(true);
  };

  const handleJoinRoom = () => {
    const clean = roomId.trim().toUpperCase();
    if (clean !== '') { setRoomId(clean); setIsAdmin(false); socket.emit('join-room', clean); setInRoom(true); }
  };
  
  // NEW: Local File Loader (Instant, No Uploads!)
  const handleLocalFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      const fileUrl = URL.createObjectURL(file);
      setLocalVideoSrc(fileUrl);
    }
  };

  const handlePlay = () => { if (isAdmin && videoRef.current) socket.emit('play-video', roomId, videoRef.current.currentTime); };
  const handlePause = () => { if (isAdmin) socket.emit('pause-video', roomId); };
  const handleSeek = () => { if (isAdmin && videoRef.current) socket.emit('seek-video', roomId, videoRef.current.currentTime); };
  const sendMessage = () => { if (chatInput.trim() !== '') { socket.emit('send-message', roomId, { sender: isAdmin ? 'Admin' : 'Member', text: chatInput }); setChatInput(''); }};

  // --- LOGIN SCREEN ---
  if (!inRoom) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div className="glass-card">
          <h2>🎬 Watch Party</h2>
          <p>Zero-latency local video sync.</p>
          
          <div style={{ padding: '10px', margin: '10px 0', borderRadius: '5px', backgroundColor: isConnected ? 'rgba(35, 134, 54, 0.2)' : 'rgba(218, 54, 51, 0.2)', color: isConnected ? '#2ea043' : '#ff7b72' }}>
            {isConnected ? '🟢 Connected to Server' : '🔴 Waking up server...'}
          </div>

          <div style={{ marginTop: '30px', paddingBottom: '20px', borderBottom: '1px solid #30363d' }}>
            <button className="btn-primary" onClick={handleCreateRoom} style={{ width: '100%', backgroundColor: '#238636' }} disabled={!isConnected}>
              + Create New Room
            </button>
          </div>

          <div style={{ marginTop: '20px' }}>
            <p style={{ fontSize: '0.9rem', color: '#8b949e' }}>Or join an existing room:</p>
            <input type="text" className="input-field" placeholder="Enter 5-Letter Code" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ textAlign: 'center', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '10px' }} />
            <button className="btn-secondary" onClick={handleJoinRoom} style={{ width: '100%', backgroundColor: '#1f6feb', color: '#fff' }} disabled={!isConnected}>
              Join Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- MAIN ROOM VIEW ---
  return (
    <div className="app-container">
      {/* Top Header & Copy Button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: '1200px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <h2>Room Code: <span style={{ color: '#58a6ff', letterSpacing: '2px' }}>{roomId}</span> <span style={{fontSize: '0.8rem', color: '#8b949e'}}>{isAdmin ? '(Admin)' : '(Member)'}</span></h2>
          <button 
            className="btn-secondary" 
            onClick={() => { navigator.clipboard.writeText(roomId); alert('Room code copied to clipboard!'); }}
            style={{ padding: '6px 12px', fontSize: '0.85rem' }}
          >
            📋 Copy Code
          </button>
        </div>
      </div>

      {/* Local File Selector (Visible to BOTH users) */}
      <div className="glass-card" style={{ marginBottom: '20px', maxWidth: '1200px', width: '100%', textAlign: 'left', padding: '15px' }}>
        <h3 style={{ marginTop: 0 }}>Select Movie</h3>
        <p style={{ fontSize: '0.9rem', color: '#8b949e', marginTop: '-10px' }}>
          Both users must select the same video file from their computer. No data is uploaded!
        </p>
        <input type="file" accept="video/*" onChange={handleLocalFileSelect} style={{ color: '#c9d1d9' }} />
      </div>

      {/* Video Player Area */}
      {localVideoSrc ? (
        <div className="video-container">
          {/* Note: controls={isAdmin} means ONLY the admin can click pause/play */}
          <video 
            className="main-video" 
            ref={videoRef} 
            src={localVideoSrc} 
            controls={isAdmin} 
            onPlay={handlePlay} 
            onPause={handlePause} 
            onSeeked={handleSeek} 
          />
        </div>
      ) : (
        <div className="glass-card" style={{ padding: '40px', margin: '20px 0', maxWidth: '1200px', width: '100%' }}>
          <p>Waiting for you to select a local video file...</p>
        </div>
      )}

      {/* 3-Panel Dashboard */}
      <div className="dashboard">
        <div className="panel">
          <h3>Live Chat</h3>
          <div className="chat-box">
            {messages.map((msg, idx) => (
              <div key={idx} className="chat-message">
                <span className="chat-sender" style={{ color: msg.sender === 'Admin' ? '#58a6ff' : '#3fb950' }}>{msg.sender}:</span> {msg.text}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input type="text" className="input-field" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." />
            <button className="btn-primary" onClick={sendMessage}>Send</button>
          </div>
        </div>

        <div className="panel">
          <h3>My Camera</h3>
          <video className="cam-video" ref={myVideoRef} autoPlay muted playsInline />
        </div>

        <div className="panel">
          <h3>Partner Camera</h3>
          <video className="cam-video" ref={partnerVideoRef} autoPlay playsInline />
        </div>
      </div>
    </div>
  );
}

export default App;