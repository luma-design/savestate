// Background Service Worker for Tab Saver (Dual Mode: Incognito & Regular)
// Handles tab monitoring, session management, and storage operations
// Respects execution context (split mode)

let isIncognito = false;
let debugProbe = '';
let CONFIG = {
  MAX_SESSIONS: 50,
  MAX_CLOSED_TABS: 50,
  STORAGE_KEY: 'regular_sessions',
  SETTINGS_KEY: 'regular_settings',
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000,
  SAVE_DELAY: 50
};

let currentSessionId = null;
let saveTimeouts = new Map();
let sessionCreationPromise = null;
let badgeUpdateTimeout = null;
let knownTabIds = new Set();
let isInitialized = false;

// Robust Incognito Detection
async function detectIncognitoContext() {
  debugProbe = 'Start|';

  // Method 1: chrome.extension.inIncognitoContext (Legacy but direct)
  try {
    if (typeof chrome.extension !== 'undefined' && typeof chrome.extension.inIncognitoContext !== 'undefined') {
      if (chrome.extension.inIncognitoContext) {
        debugProbe += 'Ext:TRUE|';
        return true;
      }
      debugProbe += 'Ext:FALSE|';
    } else {
      debugProbe += 'Ext:Undef|';
    }
  } catch (e) { debugProbe += `Ext:Err(${e.message})|`; }

  // Method 2: chrome.runtime.getContexts (MV3)
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['BACKGROUND']
      });
      const incogContext = contexts.find(c => c.incognito);
      if (incogContext) {
        debugProbe += 'Ctx:TRUE|';
        return true;
      } else {
        debugProbe += `Ctx:FALSE(len=${contexts.length})|`;
      }
    } else {
      debugProbe += 'Ctx:API_Missing|';
    }
  } catch (e) { debugProbe += `Ctx:Err(${e.message})|`; }

  debugProbe += 'FALLBACK:FALSE';
  return false;
}

// Initialization Logic
async function initialize() {
  if (isInitialized) return;

  console.log('[INIT] Initializing service worker...');

  // 1. Detect Mode
  isIncognito = await detectIncognitoContext();
  const STORAGE_PREFIX = isIncognito ? 'incognito' : 'regular';

  // 2. Configure
  CONFIG = {
    MAX_SESSIONS: 50,
    MAX_CLOSED_TABS: 50,
    STORAGE_KEY: `${STORAGE_PREFIX}_sessions`,
    SETTINGS_KEY: `${STORAGE_PREFIX}_settings`,
    SESSION_TIMEOUT: 24 * 60 * 60 * 1000,
    SAVE_DELAY: 50
  };

  console.log(`[INIT] Detected Mode: ${isIncognito ? 'INCOGNITO' : 'REGULAR'}`);
  console.log(`[INIT] Probe: ${debugProbe}`);
  console.log(`[INIT] Storage Key: ${CONFIG.STORAGE_KEY}`);

  // 3. Setup Storage
  await initializeStorage();

  // 4. Mobile Polling
  await setupMobilePolling();

  // Poll for missed tabs (DEADLOCK FIX: Do not await ensureInitialized inside this call stack)
  await pollForMissedTabs();

  isInitialized = true;
  console.log('[INIT] Initialization complete.');
}

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(async (details) => {
  await initialize();
  if (details.reason === 'install' && !isIncognito) {
    showOnboarding();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await initialize();
});

// Ensure initialization before handling events or messages
async function ensureInitialized() {
  if (!isInitialized) {
    await initialize();
  }
}

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
  } else {
    // Restore session state
    if (data[CONFIG.STORAGE_KEY].currentSessionId) {
      currentSessionId = data[CONFIG.STORAGE_KEY].currentSessionId;
      console.log('[INIT] Restored currentSessionId:', currentSessionId);
    }
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

function showOnboarding() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('ui/onboarding.html')
  });
}

function isSystemUrl(url) {
  if (!url) return true;
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
  await ensureInitialized(); // Entry point - safe to init

  if (tab.incognito !== isIncognito) return;
  if (isSystemUrl(tab.url)) return;

  knownTabIds.add(tab.id);

  if (!currentSessionId) {
    const allTabs = await chrome.tabs.query({});
    const contextTabs = allTabs.filter(t => t.incognito === isIncognito);
    if (contextTabs.length <= 1) {
      currentSessionId = await createNewSession();
    }
  }

  await saveTabToCurrentSession(tab);
  updateBadge();
});

// Monitor tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensureInitialized(); // Entry point - safe to init
  if (tab.incognito !== isIncognito) return;

  if (changeInfo.url && !isSystemUrl(changeInfo.url)) {
    knownTabIds.add(tabId);
    await updateTabInSession(tabId, tab);
  } else if (changeInfo.status === 'complete' && tab.url && !isSystemUrl(tab.url)) {
    await saveTabToCurrentSession(tab);
  } else if (changeInfo.title) {
    await updateTabTitle(tabId, tab);
  }

  updateBadge();
});

// Monitor tab removal
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureInitialized(); // Entry point - safe to init
  knownTabIds.delete(tabId);

  if (saveTimeouts.has(tabId)) {
    clearTimeout(saveTimeouts.get(tabId));
    saveTimeouts.delete(tabId);
  }

  try {
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    if (!storage || !currentSessionId) return;

    const session = storage.sessions.find(s => s.id === currentSessionId);
    if (!session) return;

    const removedTab = session.tabs.find(t => t.tabId === tabId);

    if (removedTab) {
      if (!session.closedTabs) session.closedTabs = [];
      removedTab.closedAt = Date.now();
      session.closedTabs.unshift(removedTab);

      if (session.closedTabs.length > CONFIG.MAX_CLOSED_TABS) {
        session.closedTabs = session.closedTabs.slice(0, CONFIG.MAX_CLOSED_TABS);
      }

      session.tabs = session.tabs.filter(t => t.tabId !== tabId);
      session.modified = Date.now();

      const sessionIndex = storage.sessions.findIndex(s => s.id === session.id);
      storage.sessions[sessionIndex] = session;
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
    }

    const allTabs = await chrome.tabs.query({});
    const contextTabs = allTabs.filter(t => t.incognito === isIncognito);

    if (contextTabs.length === 0) {
      currentSessionId = null;
      storage.currentSessionId = null;
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
    }
  } catch (error) {
    console.error('[TAB REMOVED] Error:', error);
  }

  updateBadge();
});

// Helpers - NO await ensureInitialized() in internal helpers to avoid deadlock with initialize() loop

async function getCurrentSession() {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY] || { sessions: [], currentSessionId: null };
  return storage.sessions.find(s => s.id === currentSessionId);
}

async function createNewSession(origin = 'auto', customName = null) {
  // Removed ensureInitialized() here
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY] || { sessions: [] };

  // If manual creation (user hit +), tag the current session as 'saved'
  if (origin === 'manual' && currentSessionId) {
    const currentSession = storage.sessions.find(s => s.id === currentSessionId);
    if (currentSession) {
      currentSession.type = 'saved';
      // Apply the custom name to the session we are SAVING (archiving)
      if (customName) {
        currentSession.name = customName;
      }
    }
  }

  const sessionId = `session_${Date.now()}`;
  const timestamp = Date.now();

  const allTabs = await chrome.tabs.query({});
  const contextTabs = allTabs.filter(tab => tab.incognito === isIncognito);
  const validTabs = contextTabs.filter(tab => !isSystemUrl(tab.url));

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
    // New session starts blank/default. Custom name was for the previous one.
    name: formatSessionName(timestamp),
    created: timestamp,
    modified: timestamp,
    tabs: tabs,
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

function formatSessionName(timestamp) {
  return '';
}

async function saveTabToCurrentSession(tab) {
  if (saveTimeouts.has(tab.id)) clearTimeout(saveTimeouts.get(tab.id));

  const timeout = setTimeout(async () => {
    try {
      if (!currentSessionId) {
        if (!sessionCreationPromise) {
          sessionCreationPromise = createNewSession().finally(() => sessionCreationPromise = null);
        }
        await sessionCreationPromise;
      }

      const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
      const storage = data[CONFIG.STORAGE_KEY];
      if (!storage) return;

      const session = storage.sessions.find(s => s.id === currentSessionId);
      if (!session) return;

      let faviconUrl = tab.favIconUrl || '';
      if (!faviconUrl && tab.url) {
        try {
          const urlObj = new URL(tab.url);
          faviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
        } catch (e) { }
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

async function updateTabInSession(tabId, tab) {
  await saveTabToCurrentSession(tab);
}

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

async function updateBadge() {
  if (badgeUpdateTimeout) clearTimeout(badgeUpdateTimeout);

  badgeUpdateTimeout = setTimeout(async () => {
    const allTabs = await chrome.tabs.query({});
    const contextTabs = allTabs.filter(t => t.incognito === isIncognito);
    const count = contextTabs.length;

    if (count > 0) {
      await chrome.action.setBadgeText({ text: count.toString() });
      await chrome.action.setBadgeBackgroundColor({ color: '#4A90E2' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }

    badgeUpdateTimeout = null;
  }, 100);
}

async function getSettings() {
  const data = await chrome.storage.local.get(CONFIG.SETTINGS_KEY);
  return data[CONFIG.SETTINGS_KEY] || {
    maxSessions: CONFIG.MAX_SESSIONS,
    autoDelete: false,
    retentionDays: 30,
    deduplicateTabs: true
  };
}

async function cleanupEmptySessions() {
  // Removed ensureInitialized() here
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];

  if (!storage || !storage.sessions) return;

  const originalCount = storage.sessions.length;

  storage.sessions = storage.sessions.filter(session => {
    return session.tabs && session.tabs.length > 0;
  });

  if (storage.sessions.length < originalCount) {
    console.log(`Cleaned up ${originalCount - storage.sessions.length} empty session(s)`);
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  }
}

async function openTabInContext(url) {
  try {
    if (isIncognito) {
      const allTabs = await chrome.tabs.query({});
      let incognitoTab = allTabs.find(t => t.incognito);

      if (incognitoTab) {
        await chrome.tabs.create({
          url: url,
          active: true,
          openerTabId: incognitoTab.id
        });
      } else {
        await chrome.windows.create({
          url: url,
          incognito: true,
          focused: true
        });
      }
    } else {
      await chrome.tabs.create({ url: url, active: true });
    }
  } catch (error) {
    console.error('[OPEN TAB] Error opening tab:', error);
    throw error;
  }
}

async function restoreClosedTabsInBackground(sessionId) {
  try {
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    const session = storage.sessions.find(s => s.id === sessionId);

    if (!session || !session.closedTabs || session.closedTabs.length === 0) return;

    let openerTab = null;
    if (isIncognito) {
      const allTabs = await chrome.tabs.query({});
      openerTab = allTabs.find(t => t.incognito);

      if (!openerTab) {
        const firstUrl = session.closedTabs[0]?.url || 'about:blank';
        const newWindow = await chrome.windows.create({
          url: firstUrl,
          incognito: true,
          focused: true
        });
        const tabs = await chrome.tabs.query({ windowId: newWindow.id });
        openerTab = tabs[0];
        session.closedTabs = session.closedTabs.slice(1);
      }
    }

    for (const tab of session.closedTabs) {
      const createProps = { url: tab.url, active: false };
      if (isIncognito && openerTab) createProps.openerTabId = openerTab.id;
      await chrome.tabs.create(createProps);
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (error) {
    console.error('[RESTORE CLOSED] Error:', error);
  }
}

// Message Handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      await ensureInitialized(); // Entry point - safe to init

      switch (message.action) {
        case 'getSessions':
          await cleanupEmptySessions();
          const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
          sendResponse({
            success: true,
            data: data[CONFIG.STORAGE_KEY],
            mode: isIncognito ? 'incognito' : 'regular',
            probe: debugProbe
          });
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
          const newId = await createNewSession('manual', message.name);
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
          await openTabInContext(message.url);
          sendResponse({ success: true });
          break;

        case 'restoreClosedTabs':
          await restoreClosedTabsInBackground(message.sessionId);
          sendResponse({ success: true });
          break;

        case 'ping':
          await pollForMissedTabs();
          sendResponse({ success: true, timestamp: Date.now() });
          break;

        case 'openSavedSession':
          await openSavedSession(message.sessionId);
          sendResponse({ success: true });
          break;

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('[MSG ERROR]', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true;
});

async function openSavedSession(sessionId) {
  try {
    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    const session = storage.sessions.find(s => s.id === sessionId);

    if (!session || !session.tabs || session.tabs.length === 0) return;

    let startIndex = 0;
    if (isIncognito) {
      const allTabs = await chrome.tabs.query({});
      const hasIncognito = allTabs.some(t => t.incognito);
      if (!hasIncognito) {
        const firstUrl = session.tabs[0]?.url || 'about:blank';
        await chrome.windows.create({
          url: firstUrl,
          incognito: true,
          focused: true
        });
        startIndex = 1;
      }
    }

    for (let i = startIndex; i < session.tabs.length; i++) {
      const tab = session.tabs[i];
      await chrome.tabs.create({ url: tab.url, active: false });
      await new Promise(r => setTimeout(r, 150));
    }
  } catch (error) {
    console.error('[OPEN SESSION] Error:', error);
  }
}

async function restoreSession(sessionId) {
  const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
  const storage = data[CONFIG.STORAGE_KEY];
  const session = storage.sessions.find(s => s.id === sessionId);

  if (!session) throw new Error('Session not found');

  currentSessionId = sessionId;
  storage.currentSessionId = sessionId;
  if (session.name.endsWith(' (Closed)')) {
    session.name = session.name.replace(' (Closed)', '');
  }
  session.modified = Date.now();

  const tabsToRestore = [...session.tabs];
  session.tabs = [];

  const sessionIndex = storage.sessions.findIndex(s => s.id === sessionId);
  storage.sessions[sessionIndex] = session;
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });

  if (!isIncognito) {
    for (const tab of tabsToRestore) {
      await chrome.tabs.create({ url: tab.url, active: false });
    }
  } else {
    // Incognito logic (Kiwi friendly)
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(t => t.incognito);
    incognitoTabs.sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.index - b.index;
    });

    if (incognitoTabs.length < tabsToRestore.length) {
      throw new Error(`Need ${tabsToRestore.length - incognitoTabs.length} more incognito tabs.`);
    }

    for (let i = 0; i < tabsToRestore.length; i++) {
      await chrome.tabs.update(incognitoTabs[i].id, {
        url: tabsToRestore[i].url,
        active: false
      });
    }
  }
}

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

async function importSessions(importData) {
  await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: importData });
}

async function setupMobilePolling() {
  // Safe place for any mobile specific startup logic
}

async function pollForMissedTabs() {
  // Removed ensureInitialized() here
  try {
    const allTabs = await chrome.tabs.query({});
    const contextTabs = allTabs.filter(t => t.incognito === isIncognito && !isSystemUrl(t.url));

    if (contextTabs.length === 0) {
      knownTabIds.clear();
      return;
    }

    if (!currentSessionId && contextTabs.length > 0) {
      currentSessionId = await createNewSession();
    }
  } catch (e) {
    console.error(e);
  }
}

// Cleanup interval
setInterval(async () => {
  try {
    await ensureInitialized(); // This is FINE because it's an interval, not initialization
    const settings = await getSettings();
    if (!settings.autoDelete) return;

    const data = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
    const storage = data[CONFIG.STORAGE_KEY];
    const cutoff = Date.now() - (settings.retentionDays * 24 * 60 * 60 * 1000);

    storage.sessions = storage.sessions.filter(s => s.modified > cutoff);
    await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: storage });
  } catch (e) { }
}, 60 * 60 * 1000);
