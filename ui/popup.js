// Create sparkling stars for galaxy effect
function createSparklingStars() {
  const starPositions = [
    { x: '8%', y: '15%' },
    { x: '25%', y: '35%' },
    { x: '65%', y: '25%' },
    { x: '85%', y: '55%' },
    { x: '45%', y: '75%' }
  ];

  starPositions.forEach((pos, index) => {
    const star = document.createElement('div');
    star.className = 'sparkle-star';
    star.style.left = pos.x;
    star.style.top = pos.y;
    document.body.appendChild(star);
  });
}

// Parallax effect - background moves away from mouse (very subtle)
function initParallax() {
  let mouseX = 0;
  let mouseY = 0;
  let currentX = 0;
  let currentY = 0;

  document.addEventListener('mousemove', (e) => {
    // Get mouse position relative to window center
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    // Calculate offset from center (normalized to -1 to 1)
    mouseX = (e.clientX - centerX) / centerX;
    mouseY = (e.clientY - centerY) / centerY;
  });

  // Smooth animation loop
  function animate() {
    // Very slow interpolation for ultra-smooth, subtle movement
    currentX += (mouseX - currentX) * 0.05;
    currentY += (mouseY - currentY) * 0.05;

    // Apply very subtle parallax effect - move background AWAY from mouse
    // Stars layer (barely noticeable, 3px max)
    const starsX = -currentX * 3;
    const starsY = -currentY * 3;

    // Nebula layer (slightly more, 6px max)
    const nebulaX = -currentX * 6;
    const nebulaY = -currentY * 6;

    // Use CSS custom properties for better performance
    document.body.style.setProperty('--parallax-stars-x', `${starsX}px`);
    document.body.style.setProperty('--parallax-stars-y', `${starsY}px`);
    document.body.style.setProperty('--parallax-nebula-x', `${nebulaX}px`);
    document.body.style.setProperty('--parallax-nebula-y', `${nebulaY}px`);

    requestAnimationFrame(animate);
  }

  animate();
}

// Initialize sparkling stars when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    createSparklingStars();
    initParallax();
  });
} else {
  createSparklingStars();
  initParallax();
}

// DOM Elements
const newSessionBtn = document.getElementById('newSessionBtn');
const searchInput = document.getElementById('searchInput');
const currentTabs = document.getElementById('currentTabs');
const currentSessionTitle = document.getElementById('currentSessionTitle');
const currentCount = document.getElementById('currentCount');
const sessionList = document.getElementById('sessionList');
const historyList = document.getElementById('historyList');

const settingsBtn = document.getElementById('settingsBtn');
const viewsContainer = document.querySelector('.views-container');
const toHistoryBtn = document.getElementById('toHistoryBtn');
const toMainFromHistoryBtn = document.getElementById('toMainFromHistoryBtn');
const toCurrentBtn = document.getElementById('toCurrentBtn');
const toMainFromCurrentBtn = document.getElementById('toMainFromCurrentBtn');
const saveModal = document.getElementById('saveModal');
const sessionNameInput = document.getElementById('sessionNameInput');
const cancelSaveBtn = document.getElementById('cancelSaveBtn');
const confirmSaveBtn = document.getElementById('confirmSaveBtn');
const appFooter = document.getElementById('appFooter');
const footerIndicator = document.querySelector('.footer-indicator');

// State
let sessions = [];
let currentSession = null;
let savedSessions = [];
let historySessions = [];
let currentView = 'main';
let filteredSessions = [];
let showClosedTabs = new Map(); // Track which sessions have closed tabs visible
let showActiveTabs = new Map(); // Track which sessions have active tabs visible

// Utility function to get favicon URL with fallback
function getFaviconUrl(favicon, tabUrl) {
  // If we have a valid favicon, sanitize and return it
  if (favicon) {
    const allowedSchemes = ['http://', 'https://', 'data:image/'];
    if (allowedSchemes.some(scheme => favicon.startsWith(scheme))) {
      return favicon;
    }
  }

  // Fallback: use Google's favicon service
  if (tabUrl) {
    try {
      const urlObj = new URL(tabUrl);
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
    } catch (e) { }
  }

  return '';
}

// Event listeners
newSessionBtn.addEventListener('click', createNewSession);
searchInput.addEventListener('input', filterSessions);

settingsBtn.addEventListener('click', openSettings);

// Navigation
toHistoryBtn.addEventListener('click', () => switchView('history'));
toMainFromHistoryBtn.addEventListener('click', () => switchView('main'));
toCurrentBtn.addEventListener('click', () => switchView('current'));
toMainFromCurrentBtn.addEventListener('click', () => switchView('main'));

// Swipe Handling
let touchStartX = 0;
let touchEndX = 0;

document.addEventListener('touchstart', e => {
  touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

document.addEventListener('touchend', e => {
  touchEndX = e.changedTouches[0].screenX;
  handleSwipe();
}, { passive: true });

function handleSwipe() {
  const threshold = 50;
  // From history (leftmost): swipe left to go to main (center)
  if (currentView === 'history' && touchEndX < touchStartX - threshold) {
    switchView('main');
  }
  // From main (center): swipe right to go to history, swipe left to go to current
  else if (currentView === 'main' && touchEndX > touchStartX + threshold) {
    switchView('history');
  }
  else if (currentView === 'main' && touchEndX < touchStartX - threshold) {
    switchView('current');
  }
  // From current (rightmost): swipe right to go to main (center)
  else if (currentView === 'current' && touchEndX > touchStartX + threshold) {
    switchView('main');
  }
}

// Edge Hover Detection for View Switching
let edgeHoverTimeout = null;
const EDGE_THRESHOLD = 50; // pixels from edge
const HOVER_DELAY = 100; // milliseconds to wait before switching

document.addEventListener('mousemove', (e) => {
  const windowWidth = window.innerWidth;
  const mouseX = e.clientX;

  // Clear existing timeout
  if (edgeHoverTimeout) {
    clearTimeout(edgeHoverTimeout);
    edgeHoverTimeout = null;
  }

  // Check if near left edge
  if (mouseX <= EDGE_THRESHOLD) {
    edgeHoverTimeout = setTimeout(() => {
      // Go to previous view
      if (currentView === 'main') {
        switchView('history');
      } else if (currentView === 'current') {
        switchView('main');
      }
    }, HOVER_DELAY);
  }
  // Check if near right edge
  else if (mouseX >= windowWidth - EDGE_THRESHOLD) {
    edgeHoverTimeout = setTimeout(() => {
      // Go to next view
      if (currentView === 'history') {
        switchView('main');
      } else if (currentView === 'main') {
        switchView('current');
      }
    }, HOVER_DELAY);
  }
});

function switchView(view) {
  currentView = view;
  if (view === 'history') {
    viewsContainer.style.transform = 'translateX(0)';
    viewsContainer.classList.add('show-history');
    viewsContainer.classList.remove('show-main', 'show-current');
  } else if (view === 'current') {
    viewsContainer.style.transform = 'translateX(-66.666%)';
    viewsContainer.classList.add('show-current');
    viewsContainer.classList.remove('show-main', 'show-history');
  } else {
    // Default to main/saved view
    viewsContainer.style.transform = 'translateX(-33.333%)';
    viewsContainer.classList.add('show-main');
    viewsContainer.classList.remove('show-history', 'show-current');
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Set initial view state
  viewsContainer.classList.add('show-main');

  // Trigger immediate sync then load sessions
  chrome.runtime.sendMessage({ action: 'ping' }).then(() => {
    loadSessions();
  }).catch(() => {
    loadSessions(); // Load anyway if ping fails
  });

  // Periodic keepalive pings
  const keepAlive = setInterval(async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'ping' });
    } catch (error) {
      clearInterval(keepAlive);
    }
  }, 20000);

  // Footer active toggle for mobile/tap
  if (footerIndicator) {
    footerIndicator.addEventListener('click', (e) => {
      e.stopPropagation();
      appFooter.classList.toggle('active');
    });
  }

  // Close footer when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (appFooter && appFooter.classList.contains('active') && !appFooter.contains(e.target)) {
      appFooter.classList.remove('active');
    }
  });

});

// Load sessions
async function loadSessions() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSessions' });

    if (response.success) {
      const data = response.data || { sessions: [] };
      sessions = data.sessions || [];

      // Check execution context - in split mode, we are in the context we care about
      let isIncognito = chrome.extension.inIncognitoContext;

      // In both modes, we want to show the current session if it exists
      currentSession = sessions.find(s => s.id === data.currentSessionId);

      renderCurrentSession();

      // Split sessions
      savedSessions = sessions.filter(s => s.type === 'saved');
      historySessions = sessions.filter(s => s.type !== 'saved' && s.id !== data.currentSessionId);

      renderSavedSessions();
      renderHistorySessions();
    } else {
      // Response received but success=false
      const errorMsg = response ? response.error : 'Unknown error';
      document.querySelector('.container').innerHTML = `
         <div style="padding:20px; color:red;">
           <h3>Error Loading Sessions</h3>
           <p>${errorMsg}</p>
           <p>Mode: ${response && response.mode ? response.mode : 'Unknown'}</p>
         </div>
       `;
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
    document.querySelector('.container').innerHTML = `
       <div style="padding:20px; color:red;">
         <h3>Connection Error</h3>
         <p>Could not connect to background service worker.</p>
         <p>Detailed Error: ${error.message}</p>
         <button onclick="location.reload()">Retry</button>
       </div>
    `;
  }
}

// Render current session
function renderCurrentSession() {
  if (!currentSession || currentSession.tabs.length === 0) {
    currentTabs.innerHTML = '<p class="empty-state">No tabs in current session</p>';
    currentCount.textContent = '0';
    return;
  }

  currentCount.textContent = currentSession.tabs.length;

  currentTabs.innerHTML = currentSession.tabs.map(tab => {
    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      hostname = tab.url;
    }
    const safeFavicon = getFaviconUrl(tab.favicon, tab.url);
    return `
    <div class="tab-item tab-item-clickable" data-action="openTab" data-url="${escapeHtml(tab.url)}">
      <div class="tab-favicon">
        <img src="${escapeHtml(safeFavicon)}" alt="" onerror="this.style.display='none'">
      </div>
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title)}</div>
        <div class="tab-url">${escapeHtml(hostname)}</div>
      </div>
    </div>
  `;
  }).join('');

  // Add event listeners for current tabs
  document.querySelectorAll('#currentTabs .tab-item-clickable').forEach(item => {
    item.addEventListener('click', handleSessionAction);
  });
}

// Render saved sessions (Manual Saves)
function renderSavedSessions() {
  const sourceList = filteredSessions.length > 0 ? filteredSessions.filter(s => s.type === 'saved') : savedSessions;
  const displaySessions = sourceList.filter(s => s.id !== currentSession?.id);

  if (displaySessions.length === 0) {
    sessionList.innerHTML = '<p class="empty-state">No saved sessions</p>';
    return;
  }

  sessionList.innerHTML = displaySessions.map(session => generateSessionHTML(session)).join('');
  attachSessionListeners(sessionList);
}

// Render history sessions (Auto Saves)
function renderHistorySessions() {
  const sourceList = filteredSessions.length > 0 ? filteredSessions.filter(s => s.type !== 'saved') : historySessions;
  // History sessions generally don't include current session anyway unless it's an old active one? 
  // background.js: sessions.filter(s => s.id !== currentSessionId) was not explicit for history.
  // We filtered historySessions excluding currentSessionId in loadSessions.

  if (sourceList.length === 0) {
    historyList.innerHTML = '<p class="empty-state">No history available</p>';
    return;
  }

  historyList.innerHTML = sourceList.map(session => generateSessionHTML(session)).join('');
  attachSessionListeners(historyList);
}

// Helper to generate Session HTML (DRY)
function generateSessionHTML(session) {
  const closedCount = (session.closedTabs || []).length;
  const isClosedVisible = showClosedTabs.get(session.id) || false;
  const isActiveVisible = showActiveTabs.get(session.id) || false;

  return `
    <div class="session-item session-item-clickable" data-action="toggleActive" data-id="${session.id}">
      <div class="session-header">
        ${session.name ? `<div class="session-name">${escapeHtml(session.name)}</div>` : ''}
        <div class="session-header-actions">
          ${closedCount > 0 && isClosedVisible ? `
            <button class="restore-closed-btn" data-action="restoreClosed" data-id="${session.id}" title="Restore closed tabs">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"></polyline>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
              </svg>
            </button>
          ` : ''}
          ${closedCount > 0 ? `
            <button class="toggle-closed-btn" data-action="toggleClosed" data-id="${session.id}" title="Toggle closed tabs">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${isClosedVisible ?
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' :
        '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
      }
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
      <div class="session-meta">
        <span>${session.tabs.length} active${closedCount > 0 ? `, ${closedCount} closed` : ''}</span>
        <span>${formatDate(session.modified)}</span>
      </div>
      
      <!-- Preview Grid -->
      ${!isActiveVisible ? renderPreviewGrid(session.tabs) : ''}

      ${isActiveVisible ? renderActiveTabs(session.tabs) : ''}
      ${isClosedVisible && closedCount > 0 ? renderClosedTabs(session.closedTabs) : ''}
      ${isActiveVisible ? `
      <div class="session-actions">
        <button class="action-btn" data-action="restore" data-id="${session.id}">Restore</button>
        <button class="action-btn" data-action="rename" data-id="${session.id}">Rename</button>
        <button class="action-btn delete" data-action="delete" data-id="${session.id}">Delete</button>
      </div>
      ` : ''}
    </div>
  `;
}

// Render preview grid of favicons
function renderPreviewGrid(tabs) {
  if (!tabs || tabs.length === 0) return '';

  return `
    <div class="session-preview-grid">
      ${tabs.map(tab => {
    const safeFavicon = getFaviconUrl(tab.favicon, tab.url);
    return `
          <div class="preview-favicon tab-item-clickable" title="${escapeHtml(tab.title)}" data-action="openTab" data-url="${escapeHtml(tab.url)}">
            <img src="${escapeHtml(safeFavicon)}" alt="" onerror="this.style.display='none'">
          </div>
        `;
  }).join('')}
    </div>
  `;
}

function attachSessionListeners(container) {
  // Add to session clickable areas
  container.querySelectorAll('.toggle-closed-btn, .restore-closed-btn, .session-item-clickable, .tab-item-clickable, .action-btn').forEach(elem => {
    // Remove old listeners? The elements are new, so no need.
    elem.addEventListener('click', handleSessionAction);
  });
}

// Render active tabs
function renderActiveTabs(tabs) {
  return `
    <div class="active-tabs-section">
      <div class="active-tabs-header">Active Tabs</div>
      <div class="active-tabs-list">
        ${tabs.map(tab => {
    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      hostname = tab.url;
    }
    const safeFavicon = getFaviconUrl(tab.favicon, tab.url);
    return `
            <div class="tab-item active-tab-item tab-item-clickable" data-action="openTab" data-url="${escapeHtml(tab.url)}">
              <div class="tab-favicon">
                <img src="${escapeHtml(safeFavicon)}" alt="" onerror="this.style.display='none'">
              </div>
              <div class="tab-info">
                <div class="tab-title">${escapeHtml(tab.title)}</div>
                <div class="tab-url">${escapeHtml(hostname)}</div>
              </div>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;
}

// Render closed tabs
function renderClosedTabs(closedTabs) {
  return `
    <div class="closed-tabs-section">
      <div class="closed-tabs-header">Closed Tabs</div>
      <div class="closed-tabs-list">
        ${closedTabs.map(tab => {
    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      hostname = tab.url;
    }
    const safeFavicon = getFaviconUrl(tab.favicon, tab.url);
    return `
            <div class="tab-item closed-tab-item tab-item-clickable" data-action="openTab" data-url="${escapeHtml(tab.url)}">
              <div class="tab-favicon">
                <img src="${escapeHtml(safeFavicon)}" alt="" onerror="this.style.display='none'">
              </div>
              <div class="tab-info">
                <div class="tab-title">${escapeHtml(tab.title)}</div>
                <div class="tab-url">${escapeHtml(hostname)}</div>
              </div>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;
}

// Handle session actions
function handleSessionAction(event) {
  // PRIORITY 1: Check if clicking a button directly
  let action, sessionId, tabUrl;
  const buttonElement = event.target.closest('button');

  if (buttonElement) {
    action = buttonElement.dataset.action;
    sessionId = buttonElement.dataset.id;
    tabUrl = buttonElement.dataset.url;
    event.preventDefault();
    event.stopPropagation();
  } else {
    // PRIORITY 2: Tab items (check first to prevent bubbling to session)
    const tabElement = event.target.closest('.tab-item-clickable');
    if (tabElement) {
      action = tabElement.dataset.action;
      tabUrl = tabElement.dataset.url;
      event.stopPropagation();
    } else {
      // PRIORITY 3: Session items
      const sessionElement = event.target.closest('.session-item-clickable');
      if (sessionElement) {
        action = sessionElement.dataset.action;
        sessionId = sessionElement.dataset.id;
      }
    }
  }

  if (!action) return;

  // Execute action
  if (action === 'restore') {
    restoreSession(sessionId);
  } else if (action === 'rename') {
    renameSessionPrompt(sessionId);
  } else if (action === 'delete') {
    deleteSession(sessionId);
  } else if (action === 'toggleClosed') {
    toggleClosedTabs(sessionId);
  } else if (action === 'toggleActive') {
    toggleActiveTabs(sessionId);
  } else if (action === 'restoreClosed') {
    restoreClosedTabs(sessionId);
  } else if (action === 'openTab') {
    if (tabUrl) {
      openTab(tabUrl);
    }
  }
}

// Open a single tab using window.open (same method as restore)
async function openTab(url) {
  console.log('[OPEN TAB] Opening:', url);
  window.open(url, '_blank');
}

// Restore closed tabs
async function restoreClosedTabs(sessionId) {
  const session = sessions.find(s => s.id === sessionId);

  if (!session || !session.closedTabs || session.closedTabs.length === 0) {
    alert('No closed tabs to restore.');
    return;
  }

  if (session.closedTabs.length > 10) {
    if (!confirm(`Open ${session.closedTabs.length} closed tabs?`)) return;
  }

  console.log('[RESTORE CLOSED] Opening', session.closedTabs.length, 'tabs');

  for (const tab of session.closedTabs) {
    window.open(tab.url, '_blank');
    await new Promise(r => setTimeout(r, 300));
  }

  alert(`✅ Opened ${session.closedTabs.length} closed tabs`);
}

// Toggle active tabs visibility
function toggleActiveTabs(sessionId) {
  const currentState = showActiveTabs.get(sessionId) || false;
  showActiveTabs.set(sessionId, !currentState);
  renderSavedSessions();
  renderHistorySessions();
}

// Toggle closed tabs visibility
function toggleClosedTabs(sessionId) {
  const currentState = showClosedTabs.get(sessionId) || false;
  showClosedTabs.set(sessionId, !currentState);
  renderSavedSessions();
  renderHistorySessions();
}

// Restore session
async function restoreSession(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session || !session.tabs || session.tabs.length === 0) {
    alert('No tabs to restore');
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      action: 'openSavedSession',
      sessionId: sessionId
    });
  } catch (error) {
    console.error('Error restoring session:', error);
    alert('Failed to restore session. ' + error.message);
  }
}


// Delete session
async function deleteSession(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  const sessionCopy = { ...session };

  try {
    await chrome.runtime.sendMessage({
      action: 'deleteSession',
      sessionId: sessionId
    });
    await loadSessions();
    showUndoMessage(sessionCopy);
  } catch (error) {
    console.error('Error deleting session:', error);
    alert('Failed to delete session. Please try again.');
    await loadSessions(); // Refresh to show correct state
  }
}

// Show undo message
function showUndoMessage(deletedSession) {
  // Create undo message
  const undoDiv = document.createElement('div');
  undoDiv.className = 'undo-message';
  undoDiv.innerHTML = `
    <span>Session deleted</span>
    <button class="undo-btn">Undo</button>
  `;

  document.body.appendChild(undoDiv);

  // Undo handler
  const undoBtn = undoDiv.querySelector('.undo-btn');
  let undoTimeout;

  undoBtn.addEventListener('click', async () => {
    clearTimeout(undoTimeout);
    undoDiv.remove();

    try {
      await chrome.runtime.sendMessage({
        action: 'importSessions',
        data: { sessions: [deletedSession] }
      });
      await loadSessions();
    } catch (error) {
      console.error('Error restoring session:', error);
      alert('Failed to restore session.');
    }
  });

  // Auto-remove after 4 seconds
  undoTimeout = setTimeout(() => {
    undoDiv.classList.add('fade-out');
    setTimeout(() => undoDiv.remove(), 300);
  }, 4000);
}

// Rename session
async function renameSessionPrompt(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  const currentName = session ? session.name : '';
  const newName = prompt('Enter new session name:', currentName);

  if (newName && newName.trim() && newName !== currentName) {
    try {
      await chrome.runtime.sendMessage({
        action: 'renameSession',
        sessionId: sessionId,
        newName: newName.trim()
      });
      await loadSessions();
    } catch (error) {
      console.error('Error renaming session:', error);
      alert('Failed to rename session. Please try again.');
      await loadSessions();
    }
  }
}

// Create new session
// Create new session
async function createNewSession() {
  try {
    // Check settings first
    const settings = await chrome.storage.local.get('incognito_settings');
    const promptForName = settings['incognito_settings']?.promptForName !== false; // Default true if undefined

    if (promptForName) {
      showSaveModal();
    } else {
      // Legacy behavior: save immediately with default name
      await chrome.runtime.sendMessage({ action: 'createNewSession' });
      await loadSessions();
    }
  } catch (error) {
    console.error('Error creating session:', error);
    alert('Failed to create new session. Please try again.');
    await loadSessions();
  }
}

function showSaveModal() {
  saveModal.style.display = 'flex';
  const date = new Date();
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  sessionNameInput.value = '';
  sessionNameInput.select();
  sessionNameInput.focus();
}

function hideSaveModal() {
  saveModal.style.display = 'none';
  sessionNameInput.value = '';
}

// Modal Event Listeners
cancelSaveBtn.addEventListener('click', hideSaveModal);

confirmSaveBtn.addEventListener('click', async () => {
  const name = sessionNameInput.value.trim();
  // Allow saving even if name is empty (it will be blank or default)
  try {
    await chrome.runtime.sendMessage({
      action: 'createNewSession',
      name: name
    });
    hideSaveModal();
    await loadSessions();
  } catch (error) {
    console.error('Error creating named session:', error);
    alert('Failed to create session');
  }
});

sessionNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    confirmSaveBtn.click();
  } else if (e.key === 'Escape') {
    hideSaveModal();
  }
});

// Close modal on click outside
saveModal.addEventListener('click', (e) => {
  if (e.target === saveModal) {
    hideSaveModal();
  }
});

// Search/filter sessions
function filterSessions() {
  const query = searchInput.value.toLowerCase();

  if (!query) {
    filteredSessions = [];
    renderSavedSessions();
    renderHistorySessions();
    return;
  }

  filteredSessions = sessions.filter(session =>
    session.name.toLowerCase().includes(query) ||
    session.tabs.some(tab =>
      tab.title.toLowerCase().includes(query) ||
      tab.url.toLowerCase().includes(query)
    )
  );

  renderSavedSessions();
  renderHistorySessions();
}

// Open settings
function openSettings() {
  chrome.runtime.openOptionsPage();
}

// Utility functions
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}
