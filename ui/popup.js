// DOM Elements
const newSessionBtn = document.getElementById('newSessionBtn');
const searchInput = document.getElementById('searchInput');
const currentTabs = document.getElementById('currentTabs');
const currentCount = document.getElementById('currentCount');
const sessionList = document.getElementById('sessionList');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const settingsBtn = document.getElementById('settingsBtn');

// State
let sessions = [];
let currentSession = null;
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
exportBtn.addEventListener('click', exportSessions);
importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', importSessionsFromFile);
settingsBtn.addEventListener('click', openSettings);

// Initialize
document.addEventListener('DOMContentLoaded', () => {
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
      renderSavedSessions();
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

// Render saved sessions
function renderSavedSessions() {
  const displaySessions = filteredSessions.length > 0 ? filteredSessions : sessions;
  const savedOnly = displaySessions.filter(s => s.id !== currentSession?.id);

  if (savedOnly.length === 0) {
    sessionList.innerHTML = '<p class="empty-state">No saved sessions</p>';
    return;
  }

  sessionList.innerHTML = savedOnly.map(session => {
    const closedCount = (session.closedTabs || []).length;
    const isClosedVisible = showClosedTabs.get(session.id) || false;
    const isActiveVisible = showActiveTabs.get(session.id) || false;

    return `
    <div class="session-item session-item-clickable" data-action="toggleActive" data-id="${session.id}">
      <div class="session-header">
        <div class="session-name">${escapeHtml(session.name)}</div>
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
      ${isActiveVisible ? renderActiveTabs(session.tabs) : ''}
      ${isClosedVisible && closedCount > 0 ? renderClosedTabs(session.closedTabs) : ''}
      <div class="session-actions">
        <button class="action-btn" data-action="restore" data-id="${session.id}">Restore</button>
        <button class="action-btn" data-action="rename" data-id="${session.id}">Rename</button>
        <button class="action-btn delete" data-action="delete" data-id="${session.id}">Delete</button>
      </div>
    </div>
  `;
  }).join('');

  // Add event listeners to buttons
  console.log('[POPUP RENDER] Attaching event listeners...');

  const actionBtns = document.querySelectorAll('.action-btn');
  console.log('[POPUP RENDER] Found', actionBtns.length, 'action buttons');
  actionBtns.forEach((btn, index) => {
    console.log(`[POPUP RENDER] Button ${index}:`, btn.dataset.action, btn.textContent);
    btn.addEventListener('click', (e) => {
      console.log('[POPUP] Action button clicked!', btn.dataset.action);
      handleSessionAction(e);
    });
  });

  // Add to session clickable areas
  document.querySelectorAll('.toggle-closed-btn, .restore-closed-btn, .session-item-clickable, .tab-item-clickable').forEach(elem => {
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
}

// Toggle closed tabs visibility
function toggleClosedTabs(sessionId) {
  const currentState = showClosedTabs.get(sessionId) || false;
  showClosedTabs.set(sessionId, !currentState);
  renderSavedSessions();
}

// Restore session
async function restoreSession(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session || !session.tabs || session.tabs.length === 0) {
    alert('No tabs to restore');
    return;
  }

  const urls = session.tabs.map(t => t.url);
  console.log('[RESTORE] Opening', urls.length, 'tabs via window.open()');

  for (let i = 0; i < urls.length; i++) {
    window.open(urls[i], '_blank');
    await new Promise(r => setTimeout(r, 300));
  }

  alert(`✅ Opened ${urls.length} tabs`);
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
async function createNewSession() {
  try {
    await chrome.runtime.sendMessage({ action: 'createNewSession' });
    await loadSessions();
  } catch (error) {
    console.error('Error creating session:', error);
    alert('Failed to create new session. Please try again.');
    await loadSessions();
  }
}

// Search/filter sessions
function filterSessions() {
  const query = searchInput.value.toLowerCase();

  if (!query) {
    filteredSessions = [];
    renderSavedSessions();
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
}

// Export sessions
async function exportSessions() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'exportSessions' });

    if (response.success) {
      const dataStr = JSON.stringify(response.data, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `incognito-sessions-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.error('Error exporting sessions:', error);
    alert('Failed to export sessions');
  }
}

// Import sessions
async function importSessionsFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      await chrome.runtime.sendMessage({
        action: 'importSessions',
        data: data
      });
      loadSessions();
      alert('Sessions imported successfully');
    } catch (error) {
      console.error('Error importing sessions:', error);
      alert('Failed to import sessions');
    }
  };
  reader.readAsText(file);

  event.target.value = '';
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
