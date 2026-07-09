const { spawn } = require('child_process');

let tunnelProcess = null;
let publicTunnelUrl = null;

/**
 * Starts a public HTTPS tunnel using localhost.run reverse SSH port forwarding.
 * Bypasses local firewall blockages and client-isolation rules on hotspots.
 * @param {number} port - Local binding port to forward (e.g. 5000)
 */
function startTunnel(port) {
  if (tunnelProcess) {
    stopTunnel();
  }

  console.log(`\n📡 Initializing Public Hotspot Tunnel on port ${port}...`);
  
  tunnelProcess = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-R', `80:localhost:${port}`,
    'nokey@localhost.run'
  ]);

  tunnelProcess.stdout.on('data', (data) => {
    const output = data.toString();
    const match = output.match(/https:\/\/[a-zA-Z0-9-.]+/);
    if (match) {
      publicTunnelUrl = match[0];
      console.log(`==================================================`);
      console.log(`🌐 PUBLIC TUNNEL ACTIVE (Hotspot Bypass):`);
      console.log(`   ${publicTunnelUrl}`);
      console.log(`==================================================`);
    }
  });

  tunnelProcess.on('close', (code) => {
    console.log(`📡 Public Hotspot Tunnel closed (code ${code}).`);
    publicTunnelUrl = null;
    tunnelProcess = null;
  });
  
  // Guard resource cleanup on application termination
  process.on('exit', () => {
    stopTunnel();
  });
}

/**
 * Kills the active SSH tunnel process cleanly.
 */
function stopTunnel() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
    } catch (e) {
      // ignore
    }
    tunnelProcess = null;
    publicTunnelUrl = null;
  }
}

/**
 * Retrieves the active tunnel URL.
 * @returns {string|null} The public URL if tunnel is active, otherwise null.
 */
function getPublicTunnelUrl() {
  return publicTunnelUrl;
}

module.exports = { startTunnel, stopTunnel, getPublicTunnelUrl };
