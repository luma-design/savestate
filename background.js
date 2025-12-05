// Background Service Worker for Incognito Tab Saver
// Handles tab monitoring, session management, and storage operations

const CONFIG = {
  MAX_SESSIONS: 50,
  MAX_CLOSED_TABS: 50,
  STORAGE_KEY: 'incognito_sessions',
  SETTINGS_KEY: 'incognito_settings',
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000,
  SAVE_DELAY: 50
};

let currentSessionId = null;
let saveTimeouts = new Map();
let sessionCreationPromise = null; // Prevent concurrent session creation
let badgeUpdateTimeout = null; // Debounce badge updates
let knownTabIds = new Set(); // Track tabs we've already saved
let isInitialized = false; // Prevent events before storage is loaded
const ALARM_NAME = 'pollMobileTabs'; // Alarm for mobile polling

// Initialize extension
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await initializeStorage();
    showOnboarding();
  }
  // Reinitialize on extension update too
  if (details.reason === 'update') {
    console.log('[INSTALL] Extension updated, reinitializing...');
    await setupMobilePolling();
  }
});

// Reinitialize when browser starts (additional safeguard for mobile)
chrome.runtime.onStartup.addListener(async () => {
  console.log('[STARTUP] Browser started, reinitializing service worker...');
  await setupMobilePolling();
  await pollForMissedTabs();
});

// Initialize storage structure
async function initializeStorage() {
  const data = await chrome.storage.local.get([CONFIG.STORAGE_KEY, CONFIG.SETTINGS_KEY]);
  
  if (!data[CONFIG.STORAGE_KEY]) {
    await chrome.storage.local.set({
      [CONFIG.STORAGE_KEY]: {
        sessions: [],
        currentSessionId: null
      }
    });
  }
  
  if (!data[CONFIG.SETTINGS_KEY]) {
    await chrome.storage.local.set({
      [CONFIG.SETTINGS_KEY]: {
        maxSessions: CONFIG.MAX_SESSIONS,
        autoDelete: false,
        retentionDays: 30,
        deduplicateTabs: true
      }
    });
  }
}

// Show onboarding for first-time users
function showOnboarding() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('ui/onboarding.html')
  });
}

// Helper function to check if URL should be ignored
function isSystemUrl(url) {
  if (!url) return true;
  
  // Empty tabs
  if (url === 'chrome://newtab/' || url === 'about:blank' || url === 'about:newtab') {
    return true;
  }
  
  return url.startsWith('chrome://') || 
         url.startsWith('about:') || 
         url.startsWith('chrome-extension://') ||
         url.startsWith('edge://') ||
         url.startsWith('brave://') ||
         url.startsWith('moz-extension://') ||
         url.startsWith('opera://') ||
         url.startsWith('vivaldi://') ||
         url.startsWith('javascript:') ||
         url.startsWith('data:') ||
         url.startsWith('blob:');
}

// Monitor tab creation
chrome.tabs.onCreated.addListener(async (tab) => {
  console.log('[TAB EVENT] onCreated fired:', tab.id, tab.url, 'incognito:', tab.incognito);
  
  if (!tab.incognito) return;
  
  // Wait for initialization on mobile (service worker may restart)
  if (!isInitialized) {
    console.log('[TAB EVENT] Waiting for initialization...');
    await new Promise(r => setTimeout(r, 100));
    if (!isInitialized) return; // Still not ready, polling will catch it
  }
  
  if (isSystemUrl(tab.url)) {
    console.log('[TAB EVENT] Ignoring system URL:', tab.url);
    return;
  }
  
  // Mark this tab as known
  knownTabIds.add(tab.id);
  console.log('[TAB EVENT] Added to knownTabIds:', tab.id);
  
  // Check if this is first tab after all were closed - create new session
  if (!currentSessionId) {
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(t => t.incognito);
    if (incognitoTabs.length === 1) {
      console.log('Creating new session for first tab after all tabs were closed');
      currentSessionId = await createNewSession();
    }
  }
  
  await saveTabToCurrentSession(tab);
  updateBadge();
});

// Monitor tab updates (navigation)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.incognito) return;
  if (!isInitialized) return; // Polling will catch it
  
  if (changeInfo.url && !isSystemUrl(changeInfo.url)) {
    console.log('[TAB EVENT] URL changed:', changeInfo.url);
    knownTabIds.add(tabId);
    await updateTabInSession(tabId, tab);
  } else if (changeInfo.status === 'complete' && tab.url && !isSystemUrl(tab.url)) {
    await saveTabToCurrentSession(tab);
  } else if (changeInfo.title && !changeInfo.url) {
    await updateTabTitle(tabId, tab);
  }
  
  updateBadge();
});

// Monitor tab removal
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  knownTabIds.delete(tabId);
  
  if (saveTimeouts.has(tabId)) {
    clearTimeout(saveTimeouts.get(tabId));
    saveTimeouts.delete(tabId);
  }
  
  if (!isInitialized) return;
  
  try {
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    if (!storage || !currentSessionId) return;
    
    const session = storage.sessions.find(s => s.id === currentSessionId);
    if (!session) return;
    
    const removedTab = session.tabs.find(t => t.tabId === tabId);
    
    if (removedTab && !removeInfo.isWindowClosing) {
      // Move to closedTabs
      if (!session.closedTabs) session.closedTabs = [];
      removedTab.closedAt = Date.now();
      session.closedTabs.unshift(removedTab);
      
      // Limit closedTabs size
      if (session.closedTabs.length > CONFIG.MAX_CLOSED_TABS) {
        session.closedTabs = session.closedTabs.slice(0, CONFIG.MAX_CLOSED_TABS);
      }
      
      session.tabs = session.tabs.filter(t => t.tabId !== tabId);
      session.modified = Date.now();
      
      const sessionIndex = storage.sessions.findIndex(s => s.id === session.id);
      storage.sessions[sessionIndex] = session;
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
    }
    
    // Check if all incognito tabs closed
    const allTabs = await chrome.tabs.query({});
    if (!allTabs.some(t => t.incognito)) {
      currentSessionId = null;
      storage.currentSessionId = null;
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
    }
  } catch (error) {
    console.error('[TAB REMOVED] Error:', error);
  }
  
  updateBadge();
});

// Get or create current session
async function getCurrentSession() {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY] || { sessions: [], currentSessionId: null };
  
  if (!currentSessionId || !storage.sessions.find(s => s.id === currentSessionId)) {
    // Prevent concurrent session creation with promise lock
    if (!sessionCreationPromise) {
      sessionCreationPromise = createNewSession().finally(() => {
        sessionCreationPromise = null;
      });
    }
    currentSessionId = await sessionCreationPromise;
    
    // Reload storage after creating new session
    const updatedData = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const updatedStorage = updatedData[CONFIG.STORAGE_KEY];
    return updatedStorage.sessions.find(s => s.id === currentSessionId);
  }
  
  return storage.sessions.find(s => s.id === currentSessionId);
}

// Create new session with better date formatting
async function createNewSession() {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY] || { sessions: [] };
  
  const sessionId = `session_${Date.now()}`;
  const timestamp = Date.now();
  
  // Get all current incognito tabs to populate the new session
  const allTabs = await chrome.tabs.query({});
  const incognitoTabs = allTabs.filter(tab => tab.incognito);
  const validTabs = incognitoTabs.filter(tab => !isSystemUrl(tab.url));
  
  const tabs = validTabs.map(tab => ({
    id: `tab_${Date.now()}_${tab.id}`,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title || 'Loading...',
    timestamp: Date.now(),
    favicon: tab.favIconUrl || ''
  }));
  
  const newSession = {
    id: sessionId,
    name: formatSessionName(timestamp),
    created: timestamp,
    modified: timestamp,
    tabs: tabs, // May be empty initially, will be populated as tabs load
    closedTabs: []
  };
  
  storage.sessions.unshift(newSession);
  
  const settings = await getSettings();
  if (storage.sessions.length > settings.maxSessions) {
    storage.sessions = storage.sessions.slice(0, settings.maxSessions);
  }
  
  storage.currentSessionId = sessionId;
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  
  return sessionId;
}

// Format session name consistently
function formatSessionName(timestamp) {
  const date = new Date(timestamp);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  const time = date.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false
  });
  return `Session - ${month} ${day} at ${time}`;
}

// Save tab to current session
async function saveTabToCurrentSession(tab) {
  if (saveTimeouts.has(tab.id)) {
    clearTimeout(saveTimeouts.get(tab.id));
  }
  
  const timeout = setTimeout(async () => {
    try {
      const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
      const storage = data[CONFIG.STORAGE_KEY];
      if (!storage) return;
      
      // Ensure we have a session
      if (!currentSessionId || !storage.sessions.find(s => s.id === currentSessionId)) {
        if (!sessionCreationPromise) {
          sessionCreationPromise = createNewSession().finally(() => sessionCreationPromise = null);
        }
        currentSessionId = await sessionCreationPromise;
        // Reload after session creation
        const freshData = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
        Object.assign(storage, freshData[CONFIG.STORAGE_KEY]);
      }
      
      const session = storage.sessions.find(s => s.id === currentSessionId);
      if (!session) return;
      
      // Generate favicon URL - use Google's service as fallback for mobile
      let faviconUrl = tab.favIconUrl || '';
      if (!faviconUrl && tab.url) {
        try {
          const urlObj = new URL(tab.url);
          faviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
        } catch (e) {}
      }
      
      const tabEntry = {
        id: `tab_${Date.now()}_${tab.id}`,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title || 'Loading...',
        timestamp: Date.now(),
        favicon: faviconUrl
      };
      
      // Check by tabId first, then URL to prevent duplicates
      const existingByTabId = session.tabs.findIndex(t => t.tabId === tab.id);
      const existingByUrl = session.tabs.findIndex(t => t.url === tab.url);
      
      if (existingByTabId >= 0) {
        session.tabs[existingByTabId] = tabEntry;
      } else if (existingByUrl >= 0) {
        session.tabs[existingByUrl] = tabEntry;
      } else {
        session.tabs.push(tabEntry);
      }
      
      session.modified = Date.now();
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
    } catch (error) {
      console.error('[SAVE] Error:', error);
    } finally {
      saveTimeouts.delete(tab.id);
    }
  }, CONFIG.SAVE_DELAY);
  
  saveTimeouts.set(tab.id, timeout);
}

// Update tab in session (for navigation)
async function updateTabInSession(tabId, tab) {
  await saveTabToCurrentSession(tab);
}

// Update tab title only (without URL change)
async function updateTabTitle(tabId, tab) {
  try {
    const session = await getCurrentSession();
    if (!session) return;
    
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    
    const tabIndex = session.tabs.findIndex(t => t.tabId === tabId);
    if (tabIndex >= 0 && tab.title) {
      session.tabs[tabIndex].title = tab.title;
      session.tabs[tabIndex].favicon = tab.favIconUrl || session.tabs[tabIndex].favicon;
      session.modified = Date.now();
      
      const sessionIndex = storage.sessions.findIndex(s => s.id === session.id);
      storage.sessions[sessionIndex] = session;
      
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
    }
  } catch (error) {
    console.error('Error updating tab title:', error);
  }
}

// Update badge with tab count (debounced for performance)
async function updateBadge() {
  // Debounce badge updates to prevent excessive API calls
  if (badgeUpdateTimeout) {
    clearTimeout(badgeUpdateTimeout);
  }
  
  badgeUpdateTimeout = setTimeout(async () => {
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(t => t.incognito);
    const count = incognitoTabs.length;
    
    if (count > 0) {
      await chrome.action.setBadgeText({ text: count.toString() });
      await chrome.action.setBadgeBackgroundColor({ color: '#4A90E2' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
    
    badgeUpdateTimeout = null;
  }, 100); // Update at most once per 100ms
}

// Get settings
async function getSettings() {
  const data = await chrome.storage.local.get(CONFIG.SETTINGS_KEY);
  return data[CONFIG.SETTINGS_KEY] || {
    maxSessions: CONFIG.MAX_SESSIONS,
    autoDelete: false,
    retentionDays: 30,
    deduplicateTabs: true
  };
}

// Clean up empty sessions (sessions with no active tabs)
async function cleanupEmptySessions() {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];

  if (!storage || !storage.sessions) return;

  const originalCount = storage.sessions.length;

  // Remove ALL sessions that have no active tabs - no delay
  storage.sessions = storage.sessions.filter(session => {
    return session.tabs && session.tabs.length > 0;
  });

  const removedCount = originalCount - storage.sessions.length;

  if (removedCount > 0) {
    console.log(`Cleaned up ${removedCount} empty session(s)`);
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  }
}

// Open a tab in incognito mode
async function openTabInIncognito(url) {
  try {
    console.log('[OPEN TAB] Opening URL in incognito:', url);

    // Find an existing incognito tab to use as opener
    const allTabs = await chrome.tabs.query({});
    let incognitoTab = allTabs.find(t => t.incognito);

    console.log('[OPEN TAB] Found incognito tab:', incognitoTab ? incognitoTab.id : 'none');

    if (incognitoTab) {
      // Use existing incognito tab as opener to ensure new tab is also incognito
      const newTab = await chrome.tabs.create({
        url: url,
        active: true,
        openerTabId: incognitoTab.id
      });
      console.log('[OPEN TAB] Created tab:', newTab.id, 'incognito:', newTab.incognito);
    } else {
      // No incognito tab exists, create new incognito window
      console.log('[OPEN TAB] No incognito tab found, creating new window');
      const newWindow = await chrome.windows.create({
        url: url,
        incognito: true,
        focused: true
      });
      console.log('[OPEN TAB] Created incognito window:', newWindow.id);
    }
  } catch (error) {
    console.error('[OPEN TAB] Error opening tab in incognito:', error);
    throw error;
  }
}

// Restore closed tabs from a session
async function restoreClosedTabsInBackground(sessionId) {
  try {
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    const session = storage.sessions.find(s => s.id === sessionId);

    if (!session || !session.closedTabs || session.closedTabs.length === 0) {
      console.log('[RESTORE CLOSED] No closed tabs to restore');
      return;
    }

    console.log(`[RESTORE CLOSED] Restoring ${session.closedTabs.length} closed tabs`);

    // Find an existing incognito tab to use as opener
    const allTabs = await chrome.tabs.query({});
    let incognitoTab = allTabs.find(t => t.incognito);

    console.log('[RESTORE CLOSED] Found incognito tab:', incognitoTab ? incognitoTab.id : 'none');

    // If no incognito tab exists, create one first
    if (!incognitoTab) {
      console.log('[RESTORE CLOSED] Creating new incognito window');
      const firstUrl = session.closedTabs[0]?.url || 'about:blank';
      const newWindow = await chrome.windows.create({
        url: firstUrl,
        incognito: true,
        focused: true
      });

      const tabs = await chrome.tabs.query({ windowId: newWindow.id });
      incognitoTab = tabs[0];
      console.log('[RESTORE CLOSED] Created incognito tab:', incognitoTab.id);

      // Remove first tab from list since we already opened it
      session.closedTabs = session.closedTabs.slice(1);
    }

    // Restore remaining closed tabs using the incognito tab as opener
    for (const tab of session.closedTabs) {
      try {
        const newTab = await chrome.tabs.create({
          url: tab.url,
          active: false,
          openerTabId: incognitoTab.id
        });
        console.log('[RESTORE CLOSED] Created tab:', newTab.id, 'incognito:', newTab.incognito);
        // Add small delay for mobile browser stability
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[RESTORE CLOSED] Failed to restore closed tab ${tab.url}:`, error);
        // Continue with next tab
      }
    }

    console.log('[RESTORE CLOSED] Restore complete');
  } catch (error) {
    console.error('[RESTORE CLOSED] Error restoring closed tabs:', error);
    throw error;
  }
}

// Message handler for popup/options communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'getSessions':
          // Clean up empty sessions before returning data
          await cleanupEmptySessions();
          const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
          sendResponse({ success: true, data: data[CONFIG.STORAGE_KEY] });
          break;
          
        case 'restoreSession':
          await restoreSession(message.sessionId);
          sendResponse({ success: true });
          break;
          
        case 'deleteSession':
          await deleteSession(message.sessionId);
          sendResponse({ success: true });
          break;
          
        case 'createNewSession':
          const newId = await createNewSession();
          sendResponse({ success: true, sessionId: newId });
          break;
          
        case 'renameSession':
          await renameSession(message.sessionId, message.newName);
          sendResponse({ success: true });
          break;
          
        case 'exportSessions':
          const exportData = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
          sendResponse({ success: true, data: exportData[CONFIG.STORAGE_KEY] });
          break;
          
        case 'importSessions':
          await importSessions(message.data);
          sendResponse({ success: true });
          break;

        case 'openTab':
          await openTabInIncognito(message.url);
          sendResponse({ success: true });
          break;

        case 'restoreClosedTabs':
          await restoreClosedTabsInBackground(message.sessionId);
          sendResponse({ success: true });
          break;

        case 'ping':
          // Keepalive + sync on popup open
          await pollForMissedTabs();
          sendResponse({ success: true, timestamp: Date.now() });
          break;

        case 'openIncognitoTabs':
          // METHOD 5: Try various ways to open incognito tabs from background
          console.log('[BG METHOD 5] Attempting to open incognito tabs:', message.urls);
          try {
            const results = [];
            for (const url of message.urls) {
              // Try 5a: window.create with incognito
              try {
                const win = await chrome.windows.create({ incognito: true, url: url });
                console.log('[BG 5a] windows.create result:', win.id, 'incognito:', win.incognito);
                results.push({ method: '5a', url, incognito: win.incognito });
              } catch (e) {
                console.log('[BG 5a] Failed:', e.message);
              }
              await new Promise(r => setTimeout(r, 300));
            }
            sendResponse({ success: true, results });
          } catch (error) {
            console.error('[BG METHOD 5] Error:', error);
            sendResponse({ success: false, error: error.message });
          }
          break;

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();
  
  return true;
});

// Restore session
async function restoreSession(sessionId) {
  console.log('Restore session called for:', sessionId);
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];
  console.log('Storage data:', storage);
  const session = storage.sessions.find(s => s.id === sessionId);

  if (!session) {
    console.error('Session not found:', sessionId);
    throw new Error('Session not found');
  }

  console.log('Found session:', session.name, 'with', session.tabs.length, 'tabs');
  console.log('Tabs to restore:', session.tabs);

  // Set this session as the current session so new tabs are saved to it
  currentSessionId = sessionId;
  storage.currentSessionId = sessionId;
  // Clear the "(Closed)" suffix if it exists
  if (session.name.endsWith(' (Closed)')) {
    session.name = session.name.replace(' (Closed)', '');
  }
  session.modified = Date.now();

  // Save the tab URLs before clearing (we'll restore these)
  const tabsToRestore = [...session.tabs];

  // Clear existing tabs since they have old tabIds - they'll be repopulated as Chrome creates new tabs
  session.tabs = [];

  const sessionIndex = storage.sessions.findIndex(s => s.id === sessionId);
  storage.sessions[sessionIndex] = session;
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  console.log('Set current session to:', sessionId);

  // KIWI BROWSER FINAL WORKAROUND: Navigate pre-opened incognito tabs
  // All programmatic methods to CREATE incognito tabs fail on Kiwi:
  // - chrome.windows.create({incognito: true}) - creates normal tabs on mobile
  // - chrome.tabs.create({openerTabId}) - ignores incognito inheritance
  // - chrome.tabs.duplicate() - CRASHES the browser
  // The ONLY working method: Navigate existing incognito tabs

  console.log('[RESTORE] Using manual workaround: Navigate pre-opened incognito tabs');

  // Get all existing incognito tabs
  const allTabs = await chrome.tabs.query({});
  const incognitoTabs = allTabs.filter(t => t.incognito);

  // Sort by tab index to use tabs in visual order
  incognitoTabs.sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });

  console.log(`[RESTORE] Found ${incognitoTabs.length} pre-opened incognito tabs`);
  console.log(`[RESTORE] Need to restore ${tabsToRestore.length} URLs`);

  // If no incognito tabs exist, require user to open them manually
  if (incognitoTabs.length === 0) {
    console.log('[RESTORE] No incognito tabs found');
    throw new Error(
      '⚠️ Kiwi Browser Limitation\n\n' +
      'Kiwi cannot create incognito tabs automatically.\n\n' +
      'WORKAROUND:\n' +
      `1. Manually open ${tabsToRestore.length} incognito tabs\n` +
      '2. Try restoring again\n\n' +
      'The extension will navigate your tabs to the saved URLs.'
    );
  }

  // Check if we have enough incognito tabs
  if (incognitoTabs.length < tabsToRestore.length) {
    const deficit = tabsToRestore.length - incognitoTabs.length;
    console.warn(`[RESTORE] Not enough incognito tabs. Have: ${incognitoTabs.length}, Need: ${tabsToRestore.length}`);
    throw new Error(
      `⚠️ Kiwi Browser Limitation\n\n` +
      `You have ${incognitoTabs.length} incognito tab${incognitoTabs.length > 1 ? 's' : ''}.\n` +
      `Session needs ${tabsToRestore.length} tabs.\n\n` +
      `Please open ${deficit} more incognito tab${deficit > 1 ? 's' : ''} manually and try again.\n\n` +
      `Why? Kiwi can't create incognito tabs automatically.`
    );
  }

  // Navigate each existing incognito tab to a URL from the session
  console.log(`[RESTORE] Navigating ${tabsToRestore.length} existing incognito tabs`);
  for (let i = 0; i < tabsToRestore.length; i++) {
    const targetTab = incognitoTabs[i];
    const sessionTab = tabsToRestore[i];

    try {
      console.log(`[RESTORE] Tab ${i + 1}/${tabsToRestore.length}: ${targetTab.id} → ${sessionTab.url}`);
      await chrome.tabs.update(targetTab.id, {
        url: sessionTab.url,
        active: false
      });

      // Small delay for stability on mobile
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`[RESTORE] Failed to navigate tab ${targetTab.id} to ${sessionTab.url}:`, error);
      // Continue with next tab
    }
  }

  console.log('[RESTORE] Restore complete');
}

// Delete session
async function deleteSession(sessionId) {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];
  
  storage.sessions = storage.sessions.filter(s => s.id !== sessionId);
  
  if (storage.currentSessionId === sessionId) {
    storage.currentSessionId = null;
    currentSessionId = null;
  }
  
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
}

// Rename session
async function renameSession(sessionId, newName) {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];
  const session = storage.sessions.find(s => s.id === sessionId);
  
  if (session) {
    session.name = newName;
    session.modified = Date.now();
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  }
}

// Import sessions
async function importSessions(importData) {
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: importData });
}

// Cleanup old sessions periodically
setInterval(async () => {
  const settings = await getSettings();
  if (!settings.autoDelete) return;
  
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];
  const cutoff = Date.now() - (settings.retentionDays * 24 * 60 * 60 * 1000);
  
  const originalCount = storage.sessions.length;
  storage.sessions = storage.sessions.filter(s => s.modified > cutoff);
  
  if (storage.sessions.length < originalCount) {
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  }
}, 60 * 60 * 1000);

// Mobile fallback: Poll for tabs that events missed (Kiwi Browser fix)
async function pollForMissedTabs() {
  try {
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(t => t.incognito && !isSystemUrl(t.url));

    if (incognitoTabs.length === 0) {
      knownTabIds.clear();
      return;
    }

    // Ensure we have a session
    if (!currentSessionId && incognitoTabs.length > 0) {
      currentSessionId = await createNewSession();
    }

    // Find and save missed tabs
    for (const tab of incognitoTabs) {
      if (!knownTabIds.has(tab.id)) {
        console.log('[POLL] Detected missed tab:', tab.id, tab.url?.substring(0, 50));
        knownTabIds.add(tab.id);
        await saveTabToCurrentSession(tab);
      }
    }

    // Clean up closed tabs from tracking
    const currentTabIds = new Set(incognitoTabs.map(t => t.id));
    for (const knownId of knownTabIds) {
      if (!currentTabIds.has(knownId)) {
        knownTabIds.delete(knownId);
      }
    }
  } catch (error) {
    console.error('[POLL] Error:', error);
  }
}

// Alarm listener for persistent polling on mobile (survives service worker suspension)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[ALARM] Mobile polling alarm triggered');
    pollForMissedTabs();
  }
});

// Create persistent alarm for mobile browsers (every 1 minute minimum, Chrome API limitation)
// We also poll on other events to catch tabs sooner
async function setupMobilePolling() {
  // Clear any existing alarm
  await chrome.alarms.clear(ALARM_NAME);
  // Create new alarm - minimum period is 1 minute for Chrome extensions
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  console.log('[MOBILE FALLBACK] Created persistent polling alarm (1 minute intervals)');
}

// Additional event listeners to trigger polling more frequently on mobile
// These help catch tabs sooner than the 1-minute alarm
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    console.log('[WINDOW EVENT] Window focus changed, polling for tabs');
    pollForMissedTabs();
  }
});

chrome.tabs.onActivated.addListener(() => {
  console.log('[TAB EVENT] Tab activated, polling for tabs');
  pollForMissedTabs();
});

// Initialize on startup (runs every time service worker starts, not just on install)
(async () => {
  console.log('[STARTUP] Service worker starting up...');
  await initializeStorage();

  const allTabs = await chrome.tabs.query({});
  const incognitoTabs = allTabs.filter(t => t.incognito);
  console.log(`[STARTUP] Found ${incognitoTabs.length} existing incognito tabs`);

  if (incognitoTabs.length > 0) {
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    currentSessionId = data[CONFIG.STORAGE_KEY]?.currentSessionId;
    console.log('[STARTUP] Restored currentSessionId:', currentSessionId);

    // Populate knownTabIds with existing tabs
    incognitoTabs.forEach(tab => {
      if (!isSystemUrl(tab.url)) {
        knownTabIds.add(tab.id);
        console.log('[STARTUP] Added existing tab to tracking:', tab.id, tab.url);
      }
    });
  }

  // Setup persistent polling for mobile browsers
  await setupMobilePolling();

  updateBadge();

  // Run initial poll to catch any existing tabs
  console.log('[STARTUP] Running initial poll...');
  await pollForMissedTabs();

  isInitialized = true;
  console.log('[STARTUP] Service worker initialization complete');
})();
