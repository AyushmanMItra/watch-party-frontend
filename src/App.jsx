import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css'; 

// Live Railway Backend
const BACKEND_URL = 'https://watch-party-backend-production-8f66.up.railway.app';
const socket = io(BACKEND_URL);

const RemoteVideo = ({ stream, id }) => {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return (
    <div className="cam-wrapper">
      <span className="cam-label">User {id.substring(0, 4)}</span>
      <video className="cam-video" ref={ref} autoPlay playsInline />
    </div>
  );
};

function App() {
  const [roomId, setRoomId] = useState('');
  const [inRoom, setInRoom] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isConnected, setIsConnected] = useState(socket.connected);
  
  const [localVideoSrc, setLocalVideoSrc] = useState(null); 
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

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
        }).catch(err => console.error('Camera blocked:', err));
    }
  }, [inRoom]);

  // WebRTC Mesh & Screen Share Injector
  useEffect(() => {
    if (!inRoom || !myStream) return;

    const createPeer = (targetId) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      myStream.getTracks().forEach(track => pc.addTrack(track, myStream));
      
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc-offer', { target: targetId, caller: socket.id, offer });
        } catch (e) { console.error(e); }
      };
      
      pc.ontrack = (e) => {
        if (e.streams.length > 1 || (e.track.kind === 'video' && e.streams[0].id !== myStream.id)) {
            if (videoRef.current && !localVideoSrc) {
                videoRef.current.srcObject = e.streams[0];
                setIsScreenSharing(true);
            }
        } else {
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

  // Playback & Chat Sync Listeners
  useEffect(() => {
    if (!inRoom) return;
    socket.on('sync-play', (time) => { if (videoRef.current && localVideoSrc) { videoRef.current.currentTime = time; videoRef.current.play(); }});
    socket.on('sync-pause', () => { if (videoRef.current && localVideoSrc) videoRef.current.pause(); });
    socket.on('sync-seek', (time) => { if (videoRef.current && localVideoSrc) videoRef.current.currentTime = time; });
    socket.on('receive-message', (data) => setMessages(prev => [...prev, data]));

    return () => { socket.off('sync-play'); socket.off('sync-pause'); socket.off('sync-seek'); socket.off('receive-message'); };
  }, [inRoom, localVideoSrc]);

  // UI Actions
  const handleLocalFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setLocalVideoSrc(URL.createObjectURL(file));
      setIsScreenSharing(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    }
  };

  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      setLocalVideoSrc(null); 
      setIsScreenSharing(true);
      if (videoRef.current) videoRef.current.srcObject = screenStream;

      Object.values(peersRef.current).forEach(pc => {
        screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
      });

      screenStream.getVideoTracks()[0].onended = () => {
        setIsScreenSharing(false);
        if (videoRef.current) videoRef.current.srcObject = null;
      };
    } catch (err) { console.error("Screen share failed", err); }
  };

  const handleCreateRoom = () => { const code = Math.random().toString(36).substring(2, 7).toUpperCase(); setRoomId(code); setIsAdmin(true); socket.emit('join-room', code); setInRoom(true); };
  const handleJoinRoom = () => { const clean = roomId.trim().toUpperCase(); if (clean !== '') { setRoomId(clean); setIsAdmin(false); socket.emit('join-room', clean); setInRoom(true); }};
  
  // Custom Control Buttons (Force Sync)
  const syncPlay = () => { if (isAdmin && videoRef.current && localVideoSrc) socket.emit('play-video', roomId, videoRef.current.currentTime); };
  const syncPause = () => { if (isAdmin && localVideoSrc) socket.emit('pause-video', roomId); };
  const syncSeek = () => { if (isAdmin && videoRef.current && localVideoSrc) socket.emit('seek-video', roomId, videoRef.current.currentTime); };
  const sendMessage = () => { if (chatInput.trim() !== '') { socket.emit('send-message', roomId, { sender: isAdmin ? 'Admin' : 'Member', text: chatInput }); setChatInput(''); }};

  if (!inRoom) {
    return (
      <div className="login-screen">
        <div className="glass-card">
          <h2>🎬 WATCH PARTY</h2>
          <div className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 SERVER ONLINE' : '🔴 CONNECTING...'}
          </div>
          <button className="btn-primary" onClick={handleCreateRoom} disabled={!isConnected}>+ CREATE ROOM</button>
          <input type="text" className="input-field code-input" placeholder="ENTER CODE" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          <button className="btn-secondary" onClick={handleJoinRoom} disabled={!isConnected}>JOIN ROOM</button>
        </div>
      </div>
    );
  }

  return (
    <div className="theater-layout">
      {/* LEFT: MAIN STAGE */}
      <div className="main-stage">
        <div className="header-bar">
          <h2>ROOM: <span>{roomId}</span> <small>{isAdmin ? '(ADMIN)' : '(MEMBER)'}</small></h2>
          <button className="btn-outline" onClick={() => { navigator.clipboard.writeText(roomId); alert('Copied!'); }}>📋 COPY CODE</button>
        </div>

        <div className="video-container">
          {localVideoSrc ? (
            <video className="main-video" ref={videoRef} src={localVideoSrc} controls={isAdmin} onPlay={syncPlay} onPause={syncPause} onSeeked={syncSeek} />
          ) : isScreenSharing ? (
            <video className="main-video" ref={videoRef} autoPlay playsInline controls />
          ) : (
            <div className="empty-state">WAITING FOR MOVIE SELECTION...</div>
          )}
        </div>
      </div>

      {/* RIGHT: SIDE PANEL */}
      <div className="side-panel">
        
        {/* Control Box */}
        <div className="panel-section controls-section">
          <h3>CONTROLS</h3>
          
          <div className="file-input-wrapper">
             <label className="btn-secondary full-width">
                📂 CHOOSE LOCAL MOVIE
                <input type="file" accept="video/*,.mkv" onChange={handleLocalFileSelect} style={{ display: 'none' }} />
             </label>
          </div>

          {isAdmin && (
            <div className="admin-controls">
              <div className="sync-buttons">
                <button className="btn-action" onClick={syncPlay}>▶ PLAY</button>
                <button className="btn-action" onClick={syncPause}>⏸ PAUSE</button>
                <button className="btn-action" onClick={syncSeek}>🔄 SYNC TIME</button>
              </div>
              <button className="btn-primary full-width" style={{marginTop: '10px'}} onClick={startScreenShare}>🖥️ SCREEN SHARE (FALLBACK)</button>
            </div>
          )}
        </div>

        {/* Cameras Box */}
        <div className="panel-section cams-section">
          <h3>PARTY MEMBERS</h3>
          <div className="cams-grid">
            <div className="cam-wrapper">
              <span className="cam-label">You</span>
              <video className="cam-video" ref={myVideoRef} autoPlay muted playsInline />
            </div>
            {Object.entries(remoteStreams).map(([id, stream]) => (
              <RemoteVideo key={id} id={id} stream={stream} />
            ))}
          </div>
        </div>

        {/* Chat Box */}
        <div className="panel-section chat-section">
          <h3>LIVE CHAT</h3>
          <div className="chat-box">
            {messages.map((msg, idx) => (
              <div key={idx} className="chat-message">
                <span className={msg.sender === 'Admin' ? 'chat-admin' : 'chat-member'}>{msg.sender}:</span> {msg.text}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input type="text" className="input-field" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="MESSAGE..." />
            <button className="btn-primary" onClick={sendMessage}>SEND</button>
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;