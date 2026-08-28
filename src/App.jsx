import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css'; 

const BACKEND_URL = 'https://watch-party-backend-production-8f66.up.railway.app';
const socket = io(BACKEND_URL);

// Dynamic Grid Component for Webcams
const RemoteVideo = ({ stream, id }) => {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return (
    <div className="panel">
      <h3>User {id.substring(0, 4)}</h3>
      <video className="cam-video" ref={ref} autoPlay playsInline />
    </div>
  );
};

function App() {
  const [roomId, setRoomId] = useState('');
  const [inRoom, setInRoom] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  // --- DUAL-ENGINE MEDIA STATES ---
  const [localVideoSrc, setLocalVideoSrc] = useState(null); 
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const [myStream, setMyStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const peersRef = useRef({});
  
  const videoRef = useRef(null);
  const myVideoRef = useRef(null);

  // Connection Init
  useEffect(() => {
    const onConnect = () => { setIsConnected(true); if (inRoom && roomId) socket.emit('join-room', roomId); };
    const onDisconnect = () => setIsConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, [inRoom, roomId]);

  // Webcam Init
  useEffect(() => {
    if (inRoom) {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then((stream) => {
          setMyStream(stream);
          if (myVideoRef.current) myVideoRef.current.srcObject = stream;
        })
        .catch(err => console.error('Camera blocked:', err));
    }
  }, [inRoom]);

  // --- WEBRTC MESH & DUAL SIGNALING ---
  useEffect(() => {
    if (!inRoom || !myStream) return;

    const createPeer = (targetId) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      
      // Add Webcam Track
      myStream.getTracks().forEach(track => pc.addTrack(track, myStream));
      
      // Handle Renegotiation for Screen Sharing
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc-offer', { target: targetId, caller: socket.id, offer });
        } catch (e) { console.error(e); }
      };
      
      pc.ontrack = (e) => {
        // If a peer sends a second stream, it is their Screen Share!
        if (e.streams.length > 1 || (e.track.kind === 'video' && e.streams[0].id !== myStream.id)) {
            if (videoRef.current && !localVideoSrc) {
                videoRef.current.srcObject = e.streams[0];
                setIsScreenSharing(true);
            }
        } else {
            // Otherwise, it is their webcam
            setRemoteStreams(prev => ({ ...prev, [targetId]: e.streams[0] }));
        }
      };
      
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('webrtc-ice-candidate', { target: targetId, caller: socket.id, candidate: e.candidate });
      };
      return pc;
    };

    socket.on('user-connected', async (newUserId) => {
      const pc = createPeer(newUserId);
      peersRef.current[newUserId] = pc;
    });

    socket.on('webrtc-offer', async ({ caller, offer }) => {
      const pc = peersRef.current[caller] || createPeer(caller);
      peersRef.current[caller] = pc;
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { target: caller, caller: socket.id, answer });
    });

    socket.on('webrtc-answer', async ({ caller, answer }) => {
      if (peersRef.current[caller]) await peersRef.current[caller].setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('webrtc-ice-candidate', async ({ caller, candidate }) => {
      if (peersRef.current[caller]) await peersRef.current[caller].addIceCandidate(new RTCIceCandidate(candidate));
    });

    socket.on('user-disconnected', (userId) => {
      if (peersRef.current[userId]) peersRef.current[userId].close();
      delete peersRef.current[userId];
      setRemoteStreams(prev => { const copy = { ...prev }; delete copy[userId]; return copy; });
    });

    return () => {
      socket.off('user-connected'); socket.off('webrtc-offer'); socket.off('webrtc-answer'); socket.off('webrtc-ice-candidate'); socket.off('user-disconnected');
    };
  }, [inRoom, myStream, localVideoSrc]);

  // --- TIMELINE SYNC FOR LOCAL FILES ---
  useEffect(() => {
    if (!inRoom) return;
    
    socket.on('sync-play', (time) => { if (videoRef.current && localVideoSrc) { videoRef.current.currentTime = time; videoRef.current.play(); }});
    socket.on('sync-pause', () => { if (videoRef.current && localVideoSrc) videoRef.current.pause(); });
    socket.on('sync-seek', (time) => { if (videoRef.current && localVideoSrc) videoRef.current.currentTime = time; });
    socket.on('receive-message', (data) => setMessages(prev => [...prev, data]));

    return () => { socket.off('sync-play'); socket.off('sync-pause'); socket.off('sync-seek'); socket.off('receive-message'); };
  }, [inRoom, localVideoSrc]);

  // --- ACTIONS ---
  const handleLocalFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setLocalVideoSrc(URL.createObjectURL(file));
      setIsScreenSharing(false);
      if (videoRef.current) videoRef.current.srcObject = null; // Clear screen share if active
    }
  };

  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setLocalVideoSrc(null); // Clear local file if active
      setIsScreenSharing(true);
      
      if (videoRef.current) videoRef.current.srcObject = screenStream;

      // Broadcast screen stream to all connected friends
      Object.values(peersRef.current).forEach(pc => {
        screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
      });

      // Handle Admin clicking "Stop Sharing"
      screenStream.getVideoTracks()[0].onended = () => {
        setIsScreenSharing(false);
        if (videoRef.current) videoRef.current.srcObject = null;
      };
    } catch (err) {
      console.error("Screen share failed", err);
    }
  };

  const handleCreateRoom = () => { const code = Math.random().toString(36).substring(2, 7).toUpperCase(); setRoomId(code); setIsAdmin(true); socket.emit('join-room', code); setInRoom(true); };
  const handleJoinRoom = () => { const clean = roomId.trim().toUpperCase(); if (clean !== '') { setRoomId(clean); setIsAdmin(false); socket.emit('join-room', clean); setInRoom(true); }};
  
  const handlePlay = () => { if (isAdmin && videoRef.current && localVideoSrc) socket.emit('play-video', roomId, videoRef.current.currentTime); };
  const handlePause = () => { if (isAdmin && localVideoSrc) socket.emit('pause-video', roomId); };
  const handleSeek = () => { if (isAdmin && videoRef.current && localVideoSrc) socket.emit('seek-video', roomId, videoRef.current.currentTime); };
  const sendMessage = () => { if (chatInput.trim() !== '') { socket.emit('send-message', roomId, { sender: isAdmin ? 'Admin' : 'Member', text: chatInput }); setChatInput(''); }};

  if (!inRoom) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div className="glass-card">
          <h2>🎬 Hybrid Watch Party</h2>
          <div style={{ padding: '10px', margin: '10px 0', borderRadius: '5px', backgroundColor: isConnected ? 'rgba(35, 134, 54, 0.2)' : 'rgba(218, 54, 51, 0.2)', color: isConnected ? '#2ea043' : '#ff7b72' }}>
            {isConnected ? '🟢 Server Connected' : '🔴 Server Offline'}
          </div>
          <button className="btn-primary" onClick={handleCreateRoom} style={{ width: '100%', marginBottom: '20px' }} disabled={!isConnected}>+ Create Room</button>
          <input type="text" className="input-field" placeholder="Enter Code" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ textAlign: 'center', textTransform: 'uppercase', marginBottom: '10px' }} />
          <button className="btn-secondary" onClick={handleJoinRoom} style={{ width: '100%' }} disabled={!isConnected}>Join Room</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: '1200px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <h2>Room: <span style={{ color: '#58a6ff', letterSpacing: '2px' }}>{roomId}</span> <span style={{fontSize: '0.8rem', color: '#8b949e'}}>{isAdmin ? '(Admin)' : '(Member)'}</span></h2>
          <button className="btn-secondary" onClick={() => { navigator.clipboard.writeText(roomId); alert('Copied!'); }} style={{ padding: '6px 12px' }}>📋 Copy Code</button>
        </div>
      </div>

      {/* DUAL MODE CONTROLS */}
      <div className="glass-card" style={{ marginBottom: '20px', maxWidth: '1200px', width: '100%', textAlign: 'left', padding: '15px' }}>
        <h3 style={{ marginTop: 0 }}>Select Watch Mode</h3>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <div style={{ flex: 1, padding: '15px', border: '1px solid #30363d', borderRadius: '8px' }}>
            <h4>Option A: Zero-Lag Local Sync</h4>
            <p style={{ fontSize: '0.85rem', color: '#8b949e' }}>Both users select the downloaded .mkv/.mp4 file to sync perfectly.</p>
            <input type="file" accept="video/*,.mkv" onChange={handleLocalFileSelect} style={{ color: '#c9d1d9' }} />
          </div>
          
          {isAdmin && (
            <div style={{ flex: 1, padding: '15px', border: '1px solid #30363d', borderRadius: '8px' }}>
              <h4>Option B: Live Screen Share</h4>
              <p style={{ fontSize: '0.85rem', color: '#8b949e' }}>Play the movie on VLC and beam your screen to the room.</p>
              <button className="btn-primary" onClick={startScreenShare}>🖥️ Share Screen & Audio</button>
            </div>
          )}
        </div>
      </div>

      {/* MAIN MOVIE PLAYER */}
      <div className="video-container">
        {localVideoSrc ? (
          <video className="main-video" ref={videoRef} src={localVideoSrc} controls={isAdmin} onPlay={handlePlay} onPause={handlePause} onSeeked={handleSeek} />
        ) : isScreenSharing ? (
          <video className="main-video" ref={videoRef} autoPlay playsInline controls />
        ) : (
          <div className="glass-card" style={{ padding: '40px', width: '100%' }}>Waiting for movie selection...</div>
        )}
      </div>

      {/* MESH NETWORK GRID */}
      <div className="dynamic-grid">
        <div className="panel chat-panel">
          <h3>Live Chat</h3>
          <div className="chat-box">
            {messages.map((msg, idx) => (
              <div key={idx} className="chat-message">
                <span style={{ fontWeight: 'bold', color: msg.sender === 'Admin' ? '#58a6ff' : '#3fb950' }}>{msg.sender}:</span> {msg.text}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input type="text" className="input-field" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="Message..." />
            <button className="btn-primary" onClick={sendMessage}>Send</button>
          </div>
        </div>

        <div className="panel">
          <h3>You</h3>
          <video className="cam-video" ref={myVideoRef} autoPlay muted playsInline />
        </div>

        {Object.entries(remoteStreams).map(([id, stream]) => (
          <RemoteVideo key={id} id={id} stream={stream} />
        ))}
      </div>
    </div>
  );
}

export default App;