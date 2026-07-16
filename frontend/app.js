// Safe fallback UUID generator for non-secure contexts (like HTTP LAN connections)
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Safe localStorage wrapper to prevent SecurityErrors in strict browsers
const safeLocalStorage = {
  getItem(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  setItem(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { }
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
  
  // User profile & Auth
  username: safeLocalStorage.getItem('aerosync_username') || 'Guest User',
  avatar: safeLocalStorage.getItem('aerosync_avatar') || 'monitor',
  theme: safeLocalStorage.getItem('aerosync_theme') || 'aero',
  sessionToken: safeLocalStorage.getItem('aerosync_session_token') || '',
  currentUser: null,
  
  // File Listings
  myFiles: [],
  sharedWithMe: [],
  activeExplorerTab: 'myfiles', // 'myfiles' or 'shared'
  searchQuery: '',
  
  // Network and Peers
  ws: null,
  clientId: generateUUID(),
  peers: new Map(),
  peerConnections: new Map(),
  iceCandidateQueues: new Map(),
  
  // Pairing room & Join Token
  roomId: null,
  joinToken: null,
  authStatus: 'unauthenticated', // unauthenticated, guestPending, guestConnected, loggedIn
  
  // Active File Transfer Queue
  transfers: new Map(),
  
  // Pending WebRTC transfer invite
  pendingInvite: null,

  // Selected file for sharing management
  activeShareFileId: null
};

// Helper: Wrapper for fetch adding auth headers
async function secureFetch(url, options = {}) {
  options.headers = options.headers || {};
  if (state.sessionToken) {
    options.headers['X-Session-Token'] = state.sessionToken;
  }
  options.headers['X-Client-Id'] = state.clientId;
  return fetch(url, options);
}

// --------------------------------------------------------------------------
// 2. Window Manager & UI Bootstrapper
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Extract OTP from URL query parameters if present (for easy phone auto-connection)
  const urlParams = new URLSearchParams(window.location.search);
  const urlOtp = urlParams.get('otp');
  if (urlOtp) {
    state.otp = urlOtp;
    // Clean url query parameter from search bar for clean user experience
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  updateClock();
  setInterval(updateClock, 1000);
  
  initUITheme();
  loadProfileInputs();
  
  // Set up dragging for windows
  initWindowDragging('window-files', 'title-files-drag');
  initWindowDragging('window-transfers', 'title-transfers-drag');
  initWindowDragging('window-radar', 'title-radar-drag');
  initWindowDragging('window-settings', 'title-settings-drag');
  initWindowDragging('window-share', 'title-share-drag');
  initWindowDragging('window-help', 'title-help-drag');
  initWindowDragging('window-billing', 'title-billing-drag');
  
  // Attach shortcuts listeners
  setupShortcutButton('shortcut-files', 'files');
  setupShortcutButton('shortcut-transfers', 'transfers');
  setupShortcutButton('shortcut-radar', 'radar');
  setupShortcutButton('shortcut-settings', 'settings');
  setupShortcutButton('shortcut-help', 'help');
  setupShortcutButton('shortcut-billing', 'billing');
  
  // Window button action bindings
  setupWindowActionButtons('files');
  setupWindowActionButtons('transfers');
  setupWindowActionButtons('radar');
  setupWindowActionButtons('settings');
  setupWindowActionButtons('share');
  setupWindowActionButtons('help');
  setupWindowActionButtons('billing');
  
  // Profile & Config buttons
  document.getElementById('btn-save-profile').addEventListener('click', saveProfileLocal);
  document.getElementById('btn-save-server-config').addEventListener('click', saveServerConfig);
  document.getElementById('btn-refresh-files').addEventListener('click', fetchFiles);
  document.getElementById('btn-clear-transfers').addEventListener('click', clearInactiveTransfers);
  
  // Search bar input binding
  document.getElementById('input-file-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    renderFileList();
  });
  
  // File explorer tab buttons binding
  document.getElementById('explorer-tab-myfiles').addEventListener('click', () => {
    switchExplorerTab('myfiles');
  });
  document.getElementById('explorer-tab-shared').addEventListener('click', () => {
    switchExplorerTab('shared');
  });

  // Setup file input picker
  const fileInput = document.getElementById('input-file-uploader');
  fileInput.addEventListener('change', (e) => {
    handleFileUploads(e.target.files);
    fileInput.value = '';
  });
  
  setupDragAndDrop();
  initStartMenuAndShareHub();
  initAvatarSelector();

  // Load and check active user session
  checkAuthSession();

  // Setup auth screen tab events
  setupAuthTabs();

  // Setup sharing access and public links button bindings
  setupSharingControls();

  // Dynamic taskbar tab bindings
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

  // Set up Start Menu item for billing
  const startItemBilling = document.getElementById('start-item-billing');
  if (startItemBilling) {
    startItemBilling.addEventListener('click', () => {
      toggleWindow('billing');
      document.getElementById('start-menu-panel').style.display = 'none';
    });
  }

  // Set up transfer mode radio toggle event listener
  document.querySelectorAll('input[name="transfer-mode-select"]').forEach(radio => {
    radio.addEventListener('change', () => {
      updateTransferModeUI();
    });
  });
  updateTransferModeUI();

  // Set up upgrade plan buttons
  const btnUpgradePro = document.getElementById('btn-upgrade-pro');
  if (btnUpgradePro) {
    btnUpgradePro.addEventListener('click', () => {
      handlePlanUpgrade('pro');
    });
  }
  const btnUpgradeBusiness = document.getElementById('btn-upgrade-business');
  if (btnUpgradeBusiness) {
    btnUpgradeBusiness.addEventListener('click', () => {
      handlePlanUpgrade('business');
    });
  }

  syncWindowStates();
});

// Update bottom system tray clock
function updateClock() {
  const clockEl = document.getElementById('system-clock');
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
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
  
  document.getElementById(`window-${windowId}`).addEventListener('mousedown', () => {
    focusWindow(windowId);
  });
}

// --------------------------------------------------------------------------
// 3. Floating Window Dragging Logic
// --------------------------------------------------------------------------
function initWindowDragging(windowId, dragHandleId) {
  const win = document.getElementById(windowId);
  const handle = document.getElementById(dragHandleId);
  
  let posX = 0, posY = 0, mouseX = 0, mouseY = 0;
  
  handle.onmousedown = dragMouseDown;
  handle.ontouchstart = dragTouchStart;
  
  function dragMouseDown(e) {
    if (e.target.closest('.title-bar-actions')) return;
    if (state.maximizedWindows[windowId]) return;
    
    e = e || window.event;
    e.preventDefault();
    focusWindow(windowId);
    
    mouseX = e.clientX;
    mouseY = e.clientY;
    win.classList.add('dragging');
    
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }
  
  function dragTouchStart(e) {
    if (e.target.closest('.title-bar-actions')) return;
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
    e.preventDefault();
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
    
    posX = mouseX - e.clientX;
    posY = mouseY - e.clientY;
    mouseX = e.clientX;
    mouseY = e.clientY;
    
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
  
  function closeDragElement() {
    win.classList.remove('dragging');
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

function focusWindow(windowId) {
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

  state.minimizedWindows[windowId] = false;
  const win = document.getElementById(`window-${windowId}`);
  if (win) win.classList.add('open');
  
  state.highestZIndex += 1;
  if (win) win.style.zIndex = state.highestZIndex;
  
  document.querySelectorAll('.sys-window').forEach(w => w.classList.remove('focus-active'));
  if (win) win.classList.add('focus-active');
  state.focusedWindow = windowId;
  
  document.querySelectorAll('.taskbar-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById(`tab-${windowId}`);
  if (tab) tab.classList.add('active');
}

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
  
  document.querySelectorAll('.theme-grid .theme-card').forEach(card => card.classList.remove('active'));
  const activeCard = document.getElementById(`theme-card-${themeName}`);
  if (activeCard) activeCard.classList.add('active');
}

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
// 5. SECURITY PORTAL (AUTH MODAL & SESSION CHECKER)
// --------------------------------------------------------------------------
function setupAuthTabs() {
  const tabLogin = document.getElementById('auth-tab-login');
  const tabRegister = document.getElementById('auth-tab-register');
  const tabOtp = document.getElementById('auth-tab-otp');
  
  const contentLogin = document.getElementById('auth-content-login');
  const contentRegister = document.getElementById('auth-content-register');
  const contentOtp = document.getElementById('auth-content-otp');
  const errorMsg = document.getElementById('auth-error-msg');

  const switchTab = (activeTab, showContent) => {
    [tabLogin, tabRegister, tabOtp].forEach(btn => btn.classList.remove('active'));
    [contentLogin, contentRegister, contentOtp].forEach(c => c.style.display = 'none');
    errorMsg.style.display = 'none';
    
    activeTab.classList.add('active');
    showContent.style.display = 'block';

    const firstInput = showContent.querySelector('input');
    if (firstInput) firstInput.focus();
  };

  tabLogin.addEventListener('click', () => switchTab(tabLogin, contentLogin));
  tabRegister.addEventListener('click', () => switchTab(tabRegister, contentRegister));
  tabOtp.addEventListener('click', () => switchTab(tabOtp, contentOtp));

  // Bind register/login actions
  document.getElementById('btn-submit-login').addEventListener('click', handleLogin);
  document.getElementById('btn-submit-register').addEventListener('click', handleRegister);

  // Pre-populate nickname if available
  const authUsernameInput = document.getElementById('auth-username');
  if (authUsernameInput && state.username) {
    authUsernameInput.value = state.username;
  }

  // Bind OTP verify and connect action
  const btnSubmitAuth = document.getElementById('btn-submit-auth');
  if (btnSubmitAuth) {
    btnSubmitAuth.addEventListener('click', () => {
      if (btnSubmitAuth.disabled) return;

      const usernameVal = document.getElementById('auth-username').value.trim();
      const otpVal = document.getElementById('auth-otp').value.trim();
      const errorMsg = document.getElementById('auth-error-msg');

      if (!usernameVal) {
        errorMsg.innerText = 'Nickname is required';
        errorMsg.style.display = 'block';
        return;
      }

      if (!state.joinToken && !otpVal) {
        errorMsg.innerText = 'Join Code is required';
        errorMsg.style.display = 'block';
        return;
      }

      btnSubmitAuth.disabled = true;
      const originalText = btnSubmitAuth.innerText;
      btnSubmitAuth.innerText = 'Connecting...';

      setTimeout(() => {
        btnSubmitAuth.disabled = false;
        btnSubmitAuth.innerText = originalText;
      }, 3000);

      if (usernameVal) {
        state.username = usernameVal;
        safeLocalStorage.setItem('aerosync_username', usernameVal);
      }

      errorMsg.style.display = 'none';
      state.authStatus = 'guestPending';

      // Send join message via websocket with OTP or Join Token
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        if (!state.joinToken) {
          state.otp = otpVal;
        }
        initWebSocket();
      } else {
        if (state.joinToken && state.roomId) {
          sendJoinMessage(null, state.joinToken, state.roomId);
        } else {
          sendJoinMessage(otpVal);
        }
      }
    });
  }
}

async function checkAuthSession() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlRoomId = urlParams.get('roomId');
  const urlJoinToken = urlParams.get('joinToken');

  if (urlRoomId && urlJoinToken) {
    state.roomId = urlRoomId;
    state.joinToken = urlJoinToken;
    state.authStatus = 'guestPending';
    
    // Clean URL query parameters
    window.history.replaceState({}, document.title, window.location.pathname);
    
    // Customize OTP tab for Join Token confirmation
    document.getElementById('auth-overlay').style.display = 'flex';
    const otpTabBtn = document.getElementById('auth-tab-otp');
    if (otpTabBtn) otpTabBtn.click();
    
    // Hide other tabs to keep the user focused on the join invitation
    const loginTab = document.getElementById('auth-tab-login');
    const registerTab = document.getElementById('auth-tab-register');
    if (loginTab) loginTab.style.display = 'none';
    if (registerTab) registerTab.style.display = 'none';
    
    // Customize UI labels
    const otpText = document.querySelector('#auth-content-otp p');
    if (otpText) otpText.innerText = 'You scanned a secure join link! Enter a nickname to connect directly to the session.';
    
    const otpInput = document.getElementById('auth-otp');
    if (otpInput) {
      const group = otpInput.closest('.mb-3') || otpInput.parentElement;
      if (group) group.style.display = 'none';
    }
    
    const submitBtn = document.getElementById('btn-submit-auth');
    if (submitBtn) submitBtn.innerText = 'Join Pairing Session';
    
    initWebSocket();
    return;
  }

  // If localhost, backend auto-authenticates without prompt, but let's sync state
  try {
    const res = await secureFetch('/api/auth/session');
    if (res.ok) {
      const data = await res.json();
      state.currentUser = data.user;
      state.username = data.user.username;
      state.authStatus = 'loggedIn';
      
      const startMenuDevice = document.getElementById('start-menu-device-name');
      if (startMenuDevice) startMenuDevice.innerText = data.user.username;
      
      // Auto-connect websocket signaling
      initWebSocket();
      fetchFiles();
      fetchServerSettings();
      return;
    }
  } catch (err) {
    console.warn('Session fetch failed:', err);
  }

  // Not logged in: Show overlay
  state.authStatus = 'unauthenticated';
  document.getElementById('auth-overlay').style.display = 'flex';
  initWebSocket(); // Start WebSocket connection so OTP authentication can occur!
}

async function handleLogin() {
  const loginInput = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const errorMsg = document.getElementById('auth-error-msg');
  const btn = document.getElementById('btn-submit-login');

  if (btn.disabled) return;

  if (!loginInput || !password) {
    errorMsg.innerText = 'Please enter credentials';
    errorMsg.style.display = 'block';
    return;
  }

  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = 'Signing In...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginInput, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    state.sessionToken = data.sessionToken;
    state.currentUser = data.user;
    state.username = data.user.username;
    safeLocalStorage.setItem('aerosync_session_token', data.sessionToken);

    document.getElementById('auth-overlay').style.display = 'none';
    showToast('Logged in successfully', 'success');

    initWebSocket();
    fetchFiles();
    fetchServerSettings();
  } catch (err) {
    errorMsg.innerText = err.message;
    errorMsg.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
}

async function handleRegister() {
  const email = document.getElementById('reg-email').value;
  const username = document.getElementById('reg-username').value;
  const password = document.getElementById('reg-password').value;
  const errorMsg = document.getElementById('auth-error-msg');
  const btn = document.getElementById('btn-submit-register');

  if (btn.disabled) return;

  if (!email || !username || !password) {
    errorMsg.innerText = 'Please fill in all registration fields';
    errorMsg.style.display = 'block';
    return;
  }

  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = 'Creating Account...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');

    state.sessionToken = data.sessionToken;
    state.currentUser = data.user;
    state.username = data.user.username;
    safeLocalStorage.setItem('aerosync_session_token', data.sessionToken);

    document.getElementById('auth-overlay').style.display = 'none';
    showToast('Registered and logged in successfully', 'success');

    initWebSocket();
    fetchFiles();
    fetchServerSettings();
  } catch (err) {
    errorMsg.innerText = err.message;
    errorMsg.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
}

// --------------------------------------------------------------------------
// 6. ACCESS CONTROL & EXPIRING QR LINKS MODALS
// --------------------------------------------------------------------------
function setupSharingControls() {
  // Share Access Modal elements
  document.getElementById('btn-grant-access').addEventListener('click', grantFileAccess);
  document.getElementById('btn-gen-pub-link').addEventListener('click', generatePublicLink);
  document.getElementById('btn-copy-pub-link').addEventListener('click', () => {
    const linkText = document.getElementById('pub-link-url').innerText;
    copyToClipboard(linkText);
  });

  // Handle QR links explicitly in JS to ensure window.open behaves correctly in all desktop/phone browsers
  const shareQrLink = document.getElementById('share-qr-link');
  if (shareQrLink) {
    shareQrLink.addEventListener('click', (e) => {
      e.preventDefault();
      const href = shareQrLink.getAttribute('href');
      if (href && href !== '#') {
        window.open(href, '_blank');
      }
    });
  }

  const pubQrLink = document.getElementById('pub-qr-link');
  if (pubQrLink) {
    pubQrLink.addEventListener('click', (e) => {
      e.preventDefault();
      const href = pubQrLink.getAttribute('href');
      if (href && href !== '#') {
        window.open(href, '_blank');
      }
    });
  }
}

async function openShareAccessModal(fileId) {
  state.activeShareFileId = fileId;
  document.getElementById('share-email-input').value = '';
  document.getElementById('pub-link-section').style.display = 'none';
  document.getElementById('share-access-overlay').style.display = 'flex';
  
  fetchShareAccessList(fileId);
}

async function fetchShareAccessList(fileId) {
  try {
    const res = await secureFetch(`/api/files/${fileId}/share-info`);
    if (!res.ok) throw new Error('Failed to load sharing info');
    
    const data = await res.json();
    const container = document.getElementById('share-access-list');
    
    if (data.sharedUsers.length === 0) {
      container.innerHTML = `<div class="text-muted small text-center py-2">Only you (owner) have access.</div>`;
      return;
    }

    container.innerHTML = data.sharedUsers.map(user => `
      <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); padding: 6px 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);">
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 11px; font-weight: 500;">${escapeHtml(user.username)}</span>
          <span style="font-size: 9px; color: rgba(255,255,255,0.5);">${escapeHtml(user.email)} (${user.permission})</span>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="revokeFileAccess('${fileId}', '${user.userId}')" style="padding: 2px 6px; font-size: 9px; color: #ff5f5f; border-color: rgba(255,95,95,0.2);">Revoke</button>
      </div>
    `).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function grantFileAccess() {
  const fileId = state.activeShareFileId;
  const email = document.getElementById('share-email-input').value.trim();
  const permission = document.getElementById('share-perm-select').value;

  if (!email) {
    showToast('Please type receiver email address', 'error');
    return;
  }

  try {
    const res = await secureFetch(`/api/files/${fileId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, permission })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to grant sharing access');

    showToast(`Access permission granted successfully!`, 'success');
    document.getElementById('share-email-input').value = '';
    fetchShareAccessList(fileId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function revokeFileAccess(fileId, userId) {
  try {
    const res = await secureFetch(`/api/files/${fileId}/share/${userId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to revoke access');

    showToast('Access revoked successfully', 'info');
    fetchShareAccessList(fileId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function generatePublicLink() {
  const fileId = state.activeShareFileId;
  const expiresInHours = document.getElementById('pub-expiry-select').value;
  const permission = document.getElementById('pub-permission-select').value;

  try {
    const res = await secureFetch(`/api/files/${fileId}/share-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInHours, permission })
    });

    const data = await res.json();
    if (!res.ok) throw new Error('Failed to generate public share token');

    const downloadUrl = `${location.protocol}//${location.host}/share/${data.token}`;
    document.getElementById('pub-link-url').innerText = downloadUrl;
    document.getElementById('pub-link-section').style.display = 'block';

    // Generate QR Code onto canvas
    const qrCanvas = document.getElementById('pub-qr-canvas');
    new QRious({
      element: qrCanvas,
      value: downloadUrl,
      size: 120
    });
    
    // Set href of public QR link to make it clickable
    const qrLink = document.getElementById('pub-qr-link');
    if (qrLink) qrLink.href = downloadUrl;

    showToast('Expiring public share link generated!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// 7. AUDIT LOGS DISPLAY
// --------------------------------------------------------------------------
async function openAuditLogsModal(fileId) {
  document.getElementById('audit-logs-overlay').style.display = 'flex';
  const tbody = document.getElementById('audit-logs-tbody');
  tbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #888;">Loading logs...</td></tr>`;

  try {
    const res = await secureFetch(`/api/files/${fileId}/logs`);
    if (!res.ok) throw new Error('Failed to load audit logs');
    
    const logs = await res.json();
    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #888;">No audit logs recorded for this file.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
        <td style="padding: 8px;">${escapeHtml(l.userEmail)}</td>
        <td style="padding: 8px;"><span class="badge ${getLogActionClass(l.action)}">${l.action.toUpperCase()}</span></td>
        <td style="padding: 8px; color: rgba(255,255,255,0.7);">${escapeHtml(l.details)}</td>
        <td style="padding: 8px; color: rgba(255,255,255,0.4);">${new Date(l.timestamp).toLocaleString()}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #ff5f5f;">Error loading logs: ${err.message}</td></tr>`;
  }
}

function getLogActionClass(action) {
  switch (action) {
    case 'upload': return 'bg-success';
    case 'download': return 'bg-primary';
    case 'share': return 'bg-info';
    case 'delete': return 'bg-danger';
    default: return 'bg-secondary';
  }
}

// --------------------------------------------------------------------------
// 8. REST FILE SYNCS & LISTINGS
// --------------------------------------------------------------------------
function switchExplorerTab(tabName) {
  state.activeExplorerTab = tabName;
  document.getElementById('explorer-tab-myfiles').classList.toggle('active', tabName === 'myfiles');
  document.getElementById('explorer-tab-shared').classList.toggle('active', tabName === 'shared');
  renderFileList();
}

async function fetchFiles() {
  const btn = document.getElementById('btn-refresh-files');
  let icon = null;
  if (btn) {
    icon = btn.querySelector('i');
    if (icon) icon.classList.add('bi-spin-animate');
    btn.disabled = true;
  }
  
  // Refresh plan status
  fetchUserBillingPlan();

  try {
    const res = await secureFetch('/api/files');
    if (!res.ok) throw new Error('Files load failed');
    const data = await res.json();
    state.myFiles = data.myFiles || [];
    state.sharedWithMe = data.sharedWithMe || [];
    renderFileList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      if (icon) setTimeout(() => icon.classList.remove('bi-spin-animate'), 500);
    }
  }
}

function renderFileList() {
  const tbody = document.getElementById('file-table-body');
  const countBadge = document.getElementById('sidebar-file-count');
  
  let listToRender = [];
  if (state.activeExplorerTab === 'myfiles') {
    listToRender = [...state.myFiles];
    // Add virtual file entry for immediate feedback during active local/cloud uploads
    state.transfers.forEach(tx => {
      if (tx.status === 'uploading' || tx.status === 'paused' || tx.status === 'assembling') {
        listToRender.push({
          id: `virtual-${tx.id}`,
          name: tx.name,
          size: tx.size,
          mimeType: 'uploading',
          created_at: Date.now(),
          isVirtual: true,
          progress: tx.progress,
          status: tx.status
        });
      }
    });
    countBadge.innerText = state.myFiles.length;
  } else {
    listToRender = [...state.sharedWithMe];
    countBadge.innerText = state.sharedWithMe.length;
  }
  
  const filtered = listToRender.filter(f => f.name.toLowerCase().includes(state.searchQuery));
  
  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-table-row">
        <td colspan="4" class="text-center text-muted py-5">
          <i class="bi bi-folder-x display-4 d-block mb-3"></i>
          No files in this directory. Drag & drop files here to upload.
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = filtered.map(file => {
    const formattedSize = formatBytes(file.size);
    const dateFormatted = file.isVirtual ? 'In progress...' : new Date(file.created_at || file.uploadedAt).toLocaleString();
    
    let actionHtml = '';
    if (file.isVirtual) {
      actionHtml = `
        <span id="file-badge-${file.id}" class="badge bg-primary-gradient px-2 py-1" style="font-size: 10px; background: var(--btn-primary-bg); color: white; border-radius: 4px;">
          ${file.status === 'assembling' ? 'Assembling...' : `${file.progress.toFixed(0)}%`}
        </span>
      `;
    } else {
      if (state.activeExplorerTab === 'myfiles') {
        actionHtml = `
          <div class="d-flex justify-content-center gap-1">
            <a href="/api/files/${file.id}/download?sessionToken=${state.sessionToken}" class="btn btn-secondary btn-sm p-1" style="padding: 2px 4px; font-size: 10px;" title="Download File">
              <i class="bi bi-download"></i>
            </a>
            <button class="btn btn-secondary btn-sm p-1" onclick="openShareAccessModal('${file.id}')" style="padding: 2px 4px; font-size: 10px; color: var(--accent);" title="Access Permissions">
              <i class="bi bi-share"></i>
            </button>
            <button class="btn btn-secondary btn-sm p-1" onclick="openAuditLogsModal('${file.id}')" style="padding: 2px 4px; font-size: 10px;" title="Audit Logs">
              <i class="bi bi-card-list"></i>
            </button>
            <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="deleteFileFromServer('${file.id}')" style="padding: 2px 4px; font-size: 10px;" title="Delete File">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        `;
      } else {
        // Shared with me list
        const canDownload = file.permission === 'download';
        actionHtml = `
          <div class="d-flex justify-content-center gap-1">
            ${canDownload ? `
              <a href="/api/files/${file.id}/download?sessionToken=${state.sessionToken}" class="btn btn-secondary btn-sm p-1" style="padding: 2px 4px; font-size: 10px;" title="Download File">
                <i class="bi bi-download"></i>
              </a>
            ` : `
              <button class="btn btn-secondary btn-sm p-1" style="padding: 2px 4px; font-size: 10px; opacity: 0.5;" title="Download Disabled (View Only)" disabled>
                <i class="bi bi-download"></i>
              </button>
            `}
          </div>
        `;
      }
    }
    
    const iconClass = file.storage_type === 'cloud' ? 'bi-cloud-check text-accent' : 'bi-file-earmark-code text-accent';
    const rowTitle = state.activeExplorerTab === 'shared' ? `Owner: ${file.ownerEmail}` : '';

    return `
      <tr class="${file.isVirtual ? 'uploading-row-flash' : ''}" title="${rowTitle}">
        <td>
          <i class="bi ${file.isVirtual ? 'bi-cloud-arrow-up animate-pulse' : iconClass} me-2"></i>
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
  const file = state.files.find(f => f.id === fileId);
  if (!file) return;

  const overlay = document.getElementById('delete-confirm-overlay');
  const fileNameEl = document.getElementById('delete-confirm-file-name');
  const fileSizeEl = document.getElementById('delete-confirm-file-size');
  
  if (fileNameEl) fileNameEl.innerText = file.name;
  if (fileSizeEl) fileSizeEl.innerText = formatBytes(file.size);
  if (overlay) overlay.style.display = 'flex';

  const btnConfirm = document.getElementById('btn-confirm-delete');
  const btnCancel = document.getElementById('btn-cancel-delete');

  const newBtnConfirm = btnConfirm.cloneNode(true);
  btnConfirm.replaceWith(newBtnConfirm);
  const newBtnCancel = btnCancel.cloneNode(true);
  btnCancel.replaceWith(newBtnCancel);

  newBtnCancel.addEventListener('click', () => {
    if (overlay) overlay.style.display = 'none';
  });

  newBtnConfirm.addEventListener('click', async () => {
    if (newBtnConfirm.disabled) return;
    newBtnConfirm.disabled = true;
    const originalText = newBtnConfirm.innerText;
    newBtnConfirm.innerText = 'Deleting...';
    try {
      const res = await secureFetch(`/api/files/${fileId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Delete file failed');
      if (overlay) overlay.style.display = 'none';
      showToast('File deleted successfully', 'success');
      fetchFiles();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      newBtnConfirm.disabled = false;
      newBtnConfirm.innerText = originalText;
    }
  });
}

async function fetchServerSettings() {
  try {
    const res = await secureFetch('/api/settings');
    if (!res.ok) throw new Error('Settings load failed');
    const settings = await res.json();
    
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
    
    // Update start menu subtitle
    const startMenuSubtitle = document.getElementById('start-menu-subtitle');
    if (startMenuSubtitle) {
      startMenuSubtitle.innerText = settings.publicTunnelUrl ? 'Public Tunnel Active' : 'LAN Sharing Mode';
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
    const res = await secureFetch('/api/settings', {
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
    sendJoinMessage();
    showToast('Profile settings updated successfully!', 'success');
  }
}

// --------------------------------------------------------------------------
// 9. ADVANCED DOUBLE-MODE UPLOAD ENGINE
// --------------------------------------------------------------------------
function setupDragAndDrop() {
  const zone = document.getElementById('desktop-area');
  const overlay = document.getElementById('drag-drop-zone');
  
  let counter = 0;
  
  window.addEventListener('dragover', (e) => e.preventDefault(), false);
  window.addEventListener('drop', (e) => e.preventDefault(), false);
  
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    counter++;
    overlay.classList.add('drag-hover');
    openWindow('files');
  });
  
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    counter--;
    if (counter === 0) overlay.classList.remove('drag-hover');
  });
  
  zone.addEventListener('dragover', (e) => e.preventDefault());
  
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    counter = 0;
    overlay.classList.remove('drag-hover');
    handleFileUploads(e.dataTransfer.files);
  });
}

async function calculateSHA256(fileOrBlob) {
  try {
    const buffer = await fileOrBlob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.error('SHA-256 calculation failed:', err);
    return null;
  }
}

// --------------------------------------------------------------------------
// PERSISTENT RESUME / PAUSE STORAGE (INDEXEDDB)
// --------------------------------------------------------------------------
const DB_NAME = 'aerosync_transfers_db';
const STORE_NAME = 'progress';

function initIndexedDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = () => {
      showToast('IndexedDB storage failed. Using memory fallback.', 'warning');
      resolve(null);
    };
  });
}

const idbPromise = initIndexedDB();

async function saveProgress(transferId, progressData) {
  const db = await idbPromise;
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(progressData, transferId);
  } catch (err) {
    console.warn('IDB write failed:', err);
  }
}

async function getProgress(transferId) {
  const db = await idbPromise;
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(transferId);
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = () => resolve(null);
    } catch (err) {
      resolve(null);
    }
  });
}

async function deleteProgress(transferId) {
  const db = await idbPromise;
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(transferId);
  } catch (err) {
    console.warn('IDB delete failed:', err);
  }
}

// --------------------------------------------------------------------------
// WEBRTC CONNECTION STATS COLLECTOR
// --------------------------------------------------------------------------
async function updateConnectionType(pc, transfer) {
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const stats = await pc.getStats();
    let activePair = null;
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        activePair = report;
      }
    });
    if (activePair) {
      const localCandidate = stats.get(activePair.localCandidateId);
      const remoteCandidate = stats.get(activePair.remoteCandidateId);
      if (localCandidate && remoteCandidate) {
        if (localCandidate.candidateType === 'relay' || remoteCandidate.candidateType === 'relay') {
          transfer.connectionType = 'Relayed';
        } else {
          const isPrivateIP = (ip) => {
            if (!ip) return false;
            return ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.') || ip.startsWith('172.23.') || ip.startsWith('172.24.') || ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') || ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') || ip.startsWith('172.31.');
          };
          if (isPrivateIP(localCandidate.ip) && isPrivateIP(remoteCandidate.ip)) {
            transfer.connectionType = 'LAN';
          } else {
            transfer.connectionType = 'Direct P2P';
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to get connection stats:', err);
  }
}

function handleFileUploads(fileList) {
  if (fileList.length === 0) return;
  
  // Check active transfer mode radio button (Fast LAN vs Private Cloud)
  const modeVal = document.querySelector('input[name="transfer-mode-select"]:checked').value;

  for (const file of fileList) {
    if (modeVal === 'cloud') {
      initiateCloudUpload(file);
    } else {
      initiateLocalUpload(file);
    }
  }
  
  openWindow('transfers');
}

function getOptimalChunkSize(fileSize) {
  if (fileSize > 500 * 1024 * 1024) return 50 * 1024 * 1024;
  if (fileSize > 150 * 1024 * 1024) return 32 * 1024 * 1024;
  if (fileSize > 50 * 1024 * 1024) return 16 * 1024 * 1024;
  return 4 * 1024 * 1024; // standard 4MB chunk
}

// --------------------------------------------------------
// LOCAL LAN MODE UPLOAD
// --------------------------------------------------------
async function initiateLocalUpload(file) {
  // Generate deterministic upload ID based on file metadata to support pause/resume across sessions
  const fileHashKey = btoa(file.name + '-' + file.size + '-' + file.lastModified).replace(/=/g, '').slice(-32);
  const uploadId = 'up-local-' + fileHashKey;
  
  const CHUNK_SIZE = getOptimalChunkSize(file.size);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  const transfer = {
    id: uploadId,
    name: file.name,
    size: file.size,
    type: 'Upload (LAN)',
    progress: 0,
    speed: 0,
    eta: 'Calculating checksum...',
    status: 'hashing',
    paused: false,
    chunksSent: [],
    totalChunks,
    concurrency: 4,
    file,
    chunkSize: CHUNK_SIZE,
    activeXHRs: new Map(),
    activeXHRInstances: new Map(),
    bytesLastLoaded: 0,
    timeLastCheck: Date.now()
  };
  
  state.transfers.set(uploadId, transfer);
  updateTransferCountBadge();
  renderTransferQueue();
  renderFileList();

  const clientHash = await calculateSHA256(file);
  transfer.hash = clientHash;
  transfer.status = 'uploading';
  transfer.eta = 'Connecting...';
  renderTransferQueue();

  // Restore saved chunksSent progress
  try {
    const saved = await getProgress(uploadId);
    if (saved && saved.chunksSent) {
      transfer.chunksSent = saved.chunksSent;
    }
    const statusRes = await secureFetch(`/api/transfer/upload/status/${uploadId}`);
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData.completedChunks) {
        transfer.chunksSent = Array.from(new Set([...transfer.chunksSent, ...statusData.completedChunks]));
      }
    }
  } catch (err) {
    console.warn('Failed to restore upload progress:', err);
  }
  
  transfer.progress = (transfer.chunksSent.length / totalChunks) * 100;
  
  try {
    const initRes = await secureFetch('/api/transfer/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        name: file.name,
        size: file.size,
        totalChunks,
        clientHash
      })
    });
    
    if (!initRes.ok) {
      const errData = await initRes.json().catch(() => ({}));
      if (errData.code === 'QUOTA_EXCEEDED' || (errData.error && errData.error.includes('limit is reached'))) {
        alert('Your storage limit is reached. Upgrade your plan to continue.');
        toggleWindow('billing');
      }
      throw new Error(errData.error || 'Init local upload session failed');
    }
    const initData = await initRes.json();
    transfer.chunksSent = initData.completedChunks || [];
    
    uploadNextChunks(transfer, '/api/transfer/upload/chunk/raw');
  } catch (err) {
    transfer.status = 'failed';
    showToast(`LAN Upload failed: ${err.message}`, 'error');
    renderTransferQueue();
  }
}

// --------------------------------------------------------
// PRIVATE CLOUD MODE MULTIPART UPLOAD
// --------------------------------------------------------
async function initiateCloudUpload(file) {
  // Generate deterministic upload ID based on file metadata to support pause/resume across sessions
  const fileHashKey = btoa(file.name + '-' + file.size + '-' + file.lastModified).replace(/=/g, '').slice(-32);
  const uploadId = 'up-cloud-' + fileHashKey;
  
  const CHUNK_SIZE = getOptimalChunkSize(file.size);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  const transfer = {
    id: uploadId,
    name: file.name,
    size: file.size,
    type: 'Upload (Cloud)',
    progress: 0,
    speed: 0,
    eta: 'Calculating checksum...',
    status: 'hashing',
    paused: false,
    chunksSent: [],
    totalChunks,
    concurrency: 3,
    file,
    chunkSize: CHUNK_SIZE,
    activeXHRs: new Map(),
    activeXHRInstances: new Map(),
    bytesLastLoaded: 0,
    timeLastCheck: Date.now(),
    uploadUrls: [],
    fileId: null
  };
  
  state.transfers.set(uploadId, transfer);
  updateTransferCountBadge();
  renderTransferQueue();
  renderFileList();

  const clientHash = await calculateSHA256(file);
  transfer.hash = clientHash;
  transfer.status = 'uploading';
  transfer.eta = 'Creating session...';
  renderTransferQueue();

  // Restore saved chunksSent progress
  try {
    const saved = await getProgress(uploadId);
    if (saved && saved.chunksSent) {
      transfer.chunksSent = saved.chunksSent;
    }
    const statusRes = await secureFetch(`/api/transfer/upload/status/${uploadId}`);
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData.completedChunks) {
        transfer.chunksSent = Array.from(new Set([...transfer.chunksSent, ...statusData.completedChunks]));
      }
    }
  } catch (err) {
    console.warn('Failed to restore upload progress:', err);
  }
  
  transfer.progress = (transfer.chunksSent.length / totalChunks) * 100;
  
  try {
    const initRes = await secureFetch('/api/transfer/upload/init-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        name: file.name,
        size: file.size,
        totalChunks,
        clientHash
      })
    });
    
    if (!initRes.ok) {
      const errData = await initRes.json().catch(() => ({}));
      if (errData.code === 'QUOTA_EXCEEDED' || (errData.error && errData.error.toLowerCase().includes('limit is reached') || errData.error.toLowerCase().includes('quota exceeded'))) {
        alert('Your cloud storage limit is reached. Upgrade your plan to continue.');
        toggleWindow('billing');
      }
      throw new Error(errData.error || 'Init cloud upload session failed');
    }
    const initData = await initRes.json();
    
    transfer.fileId = initData.fileId;
    transfer.uploadUrls = initData.uploadUrls; // List of presigned put URLs
    
    uploadNextChunks(transfer, null); // Signed cloud uploads bypass default server route URL
  } catch (err) {
    transfer.status = 'failed';
    showToast(`Cloud Upload failed: ${err.message}`, 'error');
    renderTransferQueue();
  }
}

async function uploadNextChunks(transfer, defaultRoute) {
  if (transfer.paused || transfer.status !== 'uploading') return;
  
  if (!transfer.activeUploads) transfer.activeUploads = 0;
  
  const CONCURRENCY = transfer.concurrency;
  const busyChunks = new Set(transfer.chunksSent);
  transfer.activeXHRs.forEach((_, idx) => busyChunks.add(idx));
  
  const chunksToStart = [];
  for (let i = 0; i < transfer.totalChunks; i++) {
    if (!busyChunks.has(i)) {
      chunksToStart.push(i);
      busyChunks.add(i);
      if (chunksToStart.length + transfer.activeUploads >= CONCURRENCY) break;
    }
  }
  
  if (transfer.activeUploads === 0 && transfer.chunksSent.length === transfer.totalChunks) {
    finalizeUploadAssembly(transfer);
    return;
  }
  
  chunksToStart.forEach((chunkIndex) => {
    startMultipartUpload(transfer, chunkIndex, defaultRoute);
  });
}

function startMultipartUpload(transfer, chunkIndex, defaultRoute) {
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
        let totalUploadedBytes = transfer.chunksSent.length * transfer.chunkSize;
        transfer.activeXHRs.forEach((loaded) => { totalUploadedBytes += loaded; });
        
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
      
      let totalUploadedBytes = transfer.chunksSent.length * transfer.chunkSize;
      transfer.activeXHRs.forEach((loaded) => { totalUploadedBytes += loaded; });
      const progressPercent = Math.min((totalUploadedBytes / transfer.size) * 100, 99.9);
      
      transfer.progress = progressPercent;
      updateTransferItemUI(transfer.id);
    }
  };
  
  xhr.onload = () => {
    transfer.activeUploads--;
    transfer.activeXHRs.delete(chunkIndex);
    transfer.activeXHRInstances.delete(chunkIndex);
    
    if (xhr.status === 200 && transfer.status === 'uploading') {
      if (!transfer.chunksSent.includes(chunkIndex)) {
        transfer.chunksSent.push(chunkIndex);
      }
      saveProgress(transfer.id, { chunksSent: transfer.chunksSent });
      uploadNextChunks(transfer, defaultRoute);
    } else if (transfer.status === 'uploading') {
      transfer.status = 'failed';
      showToast(`Upload failed on part block ${chunkIndex}`, 'error');
      renderTransferQueue();
    }
  };
  
  xhr.onerror = () => {
    transfer.activeUploads--;
    transfer.activeXHRs.delete(chunkIndex);
    transfer.activeXHRInstances.delete(chunkIndex);
    
    if (transfer.status === 'uploading') {
      transfer.status = 'failed';
      showToast('Network error on multipart transfer', 'error');
      renderTransferQueue();
    }
  };
  
  // Decide target route (Cloud puts direct to simulated S3, LAN uses raw chunk API)
  if (defaultRoute) {
    // Local LAN Mode chunk
    xhr.open('POST', defaultRoute);
    xhr.setRequestHeader('X-Session-Token', state.sessionToken);
    xhr.setRequestHeader('X-Client-Id', state.clientId);
    xhr.setRequestHeader('X-Upload-Id', transfer.id);
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(chunkBlob);
  } else {
    // Private Cloud Mode: PUT chunk directly to pre-signed cloud URL signature
    const signedUrl = transfer.uploadUrls[chunkIndex];
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(chunkBlob);
  }
}

async function finalizeUploadAssembly(transfer) {
  transfer.status = 'assembling';
  transfer.speed = 0;
  transfer.eta = 'Finalizing file...';
  updateTransferItemUI(transfer.id);
  
  try {
    let res;
    if (transfer.type === 'Upload (Cloud)') {
      // Cloud multipart assembly completion
      res = await secureFetch('/api/transfer/upload/complete-cloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: transfer.fileId,
          uploadId: transfer.id
        })
      });
    } else {
      // Local LAN assembly completion
      res = await secureFetch('/api/transfer/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId: transfer.id
        })
      });
    }
    
    if (!res.ok) throw new Error('File assembly completion failed');
    const resData = await res.json().catch(() => ({}));
    const fileId = resData.fileId;
    deleteProgress(transfer.id);
    
    transfer.status = 'completed';
    transfer.progress = 100;
    transfer.eta = 'Done';
    showToast(`File ${transfer.name} uploaded successfully!`, 'success');
    
    // Notify peer if P2P fallback upload
    if (transfer.fallbackTargetId && fileId) {
      sendSignal(transfer.fallbackTargetId, {
        type: 'p2p-fallback-ready',
        name: transfer.name,
        fileId: fileId
      });
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
    renderFileList();
  } else if (transfer.status === 'paused') {
    transfer.paused = false;
    transfer.status = 'uploading';
    transfer.timeLastCheck = Date.now();
    transfer.bytesLastLoaded = 0;
    
    const route = transfer.type === 'Upload (Cloud)' ? null : '/api/transfer/upload/chunk/raw';
    uploadNextChunks(transfer, route);
    
    showToast(`Resuming upload: ${transfer.name}`, 'info');
    renderTransferQueue();
    renderFileList();
  }
}

// --------------------------------------------------------------------------
// 10. WebRTC P2P direct transfer
// --------------------------------------------------------------------------
function closePeerConnection(clientId) {
  const pc = state.peerConnections.get(clientId);
  if (pc) {
    try { pc.close(); } catch(e) {}
    state.peerConnections.delete(clientId);
  }
  state.iceCandidateQueues.delete(clientId);
}

function handleWebRTCFailure(peerId, transferId, errorMessage) {
  const transfer = state.transfers.get(transferId);
  if (transfer && transfer.status !== 'completed' && transfer.status !== 'failed') {
    closePeerConnection(peerId);
    
    if (transfer.type === 'Upload (P2P)') {
      // Auto fallback to local server chunked upload
      initiateP2PFallbackUpload(transfer, peerId);
    } else if (transfer.type === 'Download (P2P)') {
      transfer.status = 'connecting';
      transfer.eta = 'Waiting fallback...';
      renderTransferQueue();
      showToast('P2P failed. Waiting for server relay fallback...', 'info');
    } else {
      transfer.status = 'failed';
      transfer.eta = 'Failed';
      renderTransferQueue();
      updateTransferCountBadge();
    }
  }
}

async function initiateP2PFallbackUpload(transfer, peerId) {
  const file = transfer.file;
  if (!file) return;

  showToast(`P2P failed. Sending ${file.name} via server fallback...`, 'info');
  
  transfer.type = 'Upload (LAN)';
  transfer.status = 'uploading';
  transfer.progress = 0;
  transfer.speed = 0;
  transfer.eta = 'Starting upload fallback...';
  transfer.fallbackTargetId = peerId;
  transfer.peerId = peerId;
  
  transfer.chunkSize = getOptimalChunkSize(file.size);
  transfer.totalChunks = Math.ceil(file.size / transfer.chunkSize);
  transfer.chunksSent = [];
  transfer.bytesLastLoaded = 0;
  transfer.timeLastCheck = Date.now();
  
  renderTransferQueue();
  renderFileList();
  
  try {
    const initRes = await secureFetch('/api/transfer/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        totalChunks: transfer.totalChunks,
        uploadId: transfer.id,
        receiverClientId: peerId
      })
    });
    
    if (!initRes.ok) throw new Error('Init fallback upload failed');
    uploadNextChunks(transfer, '/api/transfer/upload/chunk/raw');
  } catch (err) {
    transfer.status = 'failed';
    transfer.eta = 'Fallback upload failed';
    showToast(`Fallback upload failed: ${err.message}`, 'error');
    renderTransferQueue();
  }
}

function sendSignal(targetId, data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'signal',
      targetId,
      data
    }));
  }
}

async function handleIncomingSignal(senderId, signal) {
  const peer = state.peers.get(senderId);
  const senderName = peer ? peer.username : 'Unknown Peer';
  
  switch (signal.type) {
    case 'file-invite':
      state.pendingInvite = {
        senderId,
        transferId: signal.transferId,
        fileName: signal.name,
        fileSize: signal.size,
        fileType: signal.mimeType,
        fileHash: signal.fileHash
      };
      
      document.getElementById('prompt-peer-name').innerText = senderName;
      document.getElementById('prompt-file-name').innerText = signal.name;
      document.getElementById('prompt-file-size').innerText = formatBytes(signal.size);
      document.getElementById('p2p-prompt-overlay').style.display = 'flex';
      
      document.getElementById('btn-accept-transfer').onclick = acceptIncomingP2P;
      document.getElementById('btn-decline-transfer').onclick = declineIncomingP2P;
      break;
      
    case 'file-decline':
      showToast(`${senderName} declined your transfer request`, 'error');
      const failedTx = state.transfers.get(signal.transferId);
      if (failedTx) {
        failedTx.status = 'failed';
        failedTx.eta = 'Declined';
        renderTransferQueue();
        renderFileList();
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
        const queue = state.iceCandidateQueues.get(senderId) || [];
        for (const candidate of queue) {
          try {
            if (candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error("Early candidate err:", e);
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
          console.error("ICE candidate err:", e);
        }
      } else {
        if (!state.iceCandidateQueues.has(senderId)) state.iceCandidateQueues.set(senderId, []);
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
      
      // Auto-trigger the fallback download with session token
      const downloadUrl = `/api/files/${signal.fileId}/download?sessionToken=${state.sessionToken}`;
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = signal.name;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      
      showToast(`P2P failed. Downloaded ${signal.name} via server relay.`, 'success');
      break;
 
    case 'p2p-cancel':
      if (state.pendingInvite && state.pendingInvite.transferId === signal.transferId) {
        document.getElementById('p2p-prompt-overlay').style.display = 'none';
        state.pendingInvite = null;
      }
      cancelTransfer(signal.transferId, true);
      break;
  }
}

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

async function acceptIncomingP2P() {
  document.getElementById('p2p-prompt-overlay').style.display = 'none';
  if (!state.pendingInvite) return;
  
  const invite = state.pendingInvite;
  state.pendingInvite = null;
  const transferId = invite.transferId;
  
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
    fileHash: invite.fileHash,
    startTime: Date.now()
  };
  
  transfer.timeoutRef = setTimeout(() => {
    if (transfer.status === 'connecting' || (transfer.status === 'downloading' && transfer.receivedBytes === 0)) {
      handleWebRTCFailure(invite.senderId, transferId, 'Timed out');
    }
  }, 12000);
  
  state.transfers.set(transferId, transfer);
  openWindow('transfers');
  updateTransferCountBadge();
  renderTransferQueue();
  
  sendSignal(invite.senderId, { type: 'file-accept', transferId });
  state.rxTransferContext = { transferId, invite };
}

async function startSenderPeerConnection(targetId, transferId) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) return;
  
  transfer.status = 'connecting';
  transfer.peerId = targetId;
  transfer.eta = 'Connecting...';
  renderTransferQueue();
  
  const connectionTimeout = setTimeout(() => {
    if (transfer.status === 'connecting' || transfer.status === 'pending-invite') {
      handleWebRTCFailure(targetId, transferId, 'Timed out');
    }
  }, 12000);
  
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  state.peerConnections.set(targetId, pc);
  
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      clearTimeout(connectionTimeout);
      handleWebRTCFailure(targetId, transferId, 'Failed');
    }
  };
  
  const dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
  dataChannel.binaryType = 'arraybuffer';
  transfer.dataChannel = dataChannel;
  
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(targetId, { type: 'candidate', candidate: event.candidate });
  };
  
  dataChannel.onopen = () => {
    clearTimeout(connectionTimeout);
    transfer.status = 'uploading';
    transfer.startTime = Date.now();
    transmitP2PFile(transfer, targetId);
  };
  
  dataChannel.onclose = () => {
    clearTimeout(connectionTimeout);
    if (transfer.status === 'uploading' || transfer.status === 'connecting') {
      transfer.status = 'paused';
      transfer.eta = 'Paused';
      showToast('Receiver disconnected. Transfer paused.', 'warning');
      renderTransferQueue();
    }
    closePeerConnection(targetId);
  };
  
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(targetId, { type: 'offer', sdp: offer, transferId });
}

function transmitP2PFile(transfer, targetId) {
  const channel = transfer.dataChannel;
  const file = transfer.file;
  
  let CHUNK_SIZE = 64 * 1024;
  const BLOCK_SIZE = 4 * 1024 * 1024;
  const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
  const LOW_BUFFERED_AMOUNT = 2 * 1024 * 1024;
  const PUMP_INTERVAL_MS = 5;
  let offset = 0;
  let bytesTransmitted = 0;
  let bytesLastSent = 0;
  let timeLastCheck = Date.now();
  
  channel.bufferedAmountLowThreshold = LOW_BUFFERED_AMOUNT;
  
  channel.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.type === 'transfer_cancel') {
        cancelTransfer(payload.transferId, true);
      }
    } catch (err) {}
  };
  
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
  
  let nextBlockPromise = readNextBlock();
  
  async function fillAndSend() {
    if (isSending) return;
    isSending = true;
    
    const loopStart = Date.now();
    try {
      while (true) {
        const tx = state.transfers.get(transfer.id);
        if (!tx || tx.status !== 'uploading' || tx.status === 'cancelled') {
          isSending = false;
          if (transfer.watchdogInterval) clearInterval(transfer.watchdogInterval);
          return;
        }
        if (channel.readyState !== 'open') {
          isSending = false;
          return;
        }
        if (channel.bufferedAmount >= MAX_BUFFERED_AMOUNT) {
          isSending = false;
          return;
        }
        
        if (!currentBlock || blockOffset >= currentBlock.byteLength) {
          const nextBlock = await nextBlockPromise;
          if (!nextBlock) {
            if (transfer.watchdogInterval) clearInterval(transfer.watchdogInterval);
            setTimeout(() => {
              if (channel.readyState === 'open') {
                channel.send(JSON.stringify({ type: 'tx-done' }));
                transfer.status = 'completed';
                transfer.eta = 'Done';
                showToast(`P2P Send completed`, 'success');
                renderTransferQueue();
                updateTransferCountBadge();
              }
            }, 500);
            isSending = false;
            return;
          }
          currentBlock = nextBlock;
          blockOffset = 0;
          nextBlockPromise = readNextBlock();
        }
        
        const sliceEnd = Math.min(blockOffset + CHUNK_SIZE, currentBlock.byteLength);
        const sliceSize = sliceEnd - blockOffset;
        const view = new Uint8Array(currentBlock, blockOffset, sliceSize);
        blockOffset = sliceEnd;
        bytesTransmitted += sliceSize;
        
        channel.send(view);
        
        const now = Date.now();
        const duration = (now - timeLastCheck) / 1000;
        if (duration >= 0.5) {
          const currentSpeed = (bytesTransmitted - bytesLastSent) / duration;
          transfer.speed = currentSpeed;
          timeLastCheck = now;
          bytesLastSent = bytesTransmitted;
          const remaining = file.size - bytesTransmitted;
          transfer.eta = currentSpeed > 0 ? formatETA(remaining / currentSpeed) : 'Calculating...';
        }
        
        transfer.progress = (bytesTransmitted / file.size) * 100;
        updateTransferItemUI(transfer.id);
        
        if (Date.now() - loopStart > 12) {
          isSending = false;
          setTimeout(fillAndSend, 0);
          return;
        }
      }
    } catch (err) {
      console.error('P2P Send error:', err);
      isSending = false;
    }
  }
  
  channel.onbufferedamountlow = () => fillAndSend();
  
  const watchdog = setInterval(() => {
    if (!state.transfers.has(transfer.id) || channel.readyState !== 'open' || transfer.status !== 'uploading') {
      clearInterval(watchdog);
      if (transfer.statsInterval) clearInterval(transfer.statsInterval);
      return;
    }
    if (channel.bufferedAmount < LOW_BUFFERED_AMOUNT) fillAndSend();
  }, PUMP_INTERVAL_MS);
  transfer.watchdogInterval = watchdog;

  const statsInterval = setInterval(async () => {
    if (!state.transfers.has(transfer.id) || transfer.status !== 'uploading') {
      clearInterval(statsInterval);
      return;
    }
    const pc = state.peerConnections.get(targetId);
    if (pc) {
      await updateConnectionType(pc, transfer);
      if (transfer.connectionType === 'LAN') {
        CHUNK_SIZE = 128 * 1024;
      } else if (transfer.connectionType === 'Relayed') {
        CHUNK_SIZE = 16 * 1024;
      } else {
        CHUNK_SIZE = 64 * 1024;
      }
      updateTransferItemUI(transfer.id);
    }
  }, 1000);
  transfer.statsInterval = statsInterval;
  
  fillAndSend();
}

async function setupReceiverPeerConnection(senderId, sdpOffer, transferId) {
  const context = state.rxTransferContext;
  if (!context || context.invite.senderId !== senderId) return;
  
  const transfer = state.transfers.get(context.transferId);
  if (!transfer) return;
  
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  state.peerConnections.set(senderId, pc);
  
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      clearTimeout(transfer.timeoutRef);
      handleWebRTCFailure(senderId, transferId, 'Failed');
    }
  };
  
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(senderId, { type: 'candidate', candidate: event.candidate });
  };
  
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    transfer.dataChannel = channel;
    let bytesLastCheck = 0;
    let timeLastCheck = Date.now();
    
    channel.onopen = () => clearTimeout(transfer.timeoutRef);
    
    channel.onclose = () => {
      clearTimeout(transfer.timeoutRef);
      if (transfer.status === 'downloading' || transfer.status === 'connecting') {
        transfer.status = 'paused';
        transfer.eta = 'Paused';
        showToast('Sender disconnected. Transfer paused.', 'warning');
        renderTransferQueue();
      }
      if (transfer.statsInterval) clearInterval(transfer.statsInterval);
      closePeerConnection(senderId);
    };
    
    transfer.status = 'downloading';
    transfer.startTime = Date.now();

    const statsInterval = setInterval(async () => {
      if (!state.transfers.has(transfer.id) || transfer.status !== 'downloading') {
        clearInterval(statsInterval);
        return;
      }
      await updateConnectionType(pc, transfer);
      updateTransferItemUI(transfer.id);
    }, 1000);
    transfer.statsInterval = statsInterval;
    
    channel.onmessage = (e) => {
      clearTimeout(transfer.timeoutRef);
      if (typeof e.data === 'string') {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'tx-done') {
            const blob = new Blob(transfer.buffers, { type: context.invite.fileType || 'application/octet-stream' });
            
            transfer.status = 'assembling';
            transfer.eta = 'Verifying integrity...';
            renderTransferQueue();

            calculateSHA256(blob).then((computedHash) => {
              if (transfer.fileHash && computedHash !== transfer.fileHash) {
                transfer.status = 'failed';
                transfer.eta = 'Corrupted';
                showToast('File corrupted. Please retry transfer.', 'error');
                if (transfer.statsInterval) clearInterval(transfer.statsInterval);
                renderTransferQueue();
                closePeerConnection(senderId);
                return;
              }

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
              transfer.eta = 'Verified: file matches original';
              showToast(`P2P Download finished!`, 'success');
              if (transfer.statsInterval) clearInterval(transfer.statsInterval);
              renderTransferQueue();
              updateTransferCountBadge();
              closePeerConnection(senderId);

              secureFetch('/api/files/p2p-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  fileId: transfer.id,
                  name: transfer.name,
                  size: transfer.size,
                  mimeType: context.invite.fileType || 'application/octet-stream',
                  senderId: senderId,
                  receiverId: state.clientId,
                  fileHash: computedHash
                })
              }).then(() => {
                fetchFiles();
              }).catch(err => console.error('Failed to save P2P metadata:', err));
            }).catch(() => {
              transfer.status = 'failed';
              transfer.eta = 'Verification failed';
              if (transfer.statsInterval) clearInterval(transfer.statsInterval);
              renderTransferQueue();
              closePeerConnection(senderId);
            });
          } else if (payload.type === 'transfer_cancel') {
            cancelTransfer(payload.transferId, true);
          }
        } catch(err) {}
        return;
      }
      
      transfer.buffers.push(e.data);
      transfer.receivedBytes += e.data.byteLength;
      
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
  const queue = state.iceCandidateQueues.get(senderId) || [];
  for (const candidate of queue) {
    try {
      if (candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error("Early candidate err:", e);
    }
  }
  state.iceCandidateQueues.delete(senderId);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(senderId, { type: 'answer', sdp: answer, transferId });
}

function requestP2PFileShare(targetClientId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const transferId = 'p2p-tx-' + generateUUID();
    const transfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      type: 'Upload (P2P)',
      progress: 0,
      speed: 0,
      eta: 'Calculating checksum...',
      status: 'hashing',
      peerId: targetClientId,
      file
    };
    
    state.transfers.set(transferId, transfer);
    openWindow('transfers');
    updateTransferCountBadge();
    renderTransferQueue();

    const fileHash = await calculateSHA256(file);
    transfer.hash = fileHash;
    transfer.status = 'pending-invite';
    transfer.eta = 'Waiting peer...';
    renderTransferQueue();
    
    sendSignal(targetClientId, {
      type: 'file-invite',
      transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      fileHash
    });
    showToast(`Invite sent to peer`, 'info');
  };
  input.click();
}

// --------------------------------------------------------------------------
// 11. Peer Discovery Radar rendering
// --------------------------------------------------------------------------
function renderRadarScreen() {
  const container = document.getElementById('radar-peers-container');
  container.innerHTML = '';
  const totalPeers = state.peers.size;
  if (totalPeers === 0) return;
  
  let i = 0;
  state.peers.forEach((peer, id) => {
    const angle = (i * (2 * Math.PI)) / totalPeers;
    const distancePercent = 35;
    const x = 50 + distancePercent * Math.cos(angle);
    const y = 50 + distancePercent * Math.sin(angle);
    
    const peerNode = document.createElement('div');
    peerNode.className = 'radar-peer-node';
    peerNode.style.left = `${x}%`;
    peerNode.style.top = `${y}%`;
    peerNode.title = `Send file directly to ${peer.username}`;
    
    const iconClass = getAvatarIconClass(peer.avatar);
    peerNode.innerHTML = `
      <div class="radar-peer-dot"><i class="bi ${iconClass}"></i></div>
      <span class="radar-peer-label">${escapeHtml(peer.username)}</span>
    `;
    
    peerNode.addEventListener('click', () => requestP2PFileShare(id));
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
        Searching for peers on your network...
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
        <button class="btn btn-secondary btn-sm p-1"><i class="bi bi-send-fill text-accent"></i></button>
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
// 12. Active Transfers Queue UI rendering
// --------------------------------------------------------------------------
function renderTransferQueue() {
  const list = document.getElementById('transfer-queue-list');
  
  if (state.transfers.size === 0) {
    list.innerHTML = `
      <div class="empty-state text-center text-muted py-5">
        <i class="bi bi-activity display-4 d-block mb-3"></i>
        No active transfers.
      </div>
    `;
    return;
  }
  
  let html = '';
  state.transfers.forEach((tx) => {
    const isCompleted = tx.status === 'completed';
    const isFailed = tx.status === 'failed';
    const isPaused = tx.status === 'paused';
    
    let statusLabel = `${tx.type} - `;
    if (isCompleted) statusLabel += 'Completed';
    else if (isFailed) statusLabel += 'Failed';
    else if (isPaused) statusLabel += 'Paused';
    else statusLabel += `${tx.progress.toFixed(1)}%`;
    
    let actionsHtml = '';
    if (!isCompleted && !isFailed && (tx.type.includes('LAN') || tx.type.includes('Cloud'))) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm p-1" onclick="togglePauseUpload('${tx.id}')" title="${isPaused ? 'Resume' : 'Pause'}">
          <i class="bi ${isPaused ? 'bi-play-fill' : 'bi-pause-fill'}"></i>
        </button>
        <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="cancelTransfer('${tx.id}')" title="Cancel">
          <i class="bi bi-x-circle-fill"></i>
        </button>
      `;
    } else if (!isCompleted && !isFailed && tx.type.includes('P2P')) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="cancelTransfer('${tx.id}')" title="Cancel">
          <i class="bi bi-stop-circle-fill"></i>
        </button>
      `;
    } else {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm p-1 text-danger" onclick="removeTransfer('${tx.id}')" title="Remove">
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
          <div class="d-flex align-items-center gap-2">${actionsHtml}</div>
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

function updateTransferItemUI(transferId) {
  const tx = state.transfers.get(transferId);
  if (!tx) return;
  
  const now = Date.now();
  const isFinalState = tx.progress >= 100 || ['completed', 'failed', 'paused', 'assembling'].includes(tx.status);
  if (tx.lastUIUpdate && (now - tx.lastUIUpdate < 150) && !isFinalState) return;
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
  
  const badgeEl = document.getElementById(`file-badge-virtual-${transferId}`);
  if (badgeEl) {
    badgeEl.innerText = tx.status === 'assembling' ? 'Assembling...' : `${tx.progress.toFixed(0)}%`;
  }
}

function removeTransfer(transferId) {
  state.transfers.delete(transferId);
  renderTransferQueue();
  updateTransferCountBadge();
  renderFileList();
}

function cancelTransfer(transferId, remoteTriggered = false) {
  const transfer = state.transfers.get(transferId);
  if (!transfer) return;
  
  // Guard: If transfer is already in a terminal state, exit immediately to prevent loop
  if (transfer.status === 'cancelled' || transfer.status === 'failed' || transfer.status === 'completed') {
    return;
  }
  
  if (!remoteTriggered) {
    if (!confirm(`Cancel transfer of ${transfer.name}?`)) return;
  }

  // Set local state
  transfer.status = 'cancelled';
  transfer.eta = 'Cancelled';
  transfer.speed = 0;
  
  if (transfer.watchdogInterval) {
    clearInterval(transfer.watchdogInterval);
  }
  
  if (transfer.activeXHRInstances) {
    transfer.activeXHRInstances.forEach((xhr) => {
      try { xhr.abort(); } catch (e) {}
    });
    transfer.activeXHRInstances.clear();
  }

  // If local/cloud transfer, call delete API to clean up server chunks
  if (transfer.type.includes('LAN') || transfer.type.includes('Cloud')) {
    secureFetch(`/api/transfer/upload/${transfer.id}`, { method: 'DELETE' }).catch(() => {});
  }

  // Send cancel message over DataChannel if open
  if (transfer.dataChannel && transfer.dataChannel.readyState === 'open') {
    try {
      transfer.dataChannel.send(JSON.stringify({ type: 'transfer_cancel', transferId }));
      transfer.dataChannel.close();
    } catch (e) {}
  }

  // Send WebSockets signal fallback if P2P (only if NOT remoteTriggered)
  if (!remoteTriggered && transfer.type.includes('P2P') && transfer.peerId) {
    sendSignal(transfer.peerId, {
      type: 'p2p-cancel',
      transferId: transferId
    });
    closePeerConnection(transfer.peerId);
  }

  showToast(`Transfer cancelled${remoteTriggered ? ' by peer' : ''}`, 'info');
  
  renderTransferQueue();
  updateTransferCountBadge();
  renderFileList();
}

function clearInactiveTransfers() {
  state.transfers.forEach((tx, id) => {
    if (tx.status === 'completed' || tx.status === 'failed' || tx.status === 'cancelled') {
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
    if (['uploading', 'downloading', 'connecting', 'pending-invite', 'assembling'].includes(tx.status)) {
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
// 13. WebSockets Connection signaling
// --------------------------------------------------------------------------
function sendJoinMessage(otpCode = null, joinToken = null, roomId = null) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'join',
      clientId: state.clientId,
      username: state.username,
      avatar: state.avatar,
      deviceInfo: { platform: navigator.platform, userAgent: navigator.userAgent }
    };

    const guestSessionToken = safeLocalStorage.getItem('aerosync_guest_session_token');
    if (state.sessionToken) {
      payload.sessionToken = state.sessionToken;
    } else if (guestSessionToken) {
      payload.sessionToken = guestSessionToken;
    }

    const finalJoinToken = joinToken || state.joinToken;
    const finalRoomId = roomId || state.roomId;

    if (finalJoinToken && finalRoomId) {
      payload.joinToken = finalJoinToken;
      payload.roomId = finalRoomId;
    } else {
      const finalOtp = otpCode || state.otp;
      if (finalOtp) {
        payload.otp = finalOtp;
      }
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
    if (state.joinToken && state.roomId) {
      sendJoinMessage(null, state.joinToken, state.roomId);
    } else if (state.otp) {
      sendJoinMessage(state.otp);
    } else {
      sendJoinMessage();
    }
  };
  
  state.ws.onclose = () => {
    document.getElementById('network-status-text').innerText = 'Offline';
    document.getElementById('network-status-icon').className = 'bi bi-wifi-off text-danger';
    setTimeout(initWebSocket, 5000);
  };
  
  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'auth-required':
          state.authStatus = 'unauthenticated';
          // Re-route to security OTP screen overlay tab dynamically
          document.getElementById('auth-overlay').style.display = 'flex';
          const otpTabBtn = document.getElementById('auth-tab-otp');
          if (otpTabBtn) otpTabBtn.click();
          break;
          
        case 'auth-failed':
          state.authStatus = 'unauthenticated';
          document.getElementById('auth-overlay').style.display = 'flex';
          const errEl = document.getElementById('auth-error-msg');
          errEl.innerText = msg.message || 'Incorrect OTP code. Please try again.';
          errEl.style.display = 'block';
          break;
          
        case 'auth-success':
          state.authStatus = msg.authStatus || (state.sessionToken ? 'loggedIn' : 'guestConnected');
          document.getElementById('auth-overlay').style.display = 'none';
          
          if (state.authStatus === 'guestConnected') {
            openWindow('transfers');
            const driveIp = document.getElementById('drive-node-ip');
            if (driveIp) driveIp.innerText = 'Paired Session';
          }
          
          showToast('Pairing connection successful!', 'success');
          fetchFiles();
          fetchServerSettings();
          fetchUserBillingPlan();
          break;
          
        case 'otp-updated':
          if (state.isHost) {
            state.activeOTP = msg.otp;
            const joinCodeEl = document.getElementById('share-join-code');
            if (joinCodeEl) joinCodeEl.innerText = msg.otp;
            showToast('Security OTP refreshed successfully', 'success');
            // Auto-refresh the QR code when OTP changes
            fetchConnectionQR();
          }
          break;
          
        case 'welcome':
          state.isHost = msg.isHost || false;
          if (state.isHost) {
            document.getElementById('radar-otp-banner').style.display = 'flex';
            document.getElementById('radar-otp-code').innerText = msg.activeOTP || '------';
            state.activeOTP = msg.activeOTP;
            const joinCodeEl = document.getElementById('share-join-code');
            if (joinCodeEl) joinCodeEl.innerText = msg.activeOTP;
          } else {
            document.getElementById('radar-otp-banner').style.display = 'none';
          }
          
          state.peers.clear();
          msg.clients.forEach(c => state.peers.set(c.id, c));
          renderRadarScreen();
          renderTextPeerList();
          updatePeerCountBadge();
          renderConnectedDevicesList();
          break;
          
        case 'user-joined':
          state.peers.set(msg.client.id, msg.client);
          showToast(`${msg.client.username} has joined LAN`, 'info');
          renderRadarScreen();
          renderTextPeerList();
          updatePeerCountBadge();
          renderConnectedDevicesList();
          break;
          
        case 'user-left':
          const peer = state.peers.get(msg.clientId);
          if (peer) {
            showToast(`${peer.username} left LAN`, 'info');
            state.peers.delete(msg.clientId);
            closePeerConnection(msg.clientId);
          }
          renderRadarScreen();
          renderTextPeerList();
          updatePeerCountBadge();
          renderConnectedDevicesList();
          break;
          
        case 'signal':
          handleIncomingSignal(msg.senderId, msg.data);
          break;

        case 'file_shared':
          // Only show notification if we are not the owner of this file
          if (!state.myFiles.some(f => f.id === msg.fileId)) {
            showToast('A new file is available on the network!', 'success');
          }
          fetchFiles();
          break;
          
        case 'access_removed':
          showToast('Access to a shared file has been revoked.', 'warning');
          fetchFiles();
          break;
          
        case 'file_deleted':
          // Abort active transfers for this file if downloading/uploading
          state.transfers.forEach((tx, id) => {
            if (tx.fileId === msg.fileId || id === msg.fileId) {
              cancelTransfer(id, true);
              showToast(`Transfer of ${tx.name} aborted: File deleted by owner.`, 'warning');
            }
          });
          fetchFiles();
          break;
      }
    } catch (e) {
      console.error('WS payload error:', e);
    }
  };
}

// --------------------------------------------------------------------------
// 14. Helper formatting utilities
// --------------------------------------------------------------------------
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0 || !bytes || isNaN(bytes) || bytes < 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes < 1) return parseFloat(bytes.toFixed(dm)) + ' Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(k));
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
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
  toast.innerHTML = `<i class="bi ${icon}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --------------------------------------------------------------------------
// 15. Start Menu & Connection Share Hub
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
    
    document.addEventListener('click', (e) => {
      if (!startMenu.contains(e.target) && e.target !== btnStart && !btnStart.contains(e.target)) {
        startMenu.style.display = 'none';
        btnStart.classList.remove('active');
      }
    });
  }
  
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
  
  // Register logout in restart
  const restartBtn = document.getElementById('start-btn-restart');
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      if (confirm('Log out from AeroSync?')) {
        await secureFetch('/api/auth/logout', { method: 'POST' });
        safeLocalStorage.setItem('aerosync_session_token', '');
        location.reload();
      }
    });
    restartBtn.innerHTML = '<i class="bi bi-box-arrow-right"></i> Log Out';
  }
}

let shareCountdownInterval = null;

async function openShareHub() {
  openWindow('share');
  if (!state.serverSettings) {
    await fetchServerSettings();
  }
  
  await fetchConnectionQR();
  renderConnectedDevicesList();
}

async function fetchConnectionQR() {
  try {
    const res = await secureFetch(`/api/qr/connection?clientId=${state.clientId}`);
    if (!res.ok) throw new Error('Failed to fetch connection info');
    const data = await res.json();
    
    // Update OTP
    state.activeOTP = data.otp;
    
    // Render QR Code onto canvas
    const canvas = document.getElementById('share-qr-canvas');
    if (canvas) {
      new QRious({
        element: canvas,
        value: data.joinURL,
        size: 130
      });
    }
    
    const label = document.getElementById('share-qr-label');
    if (label) label.innerText = 'Secure Pairing QR Code';
    
    const joinCodeEl = document.getElementById('share-join-code');
    if (joinCodeEl) joinCodeEl.innerText = data.otp;
    
    const qrLink = document.getElementById('share-qr-link');
    if (qrLink) qrLink.href = data.joinURL;
    
    // Setup countdown
    let timeLeft = data.expiresIn || 300;
    const countdownEl = document.getElementById('share-qr-countdown');
    
    if (shareCountdownInterval) clearInterval(shareCountdownInterval);
    
    const updateTimerDisplay = () => {
      const minutes = Math.floor(timeLeft / 60);
      const seconds = timeLeft % 60;
      const secondsStr = seconds.toString().padStart(2, '0');
      if (countdownEl) {
        countdownEl.innerText = `Token expires in: 0${minutes}:${secondsStr}`;
      }
    };
    
    updateTimerDisplay();
    
    shareCountdownInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft <= 0) {
        clearInterval(shareCountdownInterval);
        fetchConnectionQR(); // Auto-refresh when expired
      } else {
        updateTimerDisplay();
      }
    }, 1000);
    
    // Setup copy join link button
    const btnCopyLink = document.getElementById('btn-copy-join-link');
    if (btnCopyLink) {
      const newBtn = btnCopyLink.cloneNode(true);
      btnCopyLink.replaceWith(newBtn);
      newBtn.addEventListener('click', () => {
        copyToClipboard(data.joinURL);
      });
    }
    
    // Setup copy join code button
    const btnCopyCode = document.getElementById('btn-copy-join-code');
    if (btnCopyCode) {
      const newBtn = btnCopyCode.cloneNode(true);
      btnCopyCode.replaceWith(newBtn);
      newBtn.addEventListener('click', () => {
        copyToClipboard(data.otp);
      });
    }
    
    // Setup share link button using Web Share API
    const btnWebShare = document.getElementById('btn-web-share-link');
    if (btnWebShare) {
      if (navigator.share) {
        btnWebShare.style.display = 'inline-flex';
        const newBtn = btnWebShare.cloneNode(true);
        btnWebShare.replaceWith(newBtn);
        newBtn.addEventListener('click', () => {
          navigator.share({
            title: 'AeroSync Pairing Link',
            text: `Pair your device with code: ${data.otp}`,
            url: data.joinURL
          }).catch(err => console.log('Share failed:', err));
        });
      } else {
        btnWebShare.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Failed to load connection QR:', err);
    showToast('Failed to load pairing QR', 'error');
  }
}

function renderConnectedDevicesList() {
  const container = document.getElementById('share-connected-devices-list');
  if (!container) return;
  if (state.peers.size === 0) {
    container.innerHTML = `<div class="text-muted small text-center py-1">No paired devices. Scan QR or enter code to pair.</div>`;
    return;
  }
  let html = '';
  state.peers.forEach(peer => {
    const iconClass = getAvatarIconClass(peer.avatar);
    html += `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <i class="bi ${iconClass} text-success" style="font-size: 14px;"></i>
          <div style="display: flex; flex-direction: column;">
            <span style="font-size: 11px; font-weight: 500; color: #fff;">${escapeHtml(peer.username)}</span>
            <span style="font-size: 9px; color: rgba(255,255,255,0.5);">${escapeHtml(peer.deviceInfo.platform || 'Client')}</span>
          </div>
        </div>
        <span class="badge bg-success-subtle text-success" style="font-size: 8px; border-radius: 4px; padding: 2px 4px; font-weight: 600;">Active</span>
      </div>
    `;
  });
  container.innerHTML = html;
}

window.openShareHubWithUrl = function(url, label) {
  openShareHub();
};

window.updateShareQrCode = function(url, label) {
  const qrContainer = document.getElementById('share-qr-container');
  const qrLabel = document.getElementById('share-qr-label');
  if (!qrContainer || !qrLabel) return;
  
  qrLabel.innerText = label;
  qrContainer.innerHTML = '';
  
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '150px';
  canvas.style.height = '150px';
  qrContainer.appendChild(canvas);
  
  const qrLink = document.getElementById('share-qr-link');
  if (qrLink) qrLink.href = url;
  
  new QRious({
    element: canvas,
    value: url,
    size: 150
  });
};

window.openShareHubWithUrl = function(url, label) {
  let finalUrl = url;
  if (state.activeOTP && !url.includes('otp=')) {
    finalUrl = url + (url.includes('?') ? '&' : '?') + `otp=${state.activeOTP}`;
  }
  openShareHub(finalUrl, label);
};

window.copyToClipboard = function(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Copied to clipboard!', 'success'))
      .catch(() => fallbackCopyToClipboard(text));
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
    showToast('Copied to clipboard!', 'success');
  } catch (err) {
    showToast('Failed to copy', 'error');
  }
}

// --------------------------------------------------------------------------
// Quota & Billing Plan Upgrades Logic
// --------------------------------------------------------------------------
async function fetchUserBillingPlan() {
  try {
    const res = await secureFetch('/api/billing/plan');
    if (!res.ok) return;
    const data = await res.json();
    
    // Update Billing Modal UI
    const currentPlanEl = document.getElementById('billing-current-plan');
    if (currentPlanEl) {
      currentPlanEl.innerText = data.planName;
    }

    // Update explorer sidebar metrics
    const sidebarPlanName = document.getElementById('sidebar-plan-name');
    const sidebarStorageUsage = document.getElementById('sidebar-storage-usage');
    const sidebarStorageBar = document.getElementById('sidebar-storage-bar');

    if (sidebarPlanName) sidebarPlanName.innerText = data.planName;
    
    let displayLimit = data.storageLimitBytes;
    if (data.planId === 'free' || data.storageLimitBytes < 10 * 1024 * 1024) {
      displayLimit = 1073741824; // 1 GB for demo / Free plan
    }

    if (sidebarStorageUsage) {
      sidebarStorageUsage.innerText = `${formatBytes(data.usedStorageBytes)} / ${formatBytes(displayLimit)}`;
    }
    if (sidebarStorageBar) {
      const percentage = Math.min(100, (data.usedStorageBytes / displayLimit) * 100);
      sidebarStorageBar.style.width = `${percentage}%`;
      if (percentage > 90) {
        sidebarStorageBar.style.backgroundColor = '#ff5f5f';
      } else {
        sidebarStorageBar.style.backgroundColor = 'var(--accent)';
      }
    }
  } catch (err) {
    console.error('[Billing Plan Fetch Error]', err);
  }
}

function updateTransferModeUI() {
  const modeSelect = document.querySelector('input[name="transfer-mode-select"]:checked');
  const modeVal = modeSelect ? modeSelect.value : 'lan';
  const cloudFields = document.getElementById('sidebar-cloud-fields');
  const lanInfo = document.getElementById('sidebar-lan-info');

  if (modeVal === 'lan') {
    if (cloudFields) cloudFields.style.display = 'none';
    if (lanInfo) lanInfo.style.display = 'block';
  } else {
    if (cloudFields) cloudFields.style.display = 'block';
    if (lanInfo) lanInfo.style.display = 'none';
  }
}

async function handlePlanUpgrade(planId) {
  try {
    showToast('Initializing secure checkout...', 'info');
    const res = await secureFetch('/api/billing/create-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId })
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to initialize subscription checkout');
    }
    
    const data = await res.json();
    
    // If it's a mock subscription, simulate payment success directly
    if (data.id.startsWith('sub_mock_')) {
      showToast('Mock checkout triggered. Processing payment...', 'info');
      
      const webhookRes = await secureFetch('/api/billing/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'subscription.activated',
          isMockTest: true,
          userId: state.user ? state.user.id : 'host',
          planId: planId,
          subscriptionId: data.id,
          payload: {
            subscription: {
              entity: {
                id: data.id,
                notes: {
                  userId: state.user ? state.user.id : 'host',
                  planId: planId
                }
              }
            }
          }
        })
      });

      if (webhookRes.ok) {
        showToast('Payment successful! Your plan has been upgraded.', 'success');
        fetchUserBillingPlan();
      } else {
        showToast('Mock payment processing failed.', 'error');
      }
      return;
    }

    const options = {
      key: data.razorpayKeyId || 'rzp_test_mockkey123',
      subscription_id: data.id,
      name: 'AeroSync File Transfer',
      description: `Upgrade to ${planId.toUpperCase()} Plan`,
      image: 'favicon.ico',
      handler: async function (response) {
        showToast('Payment captured. Verifying transaction...', 'info');
        setTimeout(() => {
          fetchUserBillingPlan();
          showToast('Storage capacity updated!', 'success');
        }, 1500);
      },
      prefill: {
        name: state.user ? state.user.username : '',
        email: state.user ? state.user.email : ''
      },
      theme: {
        color: '#00d2ff'
      }
    };
    
    const rzp = new Razorpay(options);
    rzp.open();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --------------------------------------------------------------------------
// KEYBOARD ACCESSIBILITY & FOCUS MANAGEMENT
// --------------------------------------------------------------------------
document.addEventListener('keydown', (event) => {
  const activeEl = document.activeElement;
  
  if (event.key === 'Enter') {
    // 1. Login form submit
    if (activeEl && (activeEl.id === 'login-username' || activeEl.id === 'login-password')) {
      event.preventDefault();
      handleLogin();
    }
    // 2. Signup form submit
    else if (activeEl && (activeEl.id === 'reg-email' || activeEl.id === 'reg-username' || activeEl.id === 'reg-password')) {
      event.preventDefault();
      handleRegister();
    }
    // 3. Guest OTP / Join code submit
    else if (activeEl && (activeEl.id === 'auth-username' || activeEl.id === 'auth-otp')) {
      event.preventDefault();
      const btn = document.getElementById('btn-submit-auth');
      if (btn) btn.click();
    }
    // 4. Share email submit
    else if (activeEl && activeEl.id === 'share-email-input') {
      event.preventDefault();
      const btn = document.getElementById('btn-grant-access');
      if (btn) btn.click();
    }
    // 5. Delete confirmation submit
    else {
      const delOverlay = document.getElementById('delete-confirm-overlay');
      if (delOverlay && delOverlay.style.display === 'flex') {
        event.preventDefault();
        const btn = document.getElementById('btn-confirm-delete');
        if (btn) btn.click();
      }
      
      // 6. P2P Prompt accept submit
      const p2pOverlay = document.getElementById('p2p-prompt-overlay');
      if (p2pOverlay && p2pOverlay.style.display === 'flex') {
        event.preventDefault();
        const btn = document.getElementById('btn-accept-transfer');
        if (btn) btn.click();
      }
    }
  } 
  
  else if (event.key === 'Escape') {
    // Escape closes modals
    const p2pOverlay = document.getElementById('p2p-prompt-overlay');
    if (p2pOverlay && p2pOverlay.style.display !== 'none') {
      declineIncomingP2P();
    }
    
    document.querySelectorAll('.prompt-overlay').forEach(overlay => {
      overlay.style.display = 'none';
    });
  }
});

// Mutation observer to handle focus automatically when prompt-overlays are opened
const modalObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.attributeName === 'style') {
      const target = mutation.target;
      if (target.classList.contains('prompt-overlay') && target.style.display === 'flex') {
        const inputs = target.querySelectorAll('input:not([type="hidden"]), select, button');
        const visibleInputs = Array.from(inputs).filter(el => {
          let parent = el;
          while (parent) {
            if (parent.style && parent.style.display === 'none') return false;
            parent = parent.parentElement;
          }
          return true;
        });
        if (visibleInputs.length > 0) {
          if (target.id === 'delete-confirm-overlay') {
            const cancelBtn = target.querySelector('#btn-cancel-delete');
            if (cancelBtn) {
              cancelBtn.focus();
              return;
            }
          }
          visibleInputs[0].focus();
        }
      }
    }
  });
});

document.querySelectorAll('.prompt-overlay').forEach((overlay) => {
  modalObserver.observe(overlay, { attributes: true });
});
