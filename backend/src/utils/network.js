const os = require('os');

/**
 * Classifies a network interface name into its general category.
 * @param {string} name - The network interface name (e.g. wlan0, eth0)
 * @returns {string} One of: 'Wi-Fi', 'Ethernet', 'Virtual/VPN', 'Loopback', 'Other'
 */
function getInterfaceType(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('wl') || lower.includes('wifi') || lower.includes('wlan')) {
    return 'Wi-Fi';
  }
  if (lower.startsWith('en') || lower.startsWith('eth') || lower.startsWith('em') || lower.startsWith('eno')) {
    return 'Ethernet';
  }
  if (lower.startsWith('lo')) {
    return 'Loopback';
  }
  if (
    lower.startsWith('docker') ||
    lower.startsWith('veth') ||
    lower.startsWith('br-') ||
    lower.startsWith('virbr') ||
    lower.startsWith('vmnet') ||
    lower.startsWith('vboxnet') ||
    lower.startsWith('tun') ||
    lower.startsWith('tap') ||
    lower.startsWith('wg') ||
    lower.includes('tailscale') ||
    lower.includes('zerotier')
  ) {
    return 'Virtual/VPN';
  }
  return 'Other';
}

/**
 * Scans network interfaces and returns all non-internal IPv4 addresses sorted by type.
 * Useful for showing the user what IP addresses to type on their phone/tablet
 * to connect to this server on the local network.
 * @returns {Array<{interface: string, address: string, type: string}>}
 */
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const interfaceName in interfaces) {
    const interfaceList = interfaces[interfaceName];
    if (!interfaceList) continue;

    for (const details of interfaceList) {
      // Support node's family naming ('IPv4' or 4 depending on version)
      const isIPv4 = details.family === 'IPv4' || details.family === 4;
      if (isIPv4 && !details.internal) {
        const type = getInterfaceType(interfaceName);
        addresses.push({
          interface: interfaceName,
          address: details.address,
          type: type
        });
      }
    }
  }

  // Sort interfaces: Wi-Fi first, then Ethernet, then Other, then Virtual/VPN
  const typeOrder = { 'Wi-Fi': 1, 'Ethernet': 2, 'Other': 3, 'Virtual/VPN': 4 };
  addresses.sort((a, b) => {
    const orderA = typeOrder[a.type] || 5;
    const orderB = typeOrder[b.type] || 5;
    return orderA - orderB;
  });

  return addresses;
}

/**
  * Checks if the request IP matches local loopback or server network interfaces.
  */
function isLocalAddress(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  
  const localIps = getLocalIpAddresses().map(item => item.address);
  const cleanIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  return localIps.includes(cleanIp);
}

module.exports = { getLocalIpAddresses, isLocalAddress };

