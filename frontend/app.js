// Safe fallback UUID generator for non-secure contexts (like HTTP LAN connections)
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122 version 4 compliant fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Safe localStorage wrapper to prevent SecurityErrors in strict browsers
const safeLocalStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      // ignore
    }
  }
};

// --------------------------------------------------------------------------
// 1. Application Global State
// --------------------------------------------------------------------------
const state = {
  activeWindows: {
    files: false,
    transfers: false,
    radar: true,
    settings: false,
    share: false,
    help: false
  },
  maximizedWindows: {
    files: false,
    transfers: false,
    radar: false,
    settings: false,
    share: false,
    help: false
  },
  minimizedWindows: {
    files: false,
    transfers: false,
    radar: false,
    settings: false,
    share: false,
    help: false
  },
  focusedWindow: 'files',
  highestZIndex: 10,
  serverSettings: null,
  
  // User profile
  username: safeLocalStorage.getItem('aerosync_username') || 'Guest User',
  avatar: safeLocalStorage.getItem('aerosync_avatar') || 'monitor',
  theme: safeLocalStorage.getItem('aerosync_theme') || 'aero',
  
  // File Listings
  files: [],
  searchQuery: '',
  
  // Network and Peers
  ws: null,
  clientId: generateUUID(),
  peers: new Map(), // clientId -> peer data
  peerConnections: new Map(), // clientId -> RTCPeerConnection
  iceCandidateQueues: new Map(), // clientId -> Array of ICE candidates
  
  // Active File Transfer Queue
  transfers: new Map(), // transferId -> transfer tracking object
  
  // Pending WebRTC transfer invite
  pendingInvite: null
};

// --------------------------------------------------------------------------
// 2. Window Manager & UI Bootstrapper
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Clock update
  updateClock();
  setInterval(updateClock, 1000);
  
  // Load settings & files
  initUITheme();
  loadProfileInputs();
  fetchFiles();
  fetchServerSettings();
  
  // Set up dragging for windows
  initWindowDragging('window-files', 'title-files-drag');
  initWindowDragging('window-transfers', 'title-transfers-drag');
  initWindowDragging('window-radar', 'title-radar-drag');
  initWindowDragging('window-settings', 'title-settings-drag');
  initWindowDragging('window-share', 'title-share-drag');
  initWindowDragging('window-help', 'title-help-drag');
  
  // Attach shortcuts listeners
  setupShortcutButton('shortcut-files', 'files');
  setupShortcutButton('shortcut-transfers', 'transfers');
  setupShortcutButton('shortcut-radar', 'radar');
  setupShortcutButton('shortcut-settings', 'settings');
  setupShortcutButton('shortcut-help', 'help');
  
  // Window button action bindings
  setupWindowActionButtons('files');
  setupWindowActionButtons('transfers');
  setupWindowActionButtons('radar');
  setupWindowActionButtons('settings');
  setupWindowActionButtons('share');
  setupWindowActionButtons('help');
  
  // Profile save binding
  document.getElementById('btn-save-profile').addEventListener('click', saveProfileLocal);
  document.getElementById('btn-save-server-config').addEventListener('click', saveServerConfig);
  document.getElementById('btn-refresh-files').addEventListener('click', fetchFiles);
  document.getElementById('btn-clear-transfers').addEventListener('click', clearInactiveTransfers);
  
  // Dynamic OTP refresh binding
  const btnRefreshOtp = document.getElementById('btn-refresh-otp');
  if (btnRefreshOtp) {
    btnRefreshOtp.addEventListener('click', () => {
      if (state.isHost && state.ws && state.ws.readyState === WebSocket.OPEN) {
        // Animate the button icon
        const icon = btnRefreshOtp.querySelector('i');
        if (icon) {
          icon.classList.add('bi-spin-animate');
          setTimeout(() => icon.classList.remove('bi-spin-animate'), 600);
        }
        state.ws.send(JSON.stringify({ type: 'refresh-otp' }));
      } else {
        showToast('Cannot refresh OTP: WebSocket connection not ready.', 'error');
      }
    });
  }
  
  // Search bar input binding
  document.getElementById('input-file-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    renderFileList();
  });
  
  // Setup file input picker
  const fileInput = document.getElementById('input-file-uploader');
  fileInput.addEventListener('change', (e) => {
    handleFileUploads(e.target.files);
    fileInput.value = ''; // Reset
  });
  
  // Setup Drag and Drop overlays
  setupDragAndDrop();
  
  // OTP Device Authorization Form Submit
  const submitAuthBtn = document.getElementById('btn-submit-auth');
  if (submitAuthBtn) {
    submitAuthBtn.addEventListener('click', () => {
      const usernameInput = document.getElementById('auth-username');
      const otpInput = document.getElementById('auth-otp');
      const name = usernameInput.value.trim();
      const otp = otpInput.value.trim();
      
      if (!name) {
        const errorEl = document.getElementById('auth-error-msg');
        errorEl.innerText = 'Please enter a device nickname.';
        errorEl.style.display = 'block';
        return;
      }
      if (otp.length !== 6 || isNaN(otp)) {
        const errorEl = document.getElementById('auth-error-msg');
        errorEl.innerText = 'OTP must be a 6-digit numeric code.';
        errorEl.style.display = 'block';
        return;
      }
      
      state.username = name;
      safeLocalStorage.setItem('aerosync_username', name);
      const nameInput = document.getElementById('input-username');
      if (nameInput) nameInput.value = name;
      
      sendJoinMessage(otp);
    });
  }

  // Start WebSockets
  initWebSocket();
  
  // Initialize profile avatars select grid
  initAvatarSelector();

  // Dynamic taskbar tab bindings (removes global onclick)
  document.querySelectorAll('.taskbar-tabs-scroller .taskbar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      toggleWindow(tab.dataset.window);
    });
  });

  // Dynamic settings panel tab bindings
  document.querySelectorAll('.settings-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSettingsTab(btn.dataset.tab);
    });
  });

  // Dynamic settings theme switcher bindings
  document.querySelectorAll('.theme-grid .theme-card').forEach(card => {
    card.addEventListener('click', () => {
      changeTheme(card.dataset.theme);
    });
  });

  // Load and show initial window states
  syncWindowStates();
  
  // Start Menu & Connection Share Hub bindings
  initStartMenuAndShareHub();
});

// Update bottom system tray clock
function updateClock() {
  const clockEl = document.getElementById('system-clock');
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // The hour '0' should be '12'
  clockEl.innerText = `${hours}:${minutes} ${ampm}`;
}

// Bind clicks on desktop shortcuts to open windows
function setupShortcutButton(shortcutId, windowId) {
  document.getElementById(shortcutId).addEventListener('click', () => {
    openWindow(windowId);
  });
}

// Bind minimize, maximize, and close window clicks
function setupWindowActionButtons(windowId) {
  document.getElementById(`btn-minimize-${windowId}`).addEventListener('click', (e) => {
    e.stopPropagation();
    minimizeWindow(windowId);
  });
  
  document.getElementById(`btn-maximize-${windowId}`).addEventListener('click', (e) => {
    e.stopPropagation();
    maximizeWindow(windowId);
  });
  
  document.getElementById(`btn-close-${windowId}`).addEventListener('click', (e) => {
    e.stopPropagation();
    closeWindow(windowId);
  });
  
  // Focusing on click anywhere inside window
  document.getElementById(`window-${windowId}`).addEventListener('mousedown', () => {
    focusWindow(windowId);
  });
}

// --------------------------------------------------------------------------
// 3. Floating Window Dragging Logic (Smooth 60fps)
// --------------------------------------------------------------------------
function initWindowDragging(windowId, dragHandleId) {
  const win = document.getElementById(windowId);
  const handle = document.getElementById(dragHandleId);
  
  let posX = 0, posY = 0, mouseX = 0, mouseY = 0;
  
  handle.onmousedown = dragMouseDown;
  handle.ontouchstart = dragTouchStart;
  
  function dragMouseDown(e) {
    if (e.target.closest('.title-bar-actions')) return; // Ignore drag if clicking action buttons
    if (state.maximizedWindows[windowId]) return; // Disable drag if maximized
    
    e = e || window.event;
    e.preventDefault();
    
    focusWindow(windowId);
    
    // Get mouse position at startup
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    win.classList.add('dragging');
    
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }
  
  function dragTouchStart(e) {
    if (e.target.closest('.title-bar-actions')) return; // Ignore drag if clicking action buttons
    if (state.maximizedWindows[windowId]) return;
    focusWindow(windowId);
    
    const touch = e.touches[0];
    mouseX = touch.clientX;
    mouseY = touch.clientY;
    win.classList.add('dragging');
    
    document.addEventListener('touchend', closeTouchDrag, { passive: false });
    document.addEventListener('touchmove', touchElementDrag, { passive: false });
  }
  
  function touchElementDrag(e) {
    e.preventDefault(); // Stop mobile browser scrolling/bouncing during drag
    const touch = e.touches[0];
    posX = mouseX - touch.clientX;
    posY = mouseY - touch.clientY;
    mouseX = touch.clientX;
    mouseY = touch.clientY;
    
    let newTop = win.offsetTop - posY;
    let newLeft = win.offsetLeft - posX;
    
    const desktopHeight = document.getElementById('desktop-area').offsetHeight;
    const desktopWidth = document.getElementById('desktop-area').offsetWidth;
    
    if (newTop < 0) newTop = 0;
    if (newTop > desktopHeight - 48) newTop = desktopHeight - 48;
    if (newLeft < -win.offsetWidth + 100) newLeft = -win.offsetWidth + 100;
    if (newLeft > desktopWidth - 100) newLeft = desktopWidth - 100;
    
    win.style.top = `${newTop}px`;
    win.style.left = `${newLeft}px`;
  }
  
  function closeTouchDrag() {
    win.classList.remove('dragging');
    document.removeEventListener('touchend', closeTouchDrag);
    document.removeEventListener('touchmove', touchElementDrag);
  }
  
  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    
    // Calculate new cursor coordinates
    posX = mouseX - e.clientX;
    posY = mouseY - e.clientY;
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    // Set element's new position, capped inside window constraints
    let newTop = win.offsetTop - posY;
    let newLeft = win.offsetLeft - posX;
    
    const desktopHeight = document.getElementById('desktop-area').offsetHeight;
    const desktopWidth = document.getElementById('desktop-area').offsetWidth;
    
    // Capping bounds so titlebar stays visible
    if (newTop < 0) newTop = 0;
    if (newTop > desktopHeight - 48) newTop = desktopHeight - 48;
    if (newLeft < -win.offsetWidth + 100) newLeft = -win.offsetWidth + 100;
    if (newLeft > desktopWidth - 100) newLeft = desktopWidth - 100;
    
    win.style.top = `${newTop}px`;
    win.style.left = `${newLeft}px`;
  }
  
  function closeDragElement() {
    win.classList.remove('dragging');
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

// Focus a window and bring it to front
function focusWindow(windowId) {
  // On mobile (<= 768px), auto-minimize other windows to prevent overlapping chaos
  if (window.innerWidth <= 768) {
    Object.keys(state.activeWindows).forEach(key => {
      if (key !== windowId && state.activeWindows[key] && !state.minimizedWindows[key]) {
        state.minimizedWindows[key] = true;
        const otherWin = document.getElementById(`window-${key}`);
        if (otherWin) otherWin.classList.remove('open');
        const otherTab = document.getElementById(`tab-${key}`);
        if (otherTab) otherTab.classList.remove('active');
      }
    });
  }

  // Restore the target window if it was minimized
  state.minimizedWindows[windowId] = false;
  const win = document.getElementById(`window-${windowId}`);
  if (win) win.classList.add('open');
  
  state.highestZIndex += 1;
  if (win) win.style.zIndex = state.highestZIndex;
  
  // Remove focus class from all windows
  document.querySelectorAll('.sys-window').forEach(w => {
    w.classList.remove('focus-active');
  });
  if (win) win.classList.add('focus-active');
  state.focusedWindow = windowId;
  
  // Set taskbar tab active
  document.querySelectorAll('.taskbar-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById(`tab-${windowId}`);
  if (tab) tab.classList.add('active');
}

// Toggle window open state
function toggleWindow(windowId) {
  if (!state.activeWindows[windowId]) {
    openWindow(windowId);
  } else if (state.minimizedWindows[windowId]) {
    restoreWindow(windowId);
  } else if (state.focusedWindow === windowId) {
    minimizeWindow(windowId);
  } else {
    focusWindow(windowId);
  }
}

function openWindow(windowId) {
  state.activeWindows[windowId] = true;
  state.minimizedWindows[windowId] = false;
  
  const win = document.getElementById(`window-${windowId}`);
  win.classList.add('open');
  
  const tab = document.getElementById(`tab-${windowId}`);
  if (tab) tab.style.display = 'flex';
  
  focusWindow(windowId);
}

function closeWindow(windowId) {
  state.activeWindows[windowId] = false;
  const win = document.getElementById(`window-${windowId}`);
  win.classList.remove('open');
  
  const tab = document.getElementById(`tab-${windowId}`);
  if (tab) tab.style.display = 'none';
}

function minimizeWindow(windowId) {
  state.minimizedWindows[windowId] = true;
  const win = document.getElementById(`window-${windowId}`);
  win.classList.remove('open');
  
  const tab = document.getElementById(`tab-${windowId}`);
  if (tab) tab.classList.remove('active');
}

function restoreWindow(windowId) {
  state.minimizedWindows[windowId] = false;
  const win = document.getElementById(`window-${windowId}`);
  win.classList.add('open');
  focusWindow(windowId);
}

function maximizeWindow(windowId) {
  const win = document.getElementById(`window-${windowId}`);
  state.maximizedWindows[windowId] = !state.maximizedWindows[windowId];
  
  if (state.maximizedWindows[windowId]) {
    win.classList.add('maximized');
  } else {
    win.classList.remove('maximized');
  }
}

function syncWindowStates() {
  Object.keys(state.activeWindows).forEach(key => {
    if (state.activeWindows[key]) {
      openWindow(key);
    } else {
      closeWindow(key);
    }
  });
}

// Settings sub-category navigation toggles
function switchSettingsTab(tabId) {
  document.querySelectorAll('.settings-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.settings-content .settings-section').forEach(sec => sec.classList.remove('active'));
  
  document.getElementById(`tab-btn-${tabId}`).classList.add('active');
  document.getElementById(`settings-section-${tabId}`).classList.add('active');
}

// --------------------------------------------------------------------------
// 4. Custom Theme Switcher
// --------------------------------------------------------------------------
function initUITheme() {
  changeTheme(state.theme);
}

function changeTheme(themeName) {
  document.body.className = '';
  document.body.classList.add(`theme-${themeName}`);
  state.theme = themeName;
  safeLocalStorage.setItem('aerosync_theme', themeName);
  
  // Align setting selection previews
  document.querySelectorAll('.theme-grid .theme-card').forEach(card => card.classList.remove('active'));
  const activeCard = document.getElementById(`theme-card-${themeName}`);
  if (activeCard) activeCard.classList.add('active');
  
  showToast(`Theme loaded: ${themeName.charAt(0).toUpperCase() + themeName.slice(1)}`, 'info');
}

// Avatar grid click selector highlight
function initAvatarSelector() {
  const selectors = document.querySelectorAll('.avatar-selector');
  selectors.forEach(sel => {
    if (sel.dataset.avatar === state.avatar) {
      sel.classList.add('active');
    }
    sel.addEventListener('click', () => {
      selectors.forEach(s => s.classList.remove('active'));
      sel.classList.add('active');
      state.avatar = sel.dataset.avatar;
    });
  });
}

// --------------------------------------------------------------------------
// 5. REST Client Integrations
// --------------------------------------------------------------------------
async function fetchFiles() {
  const btn = document.getElementById('btn-refresh-files');
  let icon = null;
  if (btn) {
    icon = btn.querySelector('i');
    if (icon) icon.classList.add('bi-spin-animate');
    btn.disabled = true;
  }
  
  try {
    const res = await fetch('/api/transfer/files', {
      headers: { 'X-Client-Id': state.clientId }
    });
    if (!res.ok) throw new Error('Files load failed');
    state.files = await res.json();
    renderFileList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      if (icon) {
        // Keep spinning for at least 500ms for a satisfying visual feedback loop
        setTimeout(() => {
          icon.classList.remove('bi-spin-animate');
        }, 500);
      }
    }
  }
}

function renderFileList() {
  const tbody = document.getElementById('file-table-body');
  const countBadge = document.getElementById('sidebar-file-count');
  
  // Combine completed files and active uploading files from transfers
  const listToRender = [...state.files];
  
  state.transfers.forEach(tx => {
    if (tx.status === 'uploading' || tx.status === 'paused' || tx.status === 'assembling') {
      // Add virtual file entry for immediate feedback
      listToRender.push({
        fileId: `virtual-${tx.id}`,
        name: tx.name,
        size: tx.size,
        mimeType: 'uploading',
        uploadedAt: Date.now(),
        isVirtual: true,
        progress: tx.progress,
        status: tx.status
      });
    }
  });
  
  const filtered = listToRender.filter(f => f.name.toLowerCase().includes(state.searchQuery));
  countBadge.innerText = state.files.length;
  
  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-table-row">
        <td colspan="4" class="text-center text-muted py-5">
          <i class="bi bi-folder-x display-4 d-block mb-3"></i>
          No matching files found on this shared node.
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = filtered.map(file => {
    const formattedSize = formatBytes(file.size);
    const dateFormatted = file.isVirtual ? 'In progress...' : new Date(file.uploadedAt).toLocaleString();
    
    let actionHtml = '';
    if (file.isVirtual) {
      actionHtml = `
        <span id="file-badge-${file.fileId}" class="badge bg-primary-gradient px-2 py-1" style="font-size: 10px; background: var(--btn-primary-bg); color: white; border-radius: 4px;">
          ${file.status === 'assembling' ? 'Assembling...' : `${file.progress.toFixed(0)}%`}
        </span>
      `;
    } else {
      actionHtml = `
        <div class="d-flex justify-content-center gap-2">
          <a href="/api/transfer/download/${file.fileId}?clientId=${state.clientId}" class="btn btn-secondary btn-sm p-1" title="Download File" download>
            <i class="bi bi-download"></i>
          </a>
          <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="deleteFileFromServer('${file.fileId}')" title="Delete File">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      `;
    }
    
    return `
      <tr class="${file.isVirtual ? 'uploading-row-flash' : ''}">
        <td>
          <i class="bi ${file.isVirtual ? 'bi-cloud-arrow-up animate-pulse' : 'bi-file-earmark-code'} me-2 text-accent"></i>
          <strong>${escapeHtml(file.name)}</strong>
        </td>
        <td>${formattedSize}</td>
        <td>${dateFormatted}</td>
        <td class="text-center">${actionHtml}</td>
      </tr>
    `;
  }).join('');
}

async function deleteFileFromServer(fileId) {
  if (!confirm('Are you sure you want to delete this file from the server?')) return;
  try {
    const res = await fetch(`/api/transfer/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'X-Client-Id': state.clientId }
    });
    if (!res.ok) throw new Error('Delete file failed');
    showToast('File deleted successfully', 'success');
    fetchFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function fetchServerSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Settings load failed');
    const settings = await res.json();
    
    // Save to state
    state.serverSettings = settings;
    
    // Bind network panel
    const ipContainer = document.getElementById('network-addresses-container');
    document.getElementById('drive-node-ip').innerText = settings.networkAddresses[0]?.address || 'localhost';
    
    let addressesHtml = '';
    if (settings.networkAddresses.length === 0) {
      addressesHtml = `<div class="text-muted small">No local interface IPs found.</div>`;
    } else {
      addressesHtml = settings.networkAddresses.map(ip => `
        <div class="ip-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <span>${ip.interface} (${ip.type || 'LAN'}):</span>
          <div style="display: flex; align-items: center; gap: 6px;">
            <strong style="font-family: monospace;">http://${ip.address}:${settings.port}</strong>
            <button class="btn btn-secondary btn-sm p-1" style="padding: 2px 6px; font-size: 10px; display: inline-flex;" title="Show QR Code" onclick="openShareHubWithUrl('http://${ip.address}:${settings.port}', '${ip.interface} IP')">
              <i class="bi bi-qr-code"></i>
            </button>
          </div>
        </div>
      `).join('');
    }

    if (settings.publicTunnelUrl) {
      addressesHtml += `
        <div class="ip-row" style="border-top: 1px dashed rgba(255,255,255,0.15); margin-top: 8px; padding-top: 8px; display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--accent); font-weight: 600;"><i class="bi bi-globe2 me-1"></i>Public Tunnel:</span>
          <div style="display: flex; align-items: center; gap: 6px;">
            <strong style="color: var(--accent); font-family: monospace;"><a href="${settings.publicTunnelUrl}" target="_blank" style="color: inherit; text-decoration: none;">${settings.publicTunnelUrl}</a></strong>
            <button class="btn btn-secondary btn-sm p-1" style="padding: 2px 6px; font-size: 10px; display: inline-flex; border-color: var(--accent);" title="Show QR Code" onclick="openShareHubWithUrl('${settings.publicTunnelUrl}', 'Public Tunnel')">
              <i class="bi bi-qr-code" style="color: var(--accent);"></i>
            </button>
          </div>
        </div>
      `;
      document.getElementById('drive-node-ip').innerText = settings.publicTunnelUrl;
    }
    
    ipContainer.innerHTML = addressesHtml;
    
    // Update start menu subtitle and device name
    const startMenuSubtitle = document.getElementById('start-menu-subtitle');
    const startMenuDevice = document.getElementById('start-menu-device-name');
    if (startMenuSubtitle) {
      startMenuSubtitle.innerText = settings.publicTunnelUrl ? 'Public Tunnel Active' : 'LAN Sharing Mode';
    }
    if (startMenuDevice) {
      startMenuDevice.innerText = settings.deviceName || state.username;
    }
    
    // Bind inputs
    document.getElementById('input-dir').value = settings.sharedDirectory;
    document.getElementById('input-port').value = settings.port;
    document.getElementById('input-download-limit').value = settings.downloadSpeedLimit;
    document.getElementById('input-upload-limit').value = settings.uploadSpeedLimit;
    document.getElementById('checkbox-webrtc').checked = settings.allowWebRTC;
    document.getElementById('checkbox-tunnel').checked = settings.enableTunnel;
  } catch (err) {
    console.error('Settings load err:', err);
  }
}

async function saveServerConfig() {
  const payload = {
    sharedDirectory: document.getElementById('input-dir').value,
    port: parseInt(document.getElementById('input-port').value, 10),
    downloadSpeedLimit: parseInt(document.getElementById('input-download-limit').value, 10),
    uploadSpeedLimit: parseInt(document.getElementById('input-upload-limit').value, 10),
    allowWebRTC: document.getElementById('checkbox-webrtc').checked,
    enableTunnel: document.getElementById('checkbox-tunnel').checked
  };
  
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) throw new Error('Failed to update config');
    showToast('Config saved! Reloading settings...', 'success');
    fetchServerSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function loadProfileInputs() {
  document.getElementById('input-username').value = state.username;
}

function saveProfileLocal() {
  const usernameVal = document.getElementById('input-username').value.trim();
  if (usernameVal) {
    state.username = usernameVal;
    safeLocalStorage.setItem('aerosync_username', usernameVal);
    safeLocalStorage.setItem('aerosync_avatar', state.avatar);
    
    // Send update over WS
    sendJoinMessage();
    
    showToast('Profile settings updated successfully!', 'success');
  }
}

// --------------------------------------------------------------------------
// 5.5. Host Pending Upload Approvals
// --------------------------------------------------------------------------
async function fetchPendingApprovals() {
  if (!state.isHost) return;
  try {
    const res = await fetch('/api/transfer/pending', {
      headers: { 'X-Client-Id': state.clientId }
    });
    if (!res.ok) throw new Error('Failed to load pending queue');
    const pendingList = await res.json();
    renderPendingApprovals(pendingList);
  } catch (err) {
    console.error(err);
  }
}

function renderPendingApprovals(list) {
  const container = document.getElementById('pending-approvals-list');
  if (!container) return;
  
  if (list.length === 0) {
    container.innerHTML = `<div class="text-muted small">No pending upload requests.</div>`;
    return;
  }
  
  container.innerHTML = list.map(item => `
    <div class="pending-item">
      <div class="pending-info">
        <strong class="pending-name" title="${item.name}">${item.name}</strong>
        <span class="pending-meta">${formatBytes(item.size)} - From: ${item.senderName}</span>
      </div>
      <div class="pending-actions">
        <button class="btn-approve" data-file-id="${item.fileId}">Accept</button>
        <button class="btn-reject" data-file-id="${item.fileId}">Reject</button>
      </div>
    </div>
  `).join('');
  
  // Bind click handlers dynamically
  container.querySelectorAll('.btn-approve').forEach(btn => {
    btn.addEventListener('click', () => {
      approvePendingUpload(btn.dataset.fileId);
    });
  });
  container.querySelectorAll('.btn-reject').forEach(btn => {
    btn.addEventListener('click', () => {
      rejectPendingUpload(btn.dataset.fileId);
    });
  });
}

async function approvePendingUpload(fileId) {
  try {
    const res = await fetch('/api/transfer/approve', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Client-Id': state.clientId
      },
      body: JSON.stringify({ fileId })
    });
    if (!res.ok) throw new Error('Approval request failed');
    showToast('File approved and shared successfully', 'success');
    fetchPendingApprovals();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function rejectPendingUpload(fileId) {
  try {
    const res = await fetch('/api/transfer/reject', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Client-Id': state.clientId
      },
      body: JSON.stringify({ fileId })
    });
    if (!res.ok) throw new Error('Rejection request failed');
    showToast('File upload request rejected and deleted', 'info');
    fetchPendingApprovals();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// 6. Resumable Chunked Upload Engine
// --------------------------------------------------------------------------
function setupDragAndDrop() {
  const zone = document.getElementById('desktop-area');
  const overlay = document.getElementById('drag-drop-zone');
  
  let counter = 0;
  
  // Prevent browser opening dropped files globally
  window.addEventListener('dragover', (e) => e.preventDefault(), false);
  window.addEventListener('drop', (e) => e.preventDefault(), false);
  
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    counter++;
    overlay.classList.add('drag-hover');
    openWindow('files'); // Ensure Explorer window is open to accept
  });
  
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    counter--;
    if (counter === 0) {
      overlay.classList.remove('drag-hover');
    }
  });
  
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    counter = 0;
    overlay.classList.remove('drag-hover');
    handleFileUploads(e.dataTransfer.files);
  });
}

function handleFileUploads(fileList) {
  if (fileList.length === 0) return;
  
  // Loop and start upload session for each file
  for (const file of fileList) {
    initiateChunkedUpload(file);
  }
  
  openWindow('transfers');
}

function getOptimalChunkSize(fileSize) {
  if (fileSize > 500 * 1024 * 1024) {
    return 50 * 1024 * 1024; // Cap at 50MB chunks for large files
  } else if (fileSize > 150 * 1024 * 1024) {
    return 32 * 1024 * 1024; // 32MB chunks
  } else if (fileSize > 50 * 1024 * 1024) {
    return 16 * 1024 * 1024; // 16MB chunks
  } else if (fileSize > 10 * 1024 * 1024) {
    return 8 * 1024 * 1024; // 8MB chunks
  } else if (fileSize > 2 * 1024 * 1024) {
    return 4 * 1024 * 1024; // 4MB chunks
  }
  return 2 * 1024 * 1024; // 2MB chunks
}

function getUploadConcurrency(fileSize) {
  if (fileSize > 5 * 1024 * 1024 * 1024) return 3;
  if (fileSize > 500 * 1024 * 1024) return 4;
  if (fileSize > 150 * 1024 * 1024) return 6;
  return 8;
}

async function initiateChunkedUpload(file) {
  const uploadId = 'up-' + generateUUID();
  const CHUNK_SIZE = getOptimalChunkSize(file.size);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  // Register in transfers map
  const transfer = {
    id: uploadId,
    name: file.name,
    size: file.size,
    type: 'Upload (Server)',
    progress: 0,
    speed: 0,
    eta: 'Calculating...',
    status: 'uploading', // uploading, paused, completed, failed
    paused: false,
    chunksSent: [],
    totalChunks,
    concurrency: getUploadConcurrency(file.size),
    file,
    chunkSize: CHUNK_SIZE,
    xhr: null,
    bytesLastLoaded: 0,
    timeLastCheck: Date.now()
  };
  
  state.transfers.set(uploadId, transfer);
  updateTransferCountBadge();
  renderTransferQueue();
  renderFileList(); // Update files manager immediately to show virtual item
  
  try {
    // 1. Initialize upload session on Server
    const initRes = await fetch('/api/transfer/upload/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': state.clientId
      },
      body: JSON.stringify({
        uploadId,
        name: file.name,
        size: file.size,
        totalChunks,
        mimeType: file.type || 'application/octet-stream',
        clientId: state.clientId,
        senderName: state.username
      })
    });
    
    if (!initRes.ok) throw new Error('Init upload session failed');
    const initData = await initRes.json();
    transfer.chunksSent = initData.completedChunks || [];
    
    // 2. Loop and transmit missing chunks
    uploadNextChunks(transfer);
  } catch (err) {
    transfer.status = 'failed';
    showToast(`Upload failed for ${file.name}: ${err.message}`, 'error');
    renderTransferQueue();
  }
}

async function uploadNextChunks(transfer) {
  if (transfer.paused || transfer.status !== 'uploading') return;
  
  if (!transfer.activeUploads) transfer.activeUploads = 0;
  if (!transfer.activeXHRs) transfer.activeXHRs = new Map();
  if (!transfer.activeXHRInstances) transfer.activeXHRInstances = new Map();
  
  const CONCURRENCY = transfer.concurrency || getUploadConcurrency(transfer.size);
  
  // Find all chunks currently being uploaded or already sent
  const busyChunks = new Set(transfer.chunksSent);
  transfer.activeXHRs.forEach((_, idx) => busyChunks.add(idx));
  
  // Find next unsent chunks to fill the concurrency slots
  const chunksToStart = [];
  for (let i = 0; i < transfer.totalChunks; i++) {
    if (!busyChunks.has(i)) {
      chunksToStart.push(i);
      busyChunks.add(i);
      if (chunksToStart.length + transfer.activeUploads >= CONCURRENCY) {
        break;
      }
    }
  }
  
  // If no active uploads and all chunks are completed, assemble!
  if (transfer.activeUploads === 0 && transfer.chunksSent.length === transfer.totalChunks) {
    assembleUploadedChunks(transfer);
    return;
  }
  
  // Start the new chunk uploads in parallel
  chunksToStart.forEach((chunkIndex) => {
    startChunkUpload(transfer, chunkIndex);
  });
}

function startChunkUpload(transfer, chunkIndex) {
  transfer.activeUploads++;
  transfer.activeXHRs.set(chunkIndex, 0);
  
  const startByte = chunkIndex * transfer.chunkSize;
  const endByte = Math.min(startByte + transfer.chunkSize, transfer.file.size);
  const chunkBlob = transfer.file.slice(startByte, endByte);
  
  const xhr = new XMLHttpRequest();
  transfer.activeXHRInstances.set(chunkIndex, xhr);
  
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && transfer.status === 'uploading') {
      transfer.activeXHRs.set(chunkIndex, e.loaded);
      
      const now = Date.now();
      const duration = (now - transfer.timeLastCheck) / 1000;
      
      if (duration >= 0.5) {
        // Calculate total uploaded bytes
        let totalUploadedBytes = transfer.chunksSent.length * transfer.chunkSize;
        transfer.activeXHRs.forEach((loaded) => {
          totalUploadedBytes += loaded;
        });
        
        const bytesSentDiff = totalUploadedBytes - transfer.bytesLastLoaded;
        const currentSpeedBytes = bytesSentDiff / duration;
        
        transfer.speed = currentSpeedBytes;
        transfer.timeLastCheck = now;
        transfer.bytesLastLoaded = totalUploadedBytes;
        
        const bytesRemaining = transfer.size - totalUploadedBytes;
        if (currentSpeedBytes > 0) {
          transfer.eta = formatETA(bytesRemaining / currentSpeedBytes);
        }
      }
      
      // Calculate absolute progress
      let totalUploadedBytes = transfer.chunksSent.length * transfer.chunkSize;
      transfer.activeXHRs.forEach((loaded) => {
        totalUploadedBytes += loaded;
      });
      const progressPercent = Math.min((totalUploadedBytes / transfer.size) * 100, 99.9);
      
      transfer.progress = progressPercent;
      updateTransferItemUI(transfer.id);
    }
  };
  
  xhr.onload = async () => {
    transfer.activeUploads--;
    transfer.activeXHRs.delete(chunkIndex);
    transfer.activeXHRInstances.delete(chunkIndex);
    
    if (xhr.status === 200 && transfer.status === 'uploading') {
      if (!transfer.chunksSent.includes(chunkIndex)) {
        transfer.chunksSent.push(chunkIndex);
      }
      // Re-trigger the loop to fill empty slots
      uploadNextChunks(transfer);
    } else if (transfer.status === 'uploading') {
      transfer.status = 'failed';
      showToast(`Upload failed on chunk ${chunkIndex}`, 'error');
      renderTransferQueue();
    }
  };
  
  xhr.onerror = () => {
    transfer.activeUploads--;
    transfer.activeXHRs.delete(chunkIndex);
    transfer.activeXHRInstances.delete(chunkIndex);
    
    if (transfer.status === 'uploading') {
      transfer.status = 'failed';
      showToast('Network error during upload', 'error');
      renderTransferQueue();
    }
  };
  
  xhr.open('POST', '/api/transfer/upload/chunk/raw');
  xhr.setRequestHeader('X-Client-Id', state.clientId);
  xhr.setRequestHeader('X-Upload-Id', transfer.id);
  xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.send(chunkBlob);
}

async function assembleUploadedChunks(transfer) {
  transfer.status = 'assembling';
  transfer.speed = 0;
  transfer.eta = 'Assembling file...';
  updateTransferItemUI(transfer.id);
  
  try {
    const res = await fetch('/api/transfer/upload/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': state.clientId
      },
      body: JSON.stringify({
        uploadId: transfer.id,
        clientId: state.clientId,
        senderName: state.username
      })
    });
    
    if (!res.ok) throw new Error('File assembly failed');
    const data = await res.json();
    
    transfer.status = 'completed';
    transfer.progress = 100;
    
    if (data.status === 'pending') {
      transfer.eta = 'Waiting approval';
      showToast(`File ${transfer.name} uploaded! Waiting for host approval.`, 'info');
    } else {
      transfer.eta = 'Done';
      showToast(`File ${transfer.name} uploaded successfully!`, 'success');
    }

    if (transfer.fallbackTargetId) {
      // Helper to encode string to hex
      const toHex = (str) => {
        let hex = '';
        for (let i = 0; i < str.length; i++) {
          hex += str.charCodeAt(i).toString(16);
        }
        return hex;
      };
      const hexFileId = toHex(transfer.name);
      
      console.log(`Sending P2P fallback ready signal to peer ${transfer.fallbackTargetId} for fileId: ${hexFileId}`);
      sendSignal(transfer.fallbackTargetId, {
        type: 'p2p-fallback-ready',
        fileId: hexFileId,
        name: transfer.name
      });
      
      transfer.eta = 'Sent via Relay';
      showToast(`File ${transfer.name} successfully transferred via Server Relay fallback!`, 'success');
    }

    renderTransferQueue();
    fetchFiles();
    updateTransferCountBadge();
  } catch (err) {
    transfer.status = 'failed';
    transfer.eta = 'Assembly failed';
    showToast(err.message, 'error');
    renderTransferQueue();
  }
}

function togglePauseUpload(transferId) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) return;
  
  if (transfer.status === 'uploading') {
    transfer.paused = true;
    transfer.status = 'paused';
    if (transfer.activeXHRInstances) {
      transfer.activeXHRInstances.forEach((xhr) => {
        try { xhr.abort(); } catch (e) {}
      });
      transfer.activeXHRInstances.clear();
    }
    showToast(`Upload paused: ${transfer.name}`, 'info');
    renderTransferQueue();
    renderFileList(); // Update files list to reflect paused state
  } else if (transfer.status === 'paused') {
    transfer.paused = false;
    transfer.status = 'uploading';
    transfer.timeLastCheck = Date.now();
    transfer.bytesLastLoaded = 0;
    uploadNextChunks(transfer);
    showToast(`Resuming upload: ${transfer.name}`, 'info');
    renderTransferQueue();
    renderFileList(); // Update files list to reflect uploading state
  }
}

function cleanupServerUpload(uploadId) {
  fetch(`/api/transfer/upload/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    headers: { 'X-Client-Id': state.clientId }
  }).catch(() => {});
}

function cancelTransfer(transferId, skipConfirm = false, notifyPeer = true) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) return;
  
  if (!skipConfirm && !confirm(`Stop and remove transfer of ${transfer.name}?`)) return;

  if (transfer.activeXHRInstances) {
    transfer.activeXHRInstances.forEach((xhr) => {
      try { xhr.abort(); } catch (e) {}
    });
    transfer.activeXHRInstances.clear();
  }

  if (transfer.watchdogInterval) {
    clearInterval(transfer.watchdogInterval);
    transfer.watchdogInterval = null;
  }
  if (transfer.timeoutRef) {
    clearTimeout(transfer.timeoutRef);
    transfer.timeoutRef = null;
  }
  if (transfer.dataChannel) {
    try { transfer.dataChannel.close(); } catch (e) {}
  }
  if (transfer.peerId) {
    if (notifyPeer) {
      sendSignal(transfer.peerId, {
        type: 'p2p-cancel',
        transferId,
        name: transfer.name
      });
    }
    closePeerConnection(transfer.peerId);
  }

  if (transfer.type.includes('Server')) {
    cleanupServerUpload(transfer.id);
  }

  state.transfers.delete(transferId);
  renderTransferQueue();
  updateTransferCountBadge();
  renderFileList();
  showToast('Transfer stopped and removed', 'info');
}

function cancelUpload(transferId) {
  cancelTransfer(transferId);
}

// --------------------------------------------------------------------------
// 7. WebSocket signaling client
// --------------------------------------------------------------------------
function sendJoinMessage(otpCode = null) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'join',
      clientId: state.clientId,
      username: state.username,
      avatar: state.avatar,
      deviceInfo: {
        platform: navigator.platform,
        userAgent: navigator.userAgent
      }
    };
    if (otpCode) {
      payload.otp = otpCode;
      state.otp = otpCode;
    } else if (state.otp) {
      payload.otp = state.otp;
    }
    state.ws.send(JSON.stringify(payload));
  }
}

function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;
  
  state.ws = new WebSocket(wsUrl);
  
  state.ws.onopen = () => {
    document.getElementById('network-status-text').innerText = 'Connected';
    document.getElementById('network-status-icon').className = 'bi bi-wifi text-success';
    sendJoinMessage(); // Register Client
  };
  
  state.ws.onclose = () => {
    document.getElementById('network-status-text').innerText = 'Offline';
    document.getElementById('network-status-icon').className = 'bi bi-wifi-off text-danger';
    
    // Auto-reconnect after 5 seconds
    setTimeout(initWebSocket, 5000);
  };
  
  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      
      switch (msg.type) {
        case 'auth-required':
          document.getElementById('auth-overlay').style.display = 'flex';
          document.getElementById('auth-error-msg').style.display = 'none';
          break;
          
        case 'auth-failed':
          document.getElementById('auth-overlay').style.display = 'flex';
          const errEl = document.getElementById('auth-error-msg');
          errEl.innerText = msg.message || 'Incorrect OTP code. Please try again.';
          errEl.style.display = 'block';
          break;
          
        case 'auth-success':
          document.getElementById('auth-overlay').style.display = 'none';
          fetchFiles();
          break;

        case 'otp-updated':
          if (state.isHost) {
            document.getElementById('radar-otp-code').innerText = msg.otp || '------';
            showToast('Security OTP refreshed successfully', 'success');
          }
          break;

        case 'welcome':
          state.isHost = msg.isHost || false;
          
          if (state.isHost) {
            document.getElementById('radar-otp-banner').style.display = 'flex';
            document.getElementById('radar-otp-code').innerText = msg.activeOTP || '------';
            document.getElementById('host-pending-section').style.display = 'block';
            fetchPendingApprovals();
          } else {
            document.getElementById('radar-otp-banner').style.display = 'none';
            document.getElementById('host-pending-section').style.display = 'none';
            document.getElementById('auth-overlay').style.display = 'none'; // Auto hide if welcomed
          }
          
          state.peers.clear();
          msg.clients.forEach(c => state.peers.set(c.id, c));
          renderRadarScreen();
          renderTextPeerList();
          updatePeerCountBadge();
          break;
          
        case 'user-joined':
          state.peers.set(msg.client.id, msg.client);
          showToast(`${msg.client.username} has joined the mesh`, 'info');
          renderRadarScreen();
          renderTextPeerList();
          updatePeerCountBadge();
          break;
          
        case 'user-left':
          const peer = state.peers.get(msg.clientId);
          if (peer) {
            showToast(`${peer.username} left the network`, 'info');
            state.peers.delete(msg.clientId);
            // Clean peer connection
            closePeerConnection(msg.clientId);
          }
          renderRadarScreen();
          renderTextPeerList();
          updatePeerCountBadge();
          break;
          
        case 'signal':
          handleIncomingSignal(msg.senderId, msg.data);
          break;
          
        case 'upload-pending':
          if (state.isHost) {
            showToast(`New file upload request: ${msg.file.name}`, 'info');
            fetchPendingApprovals();
            openWindow('transfers');
          }
          break;
          
        case 'file-list-updated':
          fetchFiles();
          break;
          
        case 'error':
          console.error('WS Server Error:', msg.message);
          break;
      }
    } catch (e) {
      console.error('WS payload error:', e);
    }
  };
}

// --------------------------------------------------------------------------
// 8. WebRTC Peer-to-Peer direct file transfer
// --------------------------------------------------------------------------

// Close direct RTCPeerConnection cleanly
function closePeerConnection(clientId) {
  const pc = state.peerConnections.get(clientId);
  if (pc) {
    try { pc.close(); } catch(e) {}
    state.peerConnections.delete(clientId);
  }
  state.iceCandidateQueues.delete(clientId);
}

// Handles WebRTC connection failures, showing fallback suggestions
function handleWebRTCFailure(peerId, transferId, errorMessage) {
  const transfer = state.transfers.get(transferId);
  if (transfer && transfer.status !== 'completed' && transfer.status !== 'failed') {
    closePeerConnection(peerId);
    
    if (transfer.type === 'Upload (P2P)') {
      // Automatic fallback upload
      initiateP2PFallbackUpload(transfer, peerId);
    } else if (transfer.type === 'Download (P2P)') {
      // Receiver side waits for the fallback signal
      transfer.status = 'connecting';
      transfer.eta = 'Waiting for Server Relay fallback...';
      renderTransferQueue();
      showToast('P2P direct connection failed. Waiting for sender to fallback to Server Relay...', 'info');
    } else {
      transfer.status = 'failed';
      transfer.eta = 'Connection failed';
      renderTransferQueue();
      updateTransferCountBadge();
    }
  }
}

// Spawns a chunked HTTP upload automatically when direct WebRTC fails
async function initiateP2PFallbackUpload(transfer, peerId) {
  const file = transfer.file;
  if (!file) return;

  console.log(`Starting P2P automatic fallback upload for: ${file.name}`);
  showToast(`Direct P2P connection failed. Automatically sending ${file.name} via Server Relay fallback...`, 'info');
  
  // Transition transfer type and state
  transfer.type = 'Upload (Server)';
  transfer.status = 'uploading';
  transfer.progress = 0;
  transfer.speed = 0;
  transfer.eta = 'Starting upload fallback...';
  transfer.fallbackTargetId = peerId; // Save the target peer ID to signal when upload completes
  transfer.peerId = peerId;
  
  // Initialize server session properties
  transfer.chunkSize = getOptimalChunkSize(file.size);
  transfer.totalChunks = Math.ceil(file.size / transfer.chunkSize);
  transfer.chunksSent = [];
  transfer.bytesLastLoaded = 0;
  transfer.timeLastCheck = Date.now();
  
  renderTransferQueue();
  renderFileList();
  
  try {
    const initRes = await fetch('/api/transfer/upload/init', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': state.clientId
      },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        totalChunks: transfer.totalChunks,
        mimeType: file.type || 'application/octet-stream',
        uploadId: transfer.id,
        clientId: state.clientId,
        senderName: state.username
      })
    });
    
    if (!initRes.ok) throw new Error('Init fallback upload failed');
    uploadNextChunks(transfer);
  } catch (err) {
    transfer.status = 'failed';
    transfer.eta = 'Fallback upload failed';
    showToast(`Fallback upload failed: ${err.message}`, 'error');
    renderTransferQueue();
  }
}

// Relays signals (SDP, Candidates, Invites) to targets
function sendSignal(targetId, data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'signal',
      targetId,
      data
    }));
  }
}

// Handle signals relayed from signaling server
async function handleIncomingSignal(senderId, signal) {
  const peer = state.peers.get(senderId);
  const senderName = peer ? peer.username : 'Unknown Peer';
  
  switch (signal.type) {
    case 'file-invite':
      // Open accept/decline dialog
      state.pendingInvite = {
        senderId,
        transferId: signal.transferId,
        fileName: signal.name,
        fileSize: signal.size,
        fileType: signal.mimeType
      };
      
      document.getElementById('prompt-peer-name').innerText = senderName;
      document.getElementById('prompt-file-name').innerText = signal.name;
      document.getElementById('prompt-file-size').innerText = formatBytes(signal.size);
      document.getElementById('p2p-prompt-overlay').style.display = 'flex';
      
      // Bind click once
      document.getElementById('btn-accept-transfer').onclick = acceptIncomingP2P;
      document.getElementById('btn-decline-transfer').onclick = declineIncomingP2P;
      break;
      
    case 'file-decline':
      showToast(`${senderName} declined your file transfer request`, 'error');
      // Cancel transfer status
      const failedTx = state.transfers.get(signal.transferId);
      if (failedTx) {
        failedTx.status = 'failed';
        failedTx.eta = 'Declined by peer';
        renderTransferQueue();
        renderFileList(); // Clear virtual item
      }
      break;
      
    case 'file-accept':
      startSenderPeerConnection(senderId, signal.transferId);
      break;
      
    case 'offer':
      await setupReceiverPeerConnection(senderId, signal.sdp, signal.transferId);
      break;
      
    case 'answer':
      const pc = state.peerConnections.get(senderId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        // Process queued ICE candidates that arrived early
        const queue = state.iceCandidateQueues.get(senderId) || [];
        for (const candidate of queue) {
          try {
            if (candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
          } catch (e) {
            console.error("Error adding queued candidate [Sender]:", e);
          }
        }
        state.iceCandidateQueues.delete(senderId);
      }
      break;
      
    case 'candidate':
      const connection = state.peerConnections.get(senderId);
      if (connection && connection.remoteDescription) {
        try {
          await connection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.error("Error adding ICE candidate:", e);
        }
      } else {
        if (!state.iceCandidateQueues.has(senderId)) {
          state.iceCandidateQueues.set(senderId, []);
        }
        state.iceCandidateQueues.get(senderId).push(signal.candidate);
      }
      break;
      
    case 'p2p-fallback-ready':
      let activeRx = null;
      state.transfers.forEach((tx) => {
        if (tx.type === 'Download (P2P)' && tx.name === signal.name && tx.status !== 'completed') {
          activeRx = tx;
        }
      });
      
      if (activeRx) {
        activeRx.status = 'completed';
        activeRx.progress = 100;
        activeRx.eta = 'Done (via Relay)';
        renderTransferQueue();
        updateTransferCountBadge();
      }
      
      const downloadUrl = `/api/transfer/download/${signal.fileId}?clientId=${state.clientId}`;
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = downloadUrl;
      downloadAnchor.download = signal.name;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      
      showToast(`P2P direct connection failed. Successfully downloaded ${signal.name} via Server Relay fallback.`, 'success');
      break;

    case 'p2p-cancel':
      if (state.pendingInvite && state.pendingInvite.transferId === signal.transferId) {
        document.getElementById('p2p-prompt-overlay').style.display = 'none';
        state.pendingInvite = null;
      }
      const cancelledTx = state.transfers.get(signal.transferId);
      if (cancelledTx) {
        if (cancelledTx.timeoutRef) {
          clearTimeout(cancelledTx.timeoutRef);
          cancelledTx.timeoutRef = null;
        }
        if (cancelledTx.dataChannel) {
          try { cancelledTx.dataChannel.close(); } catch (e) {}
        }
        closePeerConnection(senderId);
        state.transfers.delete(signal.transferId);
        renderTransferQueue();
        updateTransferCountBadge();
        renderFileList();
      }
      showToast(`${senderName} stopped the direct transfer${signal.name ? `: ${signal.name}` : ''}`, 'info');
      break;
  }
}

// User rejects transfer
function declineIncomingP2P() {
  document.getElementById('p2p-prompt-overlay').style.display = 'none';
  if (state.pendingInvite) {
    sendSignal(state.pendingInvite.senderId, {
      type: 'file-decline',
      transferId: state.pendingInvite.transferId
    });
    state.pendingInvite = null;
  }
}

// User accepts transfer
async function acceptIncomingP2P() {
  document.getElementById('p2p-prompt-overlay').style.display = 'none';
  if (!state.pendingInvite) return;
  
  const invite = state.pendingInvite;
  state.pendingInvite = null;
  
  const transferId = invite.transferId;
  
  // Register receiver queue entry
  const transfer = {
    id: transferId,
    name: invite.fileName,
    size: invite.fileSize,
    type: 'Download (P2P)',
    progress: 0,
    speed: 0,
    eta: 'Connecting...',
    status: 'connecting',
    peerId: invite.senderId,
    receivedBytes: 0,
    buffers: [],
    startTime: Date.now()
  };
  
  // Timeout for connection (handshake failover)
  transfer.timeoutRef = setTimeout(() => {
    if (transfer.status === 'connecting' || (transfer.status === 'downloading' && transfer.receivedBytes === 0)) {
      console.log('WebRTC Receiver connection timeout');
      handleWebRTCFailure(invite.senderId, transferId, 'WebRTC handshake timed out.');
    }
  }, 12000);
  
  state.transfers.set(transferId, transfer);
  openWindow('transfers');
  updateTransferCountBadge();
  renderTransferQueue();
  
  // Reply signaling target that we accept and wait for SDP Offer
  sendSignal(invite.senderId, {
    type: 'file-accept',
    transferId
  });
  
  // Listener is ready to build PeerConnection on incoming offer
  state.rxTransferContext = {
    transferId,
    invite
  };
}

// Accept hook on Sender side is handled dynamically in handleIncomingSignal

// SENDER SETUP
async function startSenderPeerConnection(targetId, transferId) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) return;
  
  transfer.status = 'connecting';
  transfer.peerId = targetId;
  transfer.eta = 'Shaking hands...';
  renderTransferQueue();
  
  const connectionTimeout = setTimeout(() => {
    if (transfer.status === 'connecting' || transfer.status === 'pending-invite') {
      console.log('WebRTC Sender connection timeout');
      handleWebRTCFailure(targetId, transferId, 'WebRTC handshake timed out.');
    }
  }, 12000);
  
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  
  state.peerConnections.set(targetId, pc);
  
  pc.onconnectionstatechange = () => {
    console.log(`WebRTC Connection State [Sender]: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      clearTimeout(connectionTimeout);
      handleWebRTCFailure(targetId, transferId, 'Connection failed.');
    }
  };
  
  // Create P2P Data channel
  const dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
  dataChannel.binaryType = 'arraybuffer';
  transfer.dataChannel = dataChannel;
  
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(targetId, {
        type: 'candidate',
        candidate: event.candidate
      });
    }
  };
  
  dataChannel.onopen = () => {
    clearTimeout(connectionTimeout);
    console.log('WebRTC Data Channel opened!');
    transfer.status = 'uploading';
    transfer.startTime = Date.now();
    transmitP2PFile(transfer, targetId);
  };
  
  dataChannel.onclose = () => {
    clearTimeout(connectionTimeout);
    console.log('WebRTC Data Channel closed');
    closePeerConnection(targetId);
  };
  
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  
  sendSignal(targetId, {
    type: 'offer',
    sdp: offer,
    transferId
  });
}

// SENDER: Streams bytes directly onto RTC Data Channel using block-buffered high-performance mode with watchdog and prefetching
function transmitP2PFile(transfer, targetId) {
  const channel = transfer.dataChannel;
  const file = transfer.file;
  
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks to optimize SCTP throughput
  const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB block reads to decrease async I/O wait cycles
  const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024; // 8MB buffer limit for high throughput pipeline
  const LOW_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2MB threshold to ensure buffer never runs dry
  const PUMP_INTERVAL_MS = 5;
  let offset = 0;
  let bytesTransmitted = 0; // Absolute track of sent bytes
  let bytesLastSent = 0;
  let timeLastCheck = Date.now();
  
  channel.bufferedAmountLowThreshold = LOW_BUFFERED_AMOUNT;
  
  let isSending = false;
  let currentBlock = null;
  let blockOffset = 0;
  
  function readNextBlock() {
    if (offset >= file.size) return Promise.resolve(null);
    const end = Math.min(offset + BLOCK_SIZE, file.size);
    const slice = file.slice(offset, end);
    offset = end;
    return slice.arrayBuffer();
  }
  
  // Prefetch the very first block
  let nextBlockPromise = readNextBlock();
  
  async function fillAndSend() {
    if (isSending) return;
    isSending = true;
    
    const loopStart = Date.now();
    try {
      while (true) {
        if (channel.readyState !== 'open') {
          isSending = false;
          return;
        }
        
        if (channel.bufferedAmount >= MAX_BUFFERED_AMOUNT) {
          isSending = false;
          return;
        }
        
        if (!currentBlock || blockOffset >= currentBlock.byteLength) {
          // Await the prefetched block
          const nextBlock = await nextBlockPromise;
          if (!nextBlock) {
            // Signal completed transfer
            if (transfer.watchdogInterval) {
              clearInterval(transfer.watchdogInterval);
              transfer.watchdogInterval = null;
            }
            setTimeout(() => {
              if (channel.readyState === 'open') {
                channel.send(JSON.stringify({ type: 'tx-done' }));
                transfer.status = 'completed';
                transfer.eta = 'Done';
                showToast(`P2P Send completed for ${transfer.name}`, 'success');
                renderTransferQueue();
                updateTransferCountBadge();
                renderFileList(); // Update files list to finalize UI
              }
            }, 500);
            isSending = false;
            return;
          }
          currentBlock = nextBlock;
          blockOffset = 0;
          
          // Immediately prefetch the next block in the background
          nextBlockPromise = readNextBlock();
        }
        
        const sliceEnd = Math.min(blockOffset + CHUNK_SIZE, currentBlock.byteLength);
        const sliceSize = sliceEnd - blockOffset;
        const view = new Uint8Array(currentBlock, blockOffset, sliceSize);
        blockOffset = sliceEnd;
        bytesTransmitted += sliceSize;
        
        channel.send(view);
        
        // Speed metrics
        const now = Date.now();
        const duration = (now - timeLastCheck) / 1000;
        if (duration >= 0.5) {
          const currentSpeed = (bytesTransmitted - bytesLastSent) / duration;
          transfer.speed = currentSpeed;
          timeLastCheck = now; // Fixed: update local tracking variable instead of transfer field
          bytesLastSent = bytesTransmitted;
          
          const remaining = file.size - bytesTransmitted;
          transfer.eta = currentSpeed > 0 ? formatETA(remaining / currentSpeed) : 'Calculating...';
        }
        
        transfer.progress = (bytesTransmitted / file.size) * 100;
        updateTransferItemUI(transfer.id);
        
        // Yield after 12ms to keep the browser main UI thread responsive (aiming for 60fps)
        if (Date.now() - loopStart > 12) {
          isSending = false;
          setTimeout(fillAndSend, 0);
          return;
        }
      }
    } catch (err) {
      console.error('Error in P2P transmission:', err);
      isSending = false;
    }
  }
  
  channel.onbufferedamountlow = () => {
    fillAndSend();
  };
  
  // Watchdog: pump quickly if bufferedamountlow is not fired by the browser.
  const watchdogInterval = setInterval(() => {
    if (!state.transfers.has(transfer.id) || channel.readyState !== 'open' || transfer.status !== 'uploading' || transfer.paused) {
      clearInterval(watchdogInterval);
      if (transfer.watchdogInterval === watchdogInterval) {
        transfer.watchdogInterval = null;
      }
      return;
    }
    if (channel.bufferedAmount < LOW_BUFFERED_AMOUNT) {
      fillAndSend();
    }
  }, PUMP_INTERVAL_MS);
  transfer.watchdogInterval = watchdogInterval;
  
  fillAndSend(); // Kickoff
}

// RECEIVER SETUP
async function setupReceiverPeerConnection(senderId, sdpOffer, transferId) {
  const context = state.rxTransferContext;
  if (!context || context.invite.senderId !== senderId) return;
  
  const transfer = state.transfers.get(context.transferId);
  if (!transfer) return;
  
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  state.peerConnections.set(senderId, pc);
  
  pc.onconnectionstatechange = () => {
    console.log(`WebRTC Connection State [Receiver]: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      clearTimeout(transfer.timeoutRef);
      handleWebRTCFailure(senderId, transferId, 'Connection failed.');
    }
  };
  
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(senderId, {
        type: 'candidate',
        candidate: event.candidate
      });
    }
  };
  
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    let bytesLastCheck = 0;
    let timeLastCheck = Date.now();
    
    channel.onopen = () => {
      clearTimeout(transfer.timeoutRef);
    };
    
    transfer.status = 'downloading';
    transfer.startTime = Date.now();
    
    channel.onmessage = (e) => {
      clearTimeout(transfer.timeoutRef);
      // Check if message is EOF completion string
      if (typeof e.data === 'string') {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'tx-done') {
            // Compile ArrayBuffers and trigger browser download
            const blob = new Blob(transfer.buffers, { type: context.invite.fileType || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = transfer.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            transfer.status = 'completed';
            transfer.progress = 100;
            transfer.eta = 'Done';
            showToast(`P2P Download of ${transfer.name} finished!`, 'success');
            renderTransferQueue();
            updateTransferCountBadge();
            renderFileList(); // Clear virtual list entries
            
            closePeerConnection(senderId);
          }
        } catch(err) {}
        return;
      }
      
      // Push binary buffer
      transfer.buffers.push(e.data);
      transfer.receivedBytes += e.data.byteLength;
      
      // Speed indicators
      const now = Date.now();
      const elapsed = (now - timeLastCheck) / 1000;
      if (elapsed >= 0.5) {
        const loadedDiff = transfer.receivedBytes - bytesLastCheck;
        const currentSpeed = loadedDiff / elapsed;
        transfer.speed = currentSpeed;
        timeLastCheck = now;
        bytesLastCheck = transfer.receivedBytes;
        
        const remaining = transfer.size - transfer.receivedBytes;
        transfer.eta = currentSpeed > 0 ? formatETA(remaining / currentSpeed) : 'Calculating...';
      }
      
      transfer.progress = (transfer.receivedBytes / transfer.size) * 100;
      updateTransferItemUI(transfer.id);
    };
  };
  
  await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
  
  // Process queued ICE candidates that arrived early
  const queue = state.iceCandidateQueues.get(senderId) || [];
  for (const candidate of queue) {
    try {
      if (candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (e) {
      console.error("Error adding queued candidate [Receiver]:", e);
    }
  }
  state.iceCandidateQueues.delete(senderId);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  
  sendSignal(senderId, {
    type: 'answer',
    sdp: answer,
    transferId
  });
}

// User triggers send via Radar double click or drop
function requestP2PFileShare(targetClientId) {
  // Trigger file picker
  const input = document.createElement('input');
  input.type = 'file';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const transferId = 'p2p-tx-' + generateUUID();
    
    // Register sender card
    const transfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      type: 'Upload (P2P)',
      progress: 0,
      speed: 0,
      eta: 'Waiting for peer...',
      status: 'pending-invite',
      peerId: targetClientId,
      file
    };
    
    state.transfers.set(transferId, transfer);
    openWindow('transfers');
    updateTransferCountBadge();
    renderTransferQueue();
    
    // Send invitation signal over WS
    sendSignal(targetClientId, {
      type: 'file-invite',
      transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream'
    });
    
    showToast(`Invite sent to peer for: ${file.name}`, 'info');
  };
  
  input.click();
}

// --------------------------------------------------------------------------
// 9. Peer Discovery Radar rendering
// --------------------------------------------------------------------------
function renderRadarScreen() {
  const container = document.getElementById('radar-peers-container');
  container.innerHTML = '';
  
  const totalPeers = state.peers.size;
  if (totalPeers === 0) return;
  
  let i = 0;
  state.peers.forEach((peer, id) => {
    // Distribute angles evenly around radar host center
    const angle = (i * (2 * Math.PI)) / totalPeers;
    const distancePercent = 35; // Position in middle ring (35% radius)
    
    const x = 50 + distancePercent * Math.cos(angle);
    const y = 50 + distancePercent * Math.sin(angle);
    
    const peerNode = document.createElement('div');
    peerNode.className = 'radar-peer-node';
    peerNode.style.left = `${x}%`;
    peerNode.style.top = `${y}%`;
    peerNode.title = `Send file directly to ${peer.username}`;
    
    const iconClass = getAvatarIconClass(peer.avatar);
    
    peerNode.innerHTML = `
      <div class="radar-peer-dot">
        <i class="bi ${iconClass}"></i>
      </div>
      <span class="radar-peer-label">${escapeHtml(peer.username)}</span>
    `;
    
    // Click triggers P2P share request
    peerNode.addEventListener('click', () => {
      requestP2PFileShare(id);
    });
    
    container.appendChild(peerNode);
    i++;
  });
}

function renderTextPeerList() {
  const list = document.getElementById('peers-text-list');
  
  if (state.peers.size === 0) {
    list.innerHTML = `
      <div class="empty-peers text-center text-muted py-4">
        <i class="bi bi-broadcast display-4 d-block mb-3 animate-pulse"></i>
        Searching for peers on your network... Connect another device to join the mesh.
      </div>
    `;
    return;
  }
  
  let html = '';
  state.peers.forEach((peer, id) => {
    const iconClass = getAvatarIconClass(peer.avatar);
    html += `
      <div class="peer-list-card" onclick="requestP2PFileShare('${id}')">
        <div class="d-flex align-items-center gap-2">
          <i class="bi ${iconClass} fs-5 text-success"></i>
          <div>
            <strong>${escapeHtml(peer.username)}</strong>
            <div class="text-muted small">${escapeHtml(peer.deviceInfo.platform || 'LAN Node')}</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm p-1" title="Direct WebRTC Transfer">
          <i class="bi bi-send-fill text-accent"></i>
        </button>
      </div>
    `;
  });
  
  list.innerHTML = html;
}

function getAvatarIconClass(avatarName) {
  const mapping = {
    monitor: 'bi-display',
    laptop: 'bi-laptop',
    phone: 'bi-phone',
    server: 'bi-hdd-network',
    terminal: 'bi-terminal'
  };
  return mapping[avatarName] || 'bi-display';
}

// --------------------------------------------------------------------------
// 10. Active Transfers Queue UI rendering
// --------------------------------------------------------------------------
function renderTransferQueue() {
  const list = document.getElementById('transfer-queue-list');
  
  if (state.transfers.size === 0) {
    list.innerHTML = `
      <div class="empty-state text-center text-muted py-5">
        <i class="bi bi-activity display-4 d-block mb-3"></i>
        No active uploads or downloads.
      </div>
    `;
    return;
  }
  
  let html = '';
  state.transfers.forEach((tx) => {
    const isCompleted = tx.status === 'completed';
    const isFailed = tx.status === 'failed';
    const isPaused = tx.status === 'paused';
    
    // Status text label builder
    let statusLabel = `${tx.type} - `;
    if (isCompleted) statusLabel += 'Completed';
    else if (isFailed) statusLabel += 'Failed';
    else if (isPaused) statusLabel += 'Paused';
    else statusLabel += `${tx.progress.toFixed(1)}%`;
    
    // Action button renderers
    let actionsHtml = '';
    if (!isCompleted && !isFailed && tx.type.includes('Server')) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm p-1" onclick="togglePauseUpload('${tx.id}')" title="${isPaused ? 'Resume' : 'Pause'}">
          <i class="bi ${isPaused ? 'bi-play-fill' : 'bi-pause-fill'}"></i>
        </button>
        <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="cancelTransfer('${tx.id}')" title="Stop and remove">
          <i class="bi bi-x-circle-fill"></i>
        </button>
      `;
    } else if (!isCompleted && !isFailed && tx.type.includes('P2P')) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="cancelTransfer('${tx.id}')" title="Stop direct transfer">
          <i class="bi bi-stop-circle-fill"></i>
        </button>
      `;
    } else {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="removeTransfer('${tx.id}')" title="Remove from queue">
          <i class="bi bi-trash3-fill"></i>
        </button>
      `;
    }
    
    html += `
      <div class="transfer-item" id="tx-item-${tx.id}">
        <div class="transfer-details-row">
          <div>
            <strong>${escapeHtml(tx.name)}</strong>
            <div class="transfer-meta-text">${statusLabel}</div>
          </div>
          <div class="d-flex align-items-center gap-2">
            ${actionsHtml}
          </div>
        </div>
        <div class="progress-bar-outer">
          <div class="progress-bar-inner" id="tx-progress-${tx.id}" style="width: ${tx.progress}%"></div>
        </div>
        <div class="transfer-details-row text-muted small">
          <span>${formatBytes(tx.size)}</span>
          <span id="tx-speed-${tx.id}">${!isCompleted && !isFailed && !isPaused ? `${formatBytes(tx.speed)}/s` : ''}</span>
          <span id="tx-eta-${tx.id}">${tx.eta}</span>
        </div>
      </div>
    `;
  });
  
  list.innerHTML = html;
}

// Live inline UI updates for active progress to prevent full container re-renders (smooth UI performance)
function updateTransferItemUI(transferId) {
  const tx = state.transfers.get(transferId);
  if (!tx) return;
  
  // Throttle DOM updates to at most once every 150ms per transfer to free up CPU for networking
  const now = Date.now();
  const isFinalState = tx.progress >= 100 || tx.status === 'completed' || tx.status === 'failed' || tx.status === 'paused' || tx.status === 'assembling';
  if (tx.lastUIUpdate && (now - tx.lastUIUpdate < 150) && !isFinalState) {
    return;
  }
  tx.lastUIUpdate = now;
  
  const progressEl = document.getElementById(`tx-progress-${transferId}`);
  const speedEl = document.getElementById(`tx-speed-${transferId}`);
  const etaEl = document.getElementById(`tx-eta-${transferId}`);
  const itemEl = document.getElementById(`tx-item-${transferId}`);
  
  if (progressEl) progressEl.style.width = `${tx.progress}%`;
  if (speedEl) speedEl.innerText = `${formatBytes(tx.speed)}/s`;
  if (etaEl) etaEl.innerText = tx.eta;
  
  if (itemEl) {
    const metaEl = itemEl.querySelector('.transfer-meta-text');
    if (metaEl) {
      let label = `${tx.type} - `;
      if (tx.status === 'completed') label += 'Completed';
      else if (tx.status === 'failed') label += 'Failed';
      else if (tx.status === 'paused') label += 'Paused';
      else label += `${tx.progress.toFixed(1)}%`;
      metaEl.innerText = label;
    }
  }
  
  // Update virtual progress badge in the file manager list table directly instead of re-rendering the whole table
  const badgeEl = document.getElementById(`file-badge-virtual-${transferId}`);
  if (badgeEl) {
    badgeEl.innerText = tx.status === 'assembling' ? 'Assembling...' : `${tx.progress.toFixed(0)}%`;
  }
}

function removeTransfer(transferId) {
  const tx = state.transfers.get(transferId);
  if (!tx) return;
  if (tx.status !== 'completed' && tx.status !== 'failed') {
    cancelTransfer(transferId);
    return;
  }
  state.transfers.delete(transferId);
  renderTransferQueue();
  updateTransferCountBadge();
  renderFileList();
}

function clearInactiveTransfers() {
  state.transfers.forEach((tx, id) => {
    if (tx.status === 'completed' || tx.status === 'failed') {
      state.transfers.delete(id);
    }
  });
  renderTransferQueue();
  updateTransferCountBadge();
}

function updateTransferCountBadge() {
  const badge = document.getElementById('badge-transfer-count');
  let active = 0;
  state.transfers.forEach(tx => {
    if (tx.status === 'uploading' || tx.status === 'downloading' || tx.status === 'connecting' || tx.status === 'pending-invite' || tx.status === 'assembling') {
      active++;
    }
  });
  
  if (active > 0) {
    badge.innerText = active;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function updatePeerCountBadge() {
  const badge = document.getElementById('badge-peer-count');
  if (state.peers.size > 0) {
    badge.innerText = state.peers.size;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

// --------------------------------------------------------------------------
// 11. Helper formatting utilities
// --------------------------------------------------------------------------
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0 || !bytes || isNaN(bytes) || bytes < 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes < 1) {
    return parseFloat(bytes.toFixed(dm)) + ' Bytes';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return parseFloat(bytes.toFixed(dm)) + ' Bytes';
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatETA(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return 'Calculating...';
  if (seconds < 1) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Global UI slide-in toast notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `sys-toast toast-${type}`;
  
  const icons = {
    success: 'bi-check-circle-fill',
    error: 'bi-exclamation-triangle-fill',
    info: 'bi-info-circle-fill'
  };
  const icon = icons[type] || 'bi-info-circle-fill';
  
  toast.innerHTML = `
    <i class="bi ${icon}"></i>
    <span>${escapeHtml(message)}</span>
  `;
  
  container.appendChild(toast);
  
  // Slide out and remove
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --------------------------------------------------------------------------
// 16. Start Menu & Connection Share Hub Functionality
// --------------------------------------------------------------------------
function initStartMenuAndShareHub() {
  const btnStart = document.getElementById('btn-start');
  const startMenu = document.getElementById('start-menu-panel');
  
  if (btnStart && startMenu) {
    btnStart.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = startMenu.style.display === 'flex';
      startMenu.style.display = isOpen ? 'none' : 'flex';
      btnStart.classList.toggle('active', !isOpen);
    });
    
    // Hide start menu on click outside
    document.addEventListener('click', (e) => {
      if (!startMenu.contains(e.target) && e.target !== btnStart && !btnStart.contains(e.target)) {
        startMenu.style.display = 'none';
        btnStart.classList.remove('active');
      }
    });
  }
  
  // Bind start menu item clicks
  const bindStartItem = (id, windowName) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        if (startMenu) startMenu.style.display = 'none';
        if (btnStart) btnStart.classList.remove('active');
        
        if (windowName === 'share') {
          openShareHub();
        } else {
          openWindow(windowName);
        }
      });
    }
  };
  
  bindStartItem('start-item-share', 'share');
  bindStartItem('start-item-files', 'files');
  bindStartItem('start-item-radar', 'radar');
  bindStartItem('start-item-settings', 'settings');
  bindStartItem('start-item-help', 'help');
  
  const restartBtn = document.getElementById('start-btn-restart');
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to refresh the server connection links? This will reload the web UI.')) {
        location.reload();
      }
    });
  }
}

function openShareHub() {
  openWindow('share');
  populateShareHubAddresses();
}

function populateShareHubAddresses() {
  const container = document.getElementById('share-addresses-list');
  if (!container || !state.serverSettings) return;
  
  const settings = state.serverSettings;
  const addresses = [];
  
  // 1. Add public tunnel if active
  if (settings.publicTunnelUrl) {
    addresses.push({
      label: 'Public Tunnel (Remote Connect)',
      url: settings.publicTunnelUrl
    });
  }
  
  // 2. Add local LAN interfaces
  if (settings.networkAddresses && settings.networkAddresses.length > 0) {
    settings.networkAddresses.forEach(ip => {
      addresses.push({
        label: `LAN: ${ip.interface} (${ip.type || 'Wi-Fi'})`,
        url: `http://${ip.address}:${settings.port}`
      });
    });
  }
  
  if (addresses.length === 0) {
    container.innerHTML = `<div class="text-muted small text-center py-2">No connection interfaces detected.</div>`;
    return;
  }
  
  container.innerHTML = addresses.map((addr, idx) => `
    <div class="share-address-row">
      <div class="share-address-info">
        <span class="share-address-name">${escapeHtml(addr.label)}</span>
        <span class="share-address-url">${escapeHtml(addr.url)}</span>
      </div>
      <div class="share-actions-group">
        <button class="btn btn-secondary btn-sm p-1" style="padding: 4px 8px; font-size: 11px;" title="Scan QR Code" onclick="updateShareQrCode('${escapeHtml(addr.url)}', '${escapeHtml(addr.label)}')">
          <i class="bi bi-qr-code"></i>
        </button>
        <button class="btn btn-secondary btn-sm p-1" style="padding: 4px 8px; font-size: 11px;" title="Copy Link" onclick="copyToClipboard('${escapeHtml(addr.url)}')">
          <i class="bi bi-clipboard"></i>
        </button>
      </div>
    </div>
  `).join('');
  
  // Load default QR (first link)
  updateShareQrCode(addresses[0].url, addresses[0].label);
}

// Declared globally so inline HTML onclick handlers can trigger them
window.updateShareQrCode = function(url, label) {
  const qrContainer = document.getElementById('share-qr-container');
  const qrLabel = document.getElementById('share-qr-label');
  if (!qrContainer || !qrLabel) return;
  
  qrLabel.innerText = label;
  qrContainer.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
      <div class="spinner-border text-primary" style="width: 2rem; height: 2rem; border: 3px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: sweep-spin 0.8s linear infinite;" role="status">
        <span style="display: none;">Loading...</span>
      </div>
      <span class="text-muted" style="font-size: 9px;">Generating...</span>
    </div>
  `;
  
  const img = new Image();
  img.onload = () => {
    qrContainer.innerHTML = '';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.style.display = 'block';
    img.style.borderRadius = '4px';
    img.alt = `QR Code for ${url}`;
    qrContainer.appendChild(img);
  };
  img.onerror = () => {
    qrContainer.innerHTML = `<span class="text-danger small" style="font-size: 10px; font-weight: 600;">Failed to generate QR Code.</span>`;
  };
  // Use public qrserver API
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`;
};

window.openShareHubWithUrl = function(url, label) {
  openShareHub();
  window.updateShareQrCode(url, label);
};

window.copyToClipboard = function(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Link copied to clipboard!', 'success'))
      .catch((err) => {
        fallbackCopyToClipboard(text);
      });
  } else {
    fallbackCopyToClipboard(text);
  }
};

function fallbackCopyToClipboard(text) {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('Link copied to clipboard (fallback)!', 'success');
  } catch (err) {
    showToast('Failed to copy link.', 'error');
  }
}
