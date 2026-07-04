import React, { useState, useEffect, useRef } from 'react';
import './App.css';

export default function App() {
  const [isJoined, setIsJoined] = useState(false);
  const [roomName, setRoomName] = useState('');
  
  // Media states
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  
  // Connection status: 'Idle', 'Waiting for Peer', 'Connecting', 'Connected', 'Disconnected', 'Failed'
  const [connStatus, setConnStatus] = useState('Idle');

  // Refs to prevent stale-closure issues in async WebSocket / WebRTC callbacks
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const previewVideoRef = useRef(null);

  const ws = useRef(null);
  const pc = useRef(null);
  const localStreamRef = useRef(null);

  // Initialize camera preview on the lobby/join screen
  useEffect(() => {
    if (isJoined) return;

    async function getMediaPreview() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
        }
        setLocalStream(stream);
        localStreamRef.current = stream;
      } catch (err) {
        console.warn("Could not get media preview:", err);
      }
    }

    getMediaPreview();
  }, [isJoined]);

  // Set the local video ref source when localStream or isJoined changes
  useEffect(() => {
    if (isJoined && localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [isJoined, localStream]);

  // Set the remote video ref source when remoteStream changes
  useEffect(() => {
    if (isJoined && remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [isJoined, remoteStream]);

  // WebRTC Peer Connection builder
  const createPeerConnection = async (targetPeer) => {
    if (pc.current) return;

    console.log("Creating RTCPeerConnection for target peer:", targetPeer);
    pc.current = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    });

    // Handle ICE Connection State changes
    pc.current.oniceconnectionstatechange = () => {
      if (!pc.current) return;
      const state = pc.current.iceConnectionState;
      console.log('ICE Connection State changed:', state);
      if (state === 'connected' || state === 'completed') {
        setConnStatus('Connected');
      } else if (state === 'disconnected') {
        setConnStatus('Disconnected');
        closePeerConnection();
      } else if (state === 'failed') {
        setConnStatus('Failed');
        closePeerConnection();
      }
    };

    // Send local ICE candidates to the other peer via the WebSocket
    pc.current.onicecandidate = (event) => {
      if (event.candidate && ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({
          type: 'candidate',
          candidate: event.candidate
        }));
      }
    };

    // When remote track arrives, add it to the remoteStream state
    pc.current.ontrack = (event) => {
      console.log('Received remote track stream:', event.streams[0]);
      setRemoteStream(event.streams[0]);
    };

    // Attach local media tracks to the peer connection
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.current.addTrack(track, localStreamRef.current);
      });
    } else {
      console.warn("No local stream tracks available to add to PeerConnection");
    }
  };

  const closePeerConnection = () => {
    if (pc.current) {
      pc.current.close();
      pc.current = null;
    }
    setRemoteStream(null);
  };

  // Join Room and connect WebSocket
  const handleJoin = async (e) => {
    e.preventDefault();
    if (!roomName.trim()) {
      alert("Please enter a Room ID");
      return;
    }

    let stream = localStream;
    // If we failed to get a stream in the preview, try to get it now
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setLocalStream(stream);
        localStreamRef.current = stream;
      } catch (err) {
        alert("Camera/microphone permissions are required for video calling. Please check your browser permissions.");
        console.error("getUserMedia error:", err);
        return;
      }
    }

    setIsJoined(true);
    setConnStatus('Connecting');

    // Build signaling WebSocket URL
    // Standard Django runs on port 8000. Fallback to current hostname.
    const wsUrl = `ws://${window.location.host}/ws/call/${roomName.trim()}/`;
    console.log("Connecting to WebSocket:", wsUrl);
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      console.log('WebSocket connected successfully');
      setConnStatus('Waiting for Peer');
    };

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      console.log('Received WebSocket message:', data);

      if (data.type === 'peer_joined') {
        // A new peer has joined the room. We (the existing peer) will initiate the call.
        console.log("New peer joined. Initiating offer to:", data.sender);
        setConnStatus('Connecting');

        await createPeerConnection(data.sender);
        
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        
        ws.current.send(JSON.stringify({
          type: 'offer',
          sdp: offer
        }));
      } 
      
      else if (data.type === 'signal') {
        const { sender, message } = data;
        
        if (message.type === 'offer') {
          // Received an offer from the initiator. We set it as remote desc and answer.
          console.log("Received WebRTC SDP Offer from:", sender);
          setConnStatus('Connecting');
          
          await createPeerConnection(sender);
          await pc.current.setRemoteDescription(new RTCSessionDescription(message.sdp));
          
          const answer = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answer);
          
          ws.current.send(JSON.stringify({
            type: 'answer',
            sdp: answer
          }));
        } 
        
        else if (message.type === 'answer') {
          // Received SDP Answer to our offer.
          console.log("Received WebRTC SDP Answer from:", sender);
          if (pc.current) {
            await pc.current.setRemoteDescription(new RTCSessionDescription(message.sdp));
          }
        } 
        
        else if (message.type === 'candidate') {
          // Received remote ICE candidate. Add it to our connection.
          if (pc.current && message.candidate) {
            try {
              await pc.current.addIceCandidate(new RTCIceCandidate(message.candidate));
            } catch (err) {
              console.error('Error adding ICE candidate:', err);
            }
          }
        }
      } 
      
      else if (data.type === 'peer_left') {
        console.log("Peer left the room.");
        closePeerConnection();
        setConnStatus('Waiting for Peer');
      }
    };

    ws.current.onclose = (event) => {
      console.log('WebSocket closed:', event);
      setConnStatus('Disconnected');
    };

    ws.current.onerror = (err) => {
      console.error('WebSocket error:', err);
      setConnStatus('Connection Error');
    };
  };

  // Leave Call cleanly
  const handleLeave = () => {
    closePeerConnection();
    
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    setLocalStream(null);
    setIsJoined(false);
    setIsMuted(false);
    setIsVideoOff(false);
    setConnStatus('Idle');
  };

  // Audio Toggle
  const toggleMute = () => {
    const nextState = !isMuted;
    setIsMuted(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !nextState;
      });
    }
  };

  // Video Camera Toggle
  const toggleVideo = () => {
    const nextState = !isVideoOff;
    setIsVideoOff(nextState);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(track => {
        track.enabled = !nextState;
        console.log(
          track.enabled,
          track.readyState,
          track.muted
        );
        console.log(localVideoRef.current.srcObject);
      });
    }
  };

  // Get human readable state indicator class names
  const getStatusClass = () => {
    switch (connStatus) {
      case 'Connected': return 'connected';
      case 'Connecting': return 'connecting';
      case 'Waiting for Peer': return 'waiting';
      default: return 'disconnected';
    }
  };

  return (
    <div className="app-container">
      {!isJoined ? (
        /* --- JOIN LOBBY SCREEN --- */
        <div className="join-container">
          <div className="join-card">
            <div className="join-header">
              <h1>Studio Call</h1>
              <p>Enter a Room ID to start a video meeting</p>
            </div>

            {/* Video Camera Preview */}
            <div className="preview-box">
              {localStream && !isVideoOff ? (
                <video 
                  ref={previewVideoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="preview-video"
                />
              ) : (
                <div className="preview-placeholder">
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>Camera Preview Offline</span>
                </div>
              )}
            </div>

            {/* Join Form */}
            <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="form-group">
                <label htmlFor="room-id">Room ID</label>
                <input
                  id="room-id"
                  type="text"
                  placeholder="e.g. cozy-lounge"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="form-input"
                  required
                />
              </div>

              <button type="submit" className="join-button">
                <span>Join Room</span>
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ width: '18px', height: '18px' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      ) : (
        /* --- ACTIVE VIDEO CALL SCREEN --- */
        <div className="call-container">
          
          {/* Top Info Bar */}
          <div className="top-info-bar">
            <div className="room-badge">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>Room: {roomName}</span>
            </div>
            
            <div className="status-badge">
              <span className={`status-indicator ${getStatusClass()}`}></span>
              <span>{connStatus}</span>
            </div>
          </div>

          {/* Main Content Area (Remote Video background) */}
          <div className="remote-video-container">
            {remoteStream ? (
              <video 
                ref={remoteVideoRef} 
                autoPlay 
                playsInline 
                muted
                className="remote-video"
              />
            ) : (
              <div className="remote-fallback">
                <div className="remote-avatar">
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <h2>Waiting for others...</h2>
                <p>Share the Room ID <strong>"{roomName}"</strong> with another peer to begin the video call.</p>
              </div>
            )}
          </div>

          {/* Floating Local PIP video */}
          <div className="local-video-container">
            {localStream && !isVideoOff ? (
              <video 
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted 
                className="local-video"
              />
            ) : (
              <div className="local-video-fallback">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
            )}
          </div>

          {/* Bottom Floating Control Bar */}
          <div className="controls-bar">
            {/* Mute Mic Button */}
            <button 
              onClick={toggleMute} 
              className={`control-btn ${isMuted ? 'active-off' : ''}`}
              title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
            >
              {isMuted ? (
                /* Mic Off Icon */
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636M12 9v2m0 4h.01" />
                </svg>
              ) : (
                /* Mic On Icon */
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>

            {/* Toggle Camera Button */}
            <button 
              onClick={toggleVideo} 
              className={`control-btn ${isVideoOff ? 'active-off' : ''}`}
              title={isVideoOff ? "Turn Camera On" : "Turn Camera Off"}
            >
              {isVideoOff ? (
                /* Camera Off Icon */
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              ) : (
                /* Camera On Icon */
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>

            {/* End Call Button */}
            <button 
              onClick={handleLeave} 
              className="control-btn end-call"
              title="Leave Room"
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2 2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5z" />
              </svg>
            </button>
          </div>

        </div>
      )}
    </div>
  );
}