/**
 * SessionManager - Centralized session management for the Savestate extension
 * Handles session creation, updates, closure, and tab management with atomic operations
 */

class SessionManager {
  constructor(config = {}) {
    this.CONFIG = {
      MAX_SESSIONS: config.MAX_SESSIONS || 50,
      MAX_CLOSED_TABS: config.MAX_CLOSED_TABS || 50,
      STORAGE_KEY: config.STORAGE_KEY || 'incognito_sessions',
      SETTINGS_KEY: config.SETTINGS_KEY || 'incognito_settings',
      SESSION_TIMEOUT: config.SESSION_TIMEOUT || 24 * 60 * 60 * 1000,
      SAVE_DELAY: config.SAVE_DELAY || 50,
      ...config
    };

    this.currentSessionId = null;
    this.isInitialized = false;
    this.sessionCreationPromise = null;
    this.saveTimeouts = new Map();
    this.knownTabIds = new Set();
    this.sessionCounter = Math.random() * 10000; // Add random component for unique IDs
  }

  /**
   * Initialize the session manager from storage
   */
  async initialize() {
    try {
      const data = await this.getStorage();
      this.currentSessionId = data.currentSessionId || null;
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('[SessionManager] Initialization error:', error);
      this.isInitialized = true; // Mark as initialized even on error
      return false;
    }
  }

  /**
   * Get current storage state
   */
  async getStorage() {
    const data = await chrome.storage.local.get(this.CONFIG.STORAGE_KEY);
    return data[this.CONFIG.STORAGE_KEY] || { sessions: [], currentSessionId: null };
  }

  /**
   * Save storage state atomically
   */
  async saveStorage(storage) {
    await chrome.storage.local.set({ [this.CONFIG.STORAGE_KEY]: storage });
  }

  /**
   * Get the current active session
   */
  async getCurrentSession() {
    const storage = await this.getStorage();

    if (!this.currentSessionId || !storage.sessions.find(s => s.id === this.currentSessionId)) {
      return null;
    }

    return storage.sessions.find(s => s.id === this.currentSessionId);
  }

  /**
   * Ensure an active session exists, creating one if necessary
   * Property 1: Single session creation for existing tabs
   */
  async ensureActiveSession() {
    const storage = await this.getStorage();

    // If we already have an active session, return it
    if (this.currentSessionId && storage.sessions.find(s => s.id === this.currentSessionId)) {
      return this.currentSessionId;
    }

    // Prevent concurrent session creation
    if (!this.sessionCreationPromise) {
      this.sessionCreationPromise = this.createNewSession().finally(() => {
        this.sessionCreationPromise = null;
      });
    }

    this.currentSessionId = await this.sessionCreationPromise;
    return this.currentSessionId;
  }

  /**
   * Create a new session
   */
  async createNewSession() {
    const storage = await this.getStorage();
    this.sessionCounter++;
    const sessionId = `session_${Date.now()}_${this.sessionCounter}`;
    const timestamp = Date.now();

    // Get all current incognito tabs
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(tab => tab.incognito);
    const validTabs = incognitoTabs.filter(tab => !this.isSystemUrl(tab.url));

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
      name: this.formatSessionName(timestamp),
      created: timestamp,
      modified: timestamp,
      tabs: tabs,
      closedTabs: []
    };

    storage.sessions.unshift(newSession);

    // Enforce max sessions limit
    if (storage.sessions.length > this.CONFIG.MAX_SESSIONS) {
      storage.sessions = storage.sessions.slice(0, this.CONFIG.MAX_SESSIONS);
    }

    storage.currentSessionId = sessionId;
    this.currentSessionId = sessionId;

    await this.saveStorage(storage);
    return sessionId;
  }

  /**
   * Add a tab to the current session
   * Property 2: Tab addition to existing session
   */
  async addTabToSession(tab) {
    if (!this.currentSessionId) {
      await this.ensureActiveSession();
    }

    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === this.currentSessionId);

    if (!session) {
      throw new Error('Current session not found');
    }

    const tabEntry = {
      id: `tab_${Date.now()}_${tab.id}`,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title || 'Loading...',
      timestamp: Date.now(),
      favicon: tab.favIconUrl || ''
    };

    // Check for duplicates by tabId or URL
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
    await this.saveStorage(storage);
  }

  /**
   * Update a tab in the current session
   * Property 3: Tab update preservation
   */
  async updateTabInSession(tabId, tab) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === this.currentSessionId);

    if (!session) {
      throw new Error('Current session not found');
    }

    const tabIndex = session.tabs.findIndex(t => t.tabId === tabId);

    if (tabIndex >= 0) {
      session.tabs[tabIndex] = {
        ...session.tabs[tabIndex],
        url: tab.url,
        title: tab.title !== undefined ? tab.title : session.tabs[tabIndex].title,
        favicon: tab.favIconUrl !== undefined ? tab.favIconUrl : session.tabs[tabIndex].favicon,
        timestamp: Date.now()
      };

      session.modified = Date.now();
      await this.saveStorage(storage);
    }
  }

  /**
   * Move a tab to closed tabs
   */
  async moveTabToClosedTabs(tabId) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === this.currentSessionId);

    if (!session) {
      return;
    }

    const tabIndex = session.tabs.findIndex(t => t.tabId === tabId);

    if (tabIndex >= 0) {
      const tab = session.tabs[tabIndex];
      tab.closedAt = Date.now();

      if (!session.closedTabs) {
        session.closedTabs = [];
      }

      session.closedTabs.unshift(tab);

      // Enforce closed tabs limit
      if (session.closedTabs.length > this.CONFIG.MAX_CLOSED_TABS) {
        session.closedTabs = session.closedTabs.slice(0, this.CONFIG.MAX_CLOSED_TABS);
      }

      session.tabs = session.tabs.filter(t => t.tabId !== tabId);
      session.modified = Date.now();

      await this.saveStorage(storage);
    }
  }

  /**
   * Close a session
   */
  async closeSession(sessionId) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === sessionId);

    if (session) {
      session.status = 'closed';
      session.modified = Date.now();

      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null;
        storage.currentSessionId = null;
      }

      await this.saveStorage(storage);
    }
  }

  /**
   * Restore session state from storage
   * Property 4: Session state restoration
   */
  async restoreSessionState() {
    const storage = await this.getStorage();
    this.currentSessionId = storage.currentSessionId || null;
    return this.currentSessionId;
  }

  /**
   * Update session timestamp
   * Property 5: Timestamp update on changes
   */
  async updateSessionTimestamp(sessionId) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === sessionId);

    if (session) {
      session.modified = Date.now();
      await this.saveStorage(storage);
    }
  }

  /**
   * Helper: Check if URL is a system URL
   */
  isSystemUrl(url) {
    if (!url) return true;

    return url === 'chrome://newtab/' ||
      url === 'about:blank' ||
      url === 'about:newtab' ||
      url.startsWith('chrome://') ||
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

  /**
   * Helper: Format session name
   */
  formatSessionName(timestamp) {
    return '';
  }

  /**
   * Get all sessions
   */
  async getAllSessions() {
    const storage = await this.getStorage();
    return storage.sessions;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId) {
    const storage = await this.getStorage();
    storage.sessions = storage.sessions.filter(s => s.id !== sessionId);

    if (storage.currentSessionId === sessionId) {
      storage.currentSessionId = null;
      this.currentSessionId = null;
    }

    await this.saveStorage(storage);
  }

  /**
   * Rename a session
   */
  async renameSession(sessionId, newName) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === sessionId);

    if (session) {
      session.name = newName;
      session.modified = Date.now();
      await this.saveStorage(storage);
    }
  }

  /**
   * Check if all incognito tabs are closed
   * Property 16: Session closure on tab closure
   */
  async checkAndCloseSessionIfAllTabsClosed() {
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(tab => tab.incognito);
    const validIncognitoTabs = incognitoTabs.filter(tab => !this.isSystemUrl(tab.url));

    if (validIncognitoTabs.length === 0 && this.currentSessionId) {
      const storage = await this.getStorage();
      const session = storage.sessions.find(s => s.id === this.currentSessionId);

      if (session) {
        session.status = 'closed';
        session.modified = Date.now();
        storage.currentSessionId = null;
        this.currentSessionId = null;
        await this.saveStorage(storage);
      }
      return true;
    }
    return false;
  }

  /**
   * Save current session and create a new one for subsequent activity
   * Property 17: New session after manual save
   */
  async manualSaveSession() {
    if (this.currentSessionId) {
      const storage = await this.getStorage();
      const session = storage.sessions.find(s => s.id === this.currentSessionId);

      if (session) {
        session.status = 'saved';
        session.modified = Date.now();
        storage.currentSessionId = null;
        this.currentSessionId = null;
        await this.saveStorage(storage);
      }
    }
  }

  /**
   * Get session data for preservation
   * Property 18: Session data preservation
   */
  async getSessionDataForPreservation(sessionId) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === sessionId);

    if (session) {
      return {
        id: session.id,
        name: session.name,
        created: session.created,
        modified: session.modified,
        tabs: session.tabs,
        closedTabs: session.closedTabs,
        status: session.status
      };
    }
    return null;
  }

  /**
   * Create new session after complete closure
   * Property 19: New session after complete closure
   */
  async createNewSessionAfterClosure() {
    const allTabs = await chrome.tabs.query({});
    const incognitoTabs = allTabs.filter(tab => tab.incognito);
    const validIncognitoTabs = incognitoTabs.filter(tab => !this.isSystemUrl(tab.url));

    if (validIncognitoTabs.length > 0) {
      return await this.createNewSession();
    }
    return null;
  }

  /**
   * Update session metadata on closure
   * Property 20: Closure metadata updates
   */
  async updateSessionMetadataOnClosure(sessionId) {
    const storage = await this.getStorage();
    const session = storage.sessions.find(s => s.id === sessionId);

    if (session) {
      session.status = 'closed';
      session.modified = Date.now();
      session.closedAt = Date.now();
      await this.saveStorage(storage);
    }
  }

  /**
   * Switch to a different session without losing current session state
   * Validates that the session exists and is not already active
   * Requirements: 1.2, 2.5, 4.2
   */
  async switchToSession(sessionId) {
    const storage = await this.getStorage();

    // Validate: Session exists
    const targetSession = storage.sessions.find(s => s.id === sessionId);
    if (!targetSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Validate: Session is not already active
    if (this.currentSessionId === sessionId) {
      throw new Error(`Session is already active: ${sessionId}`);
    }

    // Switch to the new session
    this.currentSessionId = sessionId;
    storage.currentSessionId = sessionId;
    targetSession.modified = Date.now();

    await this.saveStorage(storage);
    return sessionId;
  }

  /**
   * Restore a session by switching to it without clearing its tabs
   * Maintains session continuity and preserves all session data
   * Requirements: 1.2, 2.5, 4.2
   */
  async restoreSession(sessionId) {
    const storage = await this.getStorage();

    // Validate: Session exists
    const session = storage.sessions.find(s => s.id === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Validate: Session is not already active
    if (this.currentSessionId === sessionId) {
      throw new Error(`Session is already active: ${sessionId}`);
    }

    // Validate: Session has tabs to restore
    if (!session.tabs || session.tabs.length === 0) {
      throw new Error(`Session has no tabs to restore: ${sessionId}`);
    }

    // Switch to the session without clearing its tabs
    this.currentSessionId = sessionId;
    storage.currentSessionId = sessionId;

    // Update session metadata to reflect restoration
    session.modified = Date.now();
    if (session.name && session.name.endsWith(' (Closed)')) {
      session.name = session.name.replace(' (Closed)', '');
    }

    await this.saveStorage(storage);

    // Return the session data for the caller to use
    return {
      sessionId: session.id,
      tabs: session.tabs,
      name: session.name,
      created: session.created,
      modified: session.modified
    };
  }

  /**
   * Get session data for restoration without switching
   * Allows validation before actual restoration
   * Requirements: 1.2, 2.5, 4.2
   */
  async getSessionForRestoration(sessionId) {
    const storage = await this.getStorage();

    // Validate: Session exists
    const session = storage.sessions.find(s => s.id === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Validate: Session is not already active
    if (this.currentSessionId === sessionId) {
      throw new Error(`Session is already active: ${sessionId}`);
    }

    // Validate: Session has tabs to restore
    if (!session.tabs || session.tabs.length === 0) {
      throw new Error(`Session has no tabs to restore: ${sessionId}`);
    }

    // Return session data without modifying storage
    return {
      sessionId: session.id,
      tabs: session.tabs,
      name: session.name,
      created: session.created,
      modified: session.modified,
      closedTabs: session.closedTabs
    };
  }
}

// Export for use in tests and other modules
export default SessionManager;
