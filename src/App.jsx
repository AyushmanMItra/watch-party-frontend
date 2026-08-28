import { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import './App.css'; 

const BACKEND_URL = 'http://localhost:5000'; // Update to Railway URL for production
const socket = io(BACKEND_URL);

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
  const [isProcessing, setIsProcessing] = useState(false);

  // WebRTC & Media States
  const [myStream, setMyStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const peersRef = useRef({});
  const videoRef = useRef(null);
  const myVideoRef = useRef(null);
  
  // FFmpeg & MSE Refs
  const ffmpegRef = useRef(new FFmpeg());
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const queueRef = useRef([]);

  // 1. Connection & MSE Initialization
  useEffect(() => {
    const onConnect = () => { setIsConnected(true); if (inRoom && roomId) socket.emit('join-room', roomId); };
    const onDisconnect = () => setIsConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Initialize FFmpeg
    const loadFFmpeg = async () => {
      const ffmpeg = ffmpegRef.current;
      if (!ffmpeg.loaded) {
        await ffmpeg.load();
        console.log("FFmpeg core loaded");
      }
    };
    loadFFmpeg();

    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, [inRoom, roomId]);

  // Setup MediaSource when entering room
  useEffect(() => {
    if (inRoom && videoRef.current) {
      const ms = new MediaSource();
      mediaSourceRef.current = ms;
      videoRef.current.src = URL.createObjectURL(ms);

      ms.addEventListener('sourceopen', () => {
        // Prepare to receive fragmented MP4 (H.264 video, AAC audio)
        const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
        sourceBufferRef.current = sb;

        sb.addEventListener('updateend', () => {
          if (queueRef.current.length > 0 && !sb.updating) {
            sb.appendBuffer(queueRef.current.shift());
          }
        });
      });
    }
  }, [inRoom]);

  // 2. WebRTC Mesh for Cameras
  useEffect(() => {
    if (inRoom) {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then((stream) => {
          setMyStream(stream);
          if (myVideoRef.current) myVideoRef.current.srcObject = stream;
        }).catch(err => console.error(err));
    }
  }, [inRoom]);

  useEffect(() => {
    if (!inRoom || !myStream) return;
    const createPeer = (targetId) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      myStream.getTracks().forEach(track => pc.addTrack(track, myStream));
      pc.ontrack = (e) => setRemoteStreams(prev => ({ ...prev, [targetId]: e.streams[0] }));
      pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc-ice-candidate', { target: targetId, caller: socket.id, candidate: e.candidate }); };
      return pc;
    };

    socket.on('user-connected', async (newUserId) => {
      const pc = createPeer(newUserId);
      peersRef.current[newUserId] = pc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { target: newUserId, caller: socket.id, offer });
    });

    socket.on('webrtc-offer', async ({ caller, offer }) => {
      const pc = createPeer(caller);
      peersRef.current[caller] = pc;
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { target: caller, caller: socket.id, answer });
    });

    socket.on('webrtc-answer', async ({ caller, answer }) => { if (peersRef.current[caller]) await peersRef.current[caller].setRemoteDescription(new RTCSessionDescription(answer)); });
    socket.on('webrtc-ice-candidate', async ({ caller, candidate }) => { if (peersRef.current[caller]) await peersRef.current[caller].addIceCandidate(new RTCIceCandidate(candidate)); });
    socket.on('user-disconnected', (userId) => {
      if (peersRef.current[userId]) peersRef.current[userId].close();
      delete peersRef.current[userId];
      setRemoteStreams(prev => { const copy = { ...prev }; delete copy[userId]; return copy; });
    });

    return () => {
      socket.off('user-connected'); socket.off('webrtc-offer'); socket.off('webrtc-answer'); socket.off('webrtc-ice-candidate'); socket.off('user-disconnected');
    };
  }, [inRoom, myStream]);

  // 3. Receive Relayed Chunks & Sync Playback
  useEffect(() => {
    if (!inRoom) return;

    // Push incoming binary chunks into the MSE queue
    socket.on('video-chunk', (chunk) => {
      const sb = sourceBufferRef.current;
      if (sb && !sb.updating) {
        sb.appendBuffer(chunk);
      } else {
        queueRef.current.push(chunk);
      }
    });

    socket.on('sync-play', (time) => { if (videoRef.current) { videoRef.current.currentTime = time; videoRef.current.play(); }});
    socket.on('sync-pause', () => { if (videoRef.current) videoRef.current.pause(); });
    socket.on('sync-seek', (time) => { if (videoRef.current) videoRef.current.currentTime = time; });
    socket.on('receive-message', (data) => setMessages(prev => [...prev, data]));

    return () => { socket.off('video-chunk'); socket.off('sync-play'); socket.off('sync-pause'); socket.off('sync-seek'); socket.off('receive-message'); };
  }, [inRoom]);

  // 4. The FFmpeg Remuxer (Admin Only)
  const processAndStreamVideo = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsProcessing(true);

    const ffmpeg = ffmpegRef.current;
    
    // Write original MKV to FFmpeg memory
    await ffmpeg.writeFile('input.mkv', await fetchFile(file));

    // Run the fast-remux: Copy video codec, transcode audio to AAC, fragment MP4
    await ffmpeg.exec([
      '-i', 'input.mkv',
      '-c:v', 'copy', 
      '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'output.mp4'
    ]);

    // Read the processed output
    const data = await ffmpeg.readFile('output.mp4');
    
    // Play locally via MSE
    const sb = sourceBufferRef.current;
    if (sb && !sb.updating) {
      sb.appendBuffer(data.buffer);
    } else {
      queueRef.current.push(data.buffer);
    }

    // Blast the binary data to the backend relay for all peers
    socket.emit('video-chunk', roomId, data.buffer);
    setIsProcessing(false);
  };

  const handleCreateRoom = () => { const code = Math.random().toString(36).substring(2, 7).toUpperCase(); setRoomId(code); setIsAdmin(true); socket.emit('join-room', code); setInRoom(true); };
  const handleJoinRoom = () => { const clean = roomId.trim().toUpperCase(); if (clean !== '') { setRoomId(clean); setIsAdmin(false); socket.emit('join-room', clean); setInRoom(true); }};
  const handlePlay = () => { if (isAdmin && videoRef.current) socket.emit('play-video', roomId, videoRef.current.currentTime); };
  const handlePause = () => { if (isAdmin) socket.emit('pause-video', roomId); };
  const handleSeek = () => { if (isAdmin && videoRef.current) socket.emit('seek-video', roomId, videoRef.current.currentTime); };
  const sendMessage = () => { if (chatInput.trim() !== '') { socket.emit('send-message', roomId, { sender: isAdmin ? 'Admin' : 'Member', text: chatInput }); setChatInput(''); }};

  if (!inRoom) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div className="glass-card">
          <h2>🎬 MSE Stream Engine</h2>
          <div style={{ padding: '10px', margin: '10px 0', borderRadius: '5px', backgroundColor: isConnected ? 'rgba(35, 134, 54, 0.2)' : 'rgba(218, 54, 51, 0.2)', color: isConnected ? '#2ea043' : '#ff7b72' }}>
            {isConnected ? '🟢 Relay Connected' : '🔴 Server Offline'}
          </div>
          <button className="btn-primary" onClick={handleCreateRoom} style={{ width: '100%', marginBottom: '20px' }}>+ Create Room</button>
          <input type="text" className="input-field" placeholder="Enter Code" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ textAlign: 'center', textTransform: 'uppercase', marginBottom: '10px' }} />
          <button className="btn-secondary" onClick={handleJoinRoom} style={{ width: '100%' }}>Join Room</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', maxWidth: '1200px', marginBottom: '10px' }}>
        <h2>Room: <span style={{ color: '#58a6ff', letterSpacing: '2px' }}>{roomId}</span> <span style={{fontSize: '0.8rem', color: '#8b949e'}}>{isAdmin ? '(Admin)' : '(Member)'}</span></h2>
      </div>

      {isAdmin && (
        <div className="glass-card" style={{ marginBottom: '20px', maxWidth: '1200px', width: '100%', textAlign: 'left', padding: '15px' }}>
          <h3 style={{ marginTop: 0 }}>Stream MKV Source</h3>
          <p style={{ fontSize: '0.85rem', color: '#8b949e', marginTop: '-10px' }}>Select an MKV file. FFmpeg will instantly repackage it to fMP4 and relay it to the room.</p>
          <input type="file" accept="video/*,.mkv" onChange={processAndStreamVideo} disabled={isProcessing} style={{ color: '#c9d1d9' }} />
          {isProcessing && <span style={{ color: '#58a6ff', marginLeft: '15px' }}>⏳ Processing container remux...</span>}
        </div>
      )}

      <div className="video-container">
        <video className="main-video" ref={videoRef} controls={isAdmin} onPlay={handlePlay} onPause={handlePause} onSeeked={handleSeek} />
      </div>

      <div className="dynamic-grid">
        <div className="panel chat-panel">
          <h3>Live Chat</h3>
          <div className="chat-box">
            {messages.map((msg, idx) => (
              <div key={idx} className="chat-message"><span style={{ color: msg.sender === 'Admin' ? '#58a6ff' : '#3fb950' }}>{msg.sender}:</span> {msg.text}</div>
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
        {Object.entries(remoteStreams).map(([id, stream]) => <RemoteVideo key={id} id={id} stream={stream} />)}
      </div>
    </div>
  );
}

export default App;