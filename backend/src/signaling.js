const ws = require('ws');
const { loadSettings } = require('./settings');
const { getLocalIpAddresses, isLocalAddress } = require('./utils/network');

// Active peer connections registry: clientId -> client state metadata
const clients = new Map();

function generateNewOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Active 6-digit OTP code generated on boot
let activeOTP = generateNewOTP();
console.log(`==================================================`);
console.log(`🔑 SECURITY PROTOCOL: Host Authorization OTP is: ${activeOTP}`);
console.log(`==================================================`);

/**
 * Regenerates the dynamic OTP and broadcasts it to all connected host devices.
 * @returns {string} The new generated OTP code
 */
function refreshOTP() {
  activeOTP = generateNewOTP();
  console.log(`==================================================`);
  console.log(`🔑 SECURITY PROTOCOL: Host Authorization OTP Refreshed: ${activeOTP}`);
  console.log(`==================================================`);

  // Notify any connected hosts of the new OTP code
  clients.forEach((c) => {
    if (c.isHost && c.socket.readyState === ws.OPEN) {
      try {
        c.socket.send(JSON.stringify({
          type: 'otp-updated',
          otp: activeOTP
        }));
      } catch (err) {
        console.error(`Failed to send OTP update to client ${c.id}:`, err);
      }
    }
  });

  return activeOTP;
}

/**
 * Initializes the WebSocket signaling server over the existing HTTP server.
 * This shares the port and parses HTTP upgrades automatically.
 * @param {import('http').Server} server - Express-wrapped Node HTTP server
 */
function initSignaling(server) {
  const wss = new ws.Server({ noServer: true });

  // Set up auto-refresh interval for OTP every 5 minutes (5 * 60 * 1000 ms)
  const otpInterval = setInterval(() => {
    refreshOTP();
  }, 5 * 60 * 1000);

  // Handle standard HTTP Upgrade requests manually
  server.on('upgrade', (request, socket, head) => {
    const settings = loadSettings();
    if (!settings.allowWebRTC) {
      socket.destroy();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (wsClient) => {
        wss.emit('connection', wsClient, request);
      });
    }
  });

  wss.on('connection', (socket, request) => {
    let currentClientId = null;
    socket.isAlive = true;

    // Local host auto-authorization check
    const remoteIp = request ? (request.headers['x-test-ip'] || request.socket.remoteAddress) : null;
    socket.isHost = isLocalAddress(remoteIp);
    socket.authorized = socket.isHost;

    // Heartbeat pong listener
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (messageRaw) => {
      try {
        const msg = JSON.parse(messageRaw.toString());

        switch (msg.type) {
          case 'join': {
            const { clientId, username, avatar, deviceInfo, otp } = msg;
            if (!clientId) {
              socket.send(JSON.stringify({ type: 'error', message: 'Missing clientId parameter' }));
              return;
            }

            // Check security OTP authentication
            if (!socket.authorized) {
              if (otp === activeOTP) {
                socket.authorized = true;
                socket.send(JSON.stringify({ type: 'auth-success' }));
              } else {
                socket.send(JSON.stringify({
                  type: otp ? 'auth-failed' : 'auth-required',
                  message: otp ? 'Incorrect OTP code. Please try again.' : 'Authorization required.'
                }));
                return;
              }
            }

            // Remove previous socket if same client re-connects
            if (clients.has(clientId)) {
              const oldSocket = clients.get(clientId).socket;
              try {
                oldSocket.close();
              } catch (e) {
                // ignore
              }
              clients.delete(clientId);
            }

            currentClientId = clientId;
            socket.clientId = clientId;

            const clientData = {
              id: clientId,
              username: username || 'Guest User',
              avatar: avatar || 'monitor',
              deviceInfo: deviceInfo || {},
              socket,
              isHost: socket.isHost,
              isTrusted: socket.authorized
            };

            // Gather metadata of all other online clients to send to the newcomer
            const otherClients = [];
            clients.forEach((c, id) => {
              otherClients.push({
                id: c.id,
                username: c.username,
                avatar: c.avatar,
                deviceInfo: c.deviceInfo
              });
            });

            socket.send(JSON.stringify({
              type: 'welcome',
              isHost: socket.isHost,
              activeOTP: socket.isHost ? activeOTP : null,
              clients: otherClients
            }));

            // Register the new client in our map
            clients.set(clientId, clientData);

            // Notify everyone else that a new peer has connected
            broadcast({
              type: 'user-joined',
              client: {
                id: clientData.id,
                username: clientData.username,
                avatar: clientData.avatar,
                deviceInfo: clientData.deviceInfo
              }
            }, clientId);

            break;
          }

          case 'signal': {
            const { targetId, data } = msg;
            if (!currentClientId || !socket.authorized) {
              socket.send(JSON.stringify({ type: 'error', message: 'Please register and authorize first' }));
              return;
            }

            if (!targetId || !data) {
              socket.send(JSON.stringify({ type: 'error', message: 'Missing signal targetId or body content' }));
              return;
            }

            const targetClient = clients.get(targetId);
            if (targetClient) {
              // Direct signal forward to target client
              targetClient.socket.send(JSON.stringify({
                type: 'signal',
                senderId: currentClientId,
                data
              }));
            } else {
              socket.send(JSON.stringify({
                type: 'error',
                message: `Target client ${targetId} is offline`
              }));
            }
            break;
          }

          case 'webrtc-offer':
          case 'webrtc-answer':
          case 'webrtc-candidate': {
            const { targetId, sdp, candidate } = msg;
            if (!currentClientId || !socket.authorized) {
              socket.send(JSON.stringify({ type: 'error', message: 'Please register and authorize first' }));
              return;
            }

            if (!targetId) {
              socket.send(JSON.stringify({ type: 'error', message: 'Missing WebRTC signal targetId' }));
              return;
            }

            if ((msg.type === 'webrtc-offer' || msg.type === 'webrtc-answer') && !sdp) {
              socket.send(JSON.stringify({ type: 'error', message: 'Missing WebRTC SDP payload' }));
              return;
            }

            if (msg.type === 'webrtc-candidate' && !candidate) {
              socket.send(JSON.stringify({ type: 'error', message: 'Missing WebRTC ICE candidate payload' }));
              return;
            }

            const targetClient = clients.get(targetId);
            if (targetClient && targetClient.socket.readyState === ws.OPEN) {
              targetClient.socket.send(JSON.stringify({
                type: msg.type,
                from: currentClientId,
                senderId: currentClientId,
                ...(sdp ? { sdp } : {}),
                ...(candidate ? { candidate } : {})
              }));
            } else {
              socket.send(JSON.stringify({
                type: 'error',
                message: `Target client ${targetId} is offline`
              }));
            }
            break;
          }

          case 'refresh-otp': {
            if (!socket.isHost) {
              socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Only the host machine can refresh the OTP' }));
              return;
            }
            refreshOTP();
            break;
          }

          default:
            socket.send(JSON.stringify({ type: 'error', message: `Unknown socket action: ${msg.type}` }));
        }

      } catch (err) {
        console.error('Error handling WebSocket message:', err);
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid payload structure' }));
      }
    });

    socket.on('close', () => {
      handleDisconnect(currentClientId);
    });

    socket.on('error', (err) => {
      console.error(`Socket error details [client ${currentClientId}]:`, err);
      handleDisconnect(currentClientId);
    });
  });

  // Heartbeat loop: ping clients every 30 seconds to clean up dead links
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) {
        handleDisconnect(socket.clientId);
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(otpInterval);
  });

  /**
   * Broadcast message to all registered clients except the specified client ID
   */
  function broadcast(data, excludeClientId = null) {
    const raw = JSON.stringify(data);
    clients.forEach((client, id) => {
      if (excludeClientId && id === excludeClientId) return;
      if (client.socket.readyState === ws.OPEN) {
        client.socket.send(raw);
      }
    });
  }

  /**
   * Handles user disconnection cleaning logic and broadcasts details
   */
  function handleDisconnect(clientId) {
    if (clientId && clients.has(clientId)) {
      clients.delete(clientId);
      broadcast({
        type: 'user-left',
        clientId
      });
    }
  }

  return wss;
}

module.exports = { initSignaling, clients, activeOTP, isLocalAddress, refreshOTP };
// Add TURN configuration
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'user',
      credential: 'pass'
    }
  ],
  iceTransportPolicy: 'all',
  bundlePolicy: 'balanced',
  rtcpMuxPolicy: 'require'
};