import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css'; 

// Connected to your correct live Railway server!
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
  
  // WebRTC States & Refs
  const myVideoRef = useRef(null);
  const partnerVideoRef = useRef(null);
  const [myStream, setMyStream] = useState(null);
  const peerConnectionRef = useRef(null);

  // 1. Get Webcam & Initialize WebRTC
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

  // 2. Handle Socket & WebRTC Events
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

      pc.ontrack = (event) => {
        if (partnerVideoRef.current) partnerVideoRef.current.srcObject = event.streams[0];
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) socket.emit('webrtc-ice-candidate', roomId, event.candidate);
      };
      
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
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on('webrtc-ice-candidate', async (candidate) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    return () => {
      socket.off('sync-video-url'); socket.off('sync-play'); socket.off('sync-pause');
      socket.off('sync-seek'); socket.off('receive-message'); socket.off('user-ready-for-video');
      socket.off('webrtc-offer'); socket.off('webrtc-answer'); socket.off('webrtc-ice-candidate');
    };
  }, [inRoom, myStream, roomId]);

  // UI Handlers
  const handleJoinRoom = () => { const clean = roomId.trim(); if (clean !== '') { setRoomId(clean); socket.emit('join-room', clean); setInRoom(true); }};
  
  const handleUpload = async () => {
    if (!videoFile) return;
    const formData = new FormData(); formData.append('video', videoFile);
    
    // Upload points to Railway
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
      <div style={{ textAlign: 'center', marginTop: '50px' }}>
        <h2>🎬 Welcome to the Watch Party</h2>
        <input type="text" placeholder="Enter Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
        <div style={{ marginTop: '10px' }}><label><input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin</label></div>
        <button onClick={handleJoinRoom} style={{ marginTop: '15px', padding: '8px 16px' }}>Join</button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '20px' }}>
      <h2>Room: {roomId} {isAdmin ? '(Admin)' : '(Member)'}</h2>

      {isAdmin && (
        <div style={{ margin: '20px', padding: '20px', border: '1px solid #ccc', borderRadius: '8px' }}>
          <input type="file" accept="video/*" onChange={(e) => setVideoFile(e.target.files[0])} />
          <button onClick={handleUpload}>Upload Video</button>
        </div>
      )}

      {videoUrl && (
        <video ref={videoRef} src={videoUrl} controls={isAdmin} onPlay={handlePlay} onPause={handlePause} onSeeked={handleSeek} width="80%" style={{ border: '2px solid black', marginTop: '20px', borderRadius: '8px' }} />
      )}

      <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginTop: '30px' }}>
        
        {/* Chatbox */}
        <div style={{ width: '30%', border: '2px solid #ccc', padding: '15px', borderRadius: '8px' }}>
          <h3>Chat</h3>
          <div style={{ height: '150px', overflowY: 'auto', border: '1px solid #eee', marginBottom: '15px', padding: '10px', textAlign: 'left', backgroundColor: '#f9f9f9', color: '#333' }}>
            {messages.map((msg, idx) => <p key={idx} style={{ margin: '5px 0' }}><strong>{msg.sender}: </strong> {msg.text}</p>)}
          </div>
          <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} style={{ width: '60%', padding: '8px', border: '1px solid #ccc' }} />
          <button onClick={sendMessage} style={{ padding: '8px 15px', marginLeft: '10px' }}>Send</button>
        </div>

        {/* My Camera */}
        <div style={{ width: '30%', border: '2px solid #ccc', padding: '15px', borderRadius: '8px' }}>
          <h3>Me</h3>
          <video ref={myVideoRef} autoPlay muted style={{ width: '100%', borderRadius: '8px', backgroundColor: '#222' }} />
        </div>

        {/* Partner Camera */}
        <div style={{ width: '30%', border: '2px solid #ccc', padding: '15px', borderRadius: '8px', borderColor: '#4CAF50' }}>
          <h3>Partner</h3>
          <video ref={partnerVideoRef} autoPlay style={{ width: '100%', borderRadius: '8px', backgroundColor: '#222' }} />
        </div>
        
      </div>
    </div>
  );
}

export default App;