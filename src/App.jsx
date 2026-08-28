import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css'; 

const BACKEND_URL = 'https://watch-party-backend-production-abfa.up.railway.app';
const socket = io(BACKEND_URL);

function App() {
  const [roomId, setRoomId] = useState('');
  const [inRoom, setInRoom] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  const videoRef = useRef(null);
  
  const myVideoRef = useRef(null);
  const partnerVideoRef = useRef(null);
  const [myStream, setMyStream] = useState(null);
  const peerConnectionRef = useRef(null);

  useEffect(() => {
    if (inRoom) {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then((stream) => {
          setMyStream(stream);
          if (myVideoRef.current) myVideoRef.current.srcObject = stream;
          socket.emit('user-ready-for-video', roomId);
        })
        .catch((error) => console.error('Media access error:', error));
    }
  }, [inRoom, roomId]);

  useEffect(() => {
    if (!inRoom) return;

    socket.on('sync-video-url', (url) => setVideoUrl(url));
    socket.on('sync-play', (time) => { if (videoRef.current) { videoRef.current.currentTime = time; videoRef.current.play(); }});
    socket.on('sync-pause', () => { if (videoRef.current) videoRef.current.pause(); });
    socket.on('sync-seek', (time) => { if (videoRef.current) videoRef.current.currentTime = time; });
    socket.on('receive-message', (data) => setMessages((prev) => [...prev, data]));

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
      socket.off('sync-video-url'); socket.off('sync-play'); socket.off('sync-pause');
      socket.off('sync-seek'); socket.off('receive-message'); socket.off('user-ready-for-video');
      socket.off('webrtc-offer'); socket.off('webrtc-answer'); socket.off('webrtc-ice-candidate');
    };
  }, [inRoom, myStream, roomId]);

  const handleJoinRoom = () => { const clean = roomId.trim(); if (clean !== '') { setRoomId(clean); socket.emit('join-room', clean); setInRoom(true); }};
  
  const handleUpload = async () => {
    if (!videoFile) return;
    const formData = new FormData(); formData.append('video', videoFile);
    const res = await fetch(`${BACKEND_URL}/upload`, { method: 'POST', body: formData });
    const data = await res.json();
    setVideoUrl(data.downloadUrl); socket.emit('video-uploaded', roomId, data.downloadUrl);
  };

  const handlePlay = () => { if (isAdmin && videoRef.current) socket.emit('play-video', roomId, videoRef.current.currentTime); };
  const handlePause = () => { if (isAdmin) socket.emit('pause-video', roomId); };
  const handleSeek = () => { if (isAdmin && videoRef.current) socket.emit('seek-video', roomId, videoRef.current.currentTime); };
  const sendMessage = () => { if (chatInput.trim() !== '') { socket.emit('send-message', roomId, { sender: isAdmin ? 'Admin' : 'Member', text: chatInput }); setChatInput(''); }};

  if (!inRoom) {
    return (
      <div className="app-container">
        <div className="glass-card">
          <h2>🎬 Watch Party</h2>
          <p>Host movies with friends in real-time.</p>
          <input type="text" className="input-field" placeholder="Enter Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          <div style={{ margin: '15px 0' }}>
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} style={{ marginRight: '8px' }}/>
              I am the Room Admin
            </label>
          </div>
          <button className="btn-primary" onClick={handleJoinRoom}>Join Room</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <h2>Room: {roomId} <span style={{fontSize: '0.8rem', color: '#8b949e'}}>{isAdmin ? '(Admin)' : '(Member)'}</span></h2>

      {isAdmin && (
        <div className="glass-card" style={{ marginBottom: '20px' }}>
          <h3>Admin Controls</h3>
          <input type="file" accept="video/*" onChange={(e) => setVideoFile(e.target.files[0])} style={{ marginBottom: '15px', color: '#c9d1d9' }} />
          <br/>
          <button className="btn-primary" onClick={handleUpload}>Upload to Cloud</button>
        </div>
      )}

      {videoUrl ? (
        <div className="video-container">
          <video className="main-video" ref={videoRef} src={videoUrl} controls={isAdmin} onPlay={handlePlay} onPause={handlePause} onSeeked={handleSeek} />
        </div>
      ) : (
        <div className="glass-card" style={{ padding: '40px', margin: '20px 0' }}>
          <p>Waiting for the admin to upload a video...</p>
        </div>
      )}

      <div className="dashboard">
        
        {/* Chat Panel */}
        <div className="panel">
          <h3>Live Chat</h3>
          <div className="chat-box">
            {messages.map((msg, idx) => (
              <div key={idx} className="chat-message">
                <span className="chat-sender">{msg.sender}:</span> {msg.text}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input type="text" className="input-field" style={{ margin: 0 }} value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." />
            <button className="btn-primary" onClick={sendMessage}>Send</button>
          </div>
        </div>

        {/* My Camera Panel */}
        <div className="panel">
          <h3>My Camera</h3>
          <video className="cam-video" ref={myVideoRef} autoPlay muted />
        </div>

        {/* Partner Camera Panel */}
        <div className="panel">
          <h3>Partner Camera</h3>
          <video className="cam-video partner" ref={partnerVideoRef} autoPlay />
        </div>
        
      </div>
    </div>
  );
}

export default App;