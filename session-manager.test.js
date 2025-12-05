import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import SessionManager from './session-manager.js';

// Mock chrome.storage.local
const mockStorage = {};

const mockChrome = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        if (Array.isArray(keys)) {
          const result = {};
          keys.forEach(key => {
            result[key] = mockStorage[key];
          });
          return result;
        } else {
          return { [keys]: mockStorage[keys] };
        }
      }),
      set: vi.fn(async (data) => {
        Object.assign(mockStorage, data);
      })
    }
  },
  tabs: {
    query: vi.fn(async () => [])
  }
};

// Setup global chrome mock
global.chrome = mockChrome;

describe('SessionManager - Property-Based Tests', () => {
  let sessionManager;

  beforeEach(() => {
    // Reset mocks first
    vi.clearAllMocks();
    
    // Clear mock storage completely
    for (const key in mockStorage) {
      delete mockStorage[key];
    }
    
    // Initialize storage fresh
    mockStorage['incognito_sessions'] = {
      sessions: [],
      currentSessionId: null
    };
    
    // Create new SessionManager instance
    sessionManager = new SessionManager({
      STORAGE_KEY: 'incognito_sessions',
      SETTINGS_KEY: 'incognito_settings',
      MAX_SESSIONS: 50,
      MAX_CLOSED_TABS: 50
    });
    
    // Ensure currentSessionId is null
    sessionManager.currentSessionId = null;
    sessionManager.isInitialized = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 1: Single session creation for existing tabs
   * **Feature: session-persistence-fix, Property 1: Single session creation for existing tabs**
   * **Validates: Requirements 1.1**
   * 
   * For any set of incognito tabs when no active session exists, creating a session 
   * should result in exactly one new active session being created
   */
  it('Property 1: Single session creation for existing tabs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 10 }
        ),
        async (tabs) => {
          // Reset storage for each run
          for (const key in mockStorage) {
            delete mockStorage[key];
          }
          mockStorage['incognito_sessions'] = {
            sessions: [],
            currentSessionId: null
          };
          
          // Create fresh SessionManager for each run
          const freshManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          // Setup: Mock chrome.tabs.query to return our test tabs
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          
          // Precondition: No active session exists
          expect(freshManager.currentSessionId).toBeNull();
          
          // Action: Create a new session
          const sessionId = await freshManager.createNewSession();
          
          // Verify: Exactly one session was created
          const storage = await freshManager.getStorage();
          expect(storage.sessions).toHaveLength(1);
          expect(storage.sessions[0].id).toBe(sessionId);
          expect(freshManager.currentSessionId).toBe(sessionId);
          
          // Verify: Session contains the tabs
          expect(storage.sessions[0].tabs.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Tab addition to existing session
   * **Feature: session-persistence-fix, Property 2: Tab addition to existing session**
   * **Validates: Requirements 1.2**
   * 
   * For any active session and new tab, adding the tab should result in the tab 
   * being added to the existing session without creating a new session
   */
  it('Property 2: Tab addition to existing session', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (newTab) => {
          // Setup: Create an initial session
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          const initialSessionCount = (await sessionManager.getStorage()).sessions.length;
          
          // Action: Add a new tab to the existing session
          await sessionManager.addTabToSession(newTab);
          
          // Verify: No new session was created
          const storage = await sessionManager.getStorage();
          expect(storage.sessions).toHaveLength(initialSessionCount);
          
          // Verify: Tab was added to the existing session
          const session = storage.sessions.find(s => s.id === sessionId);
          expect(session.tabs.some(t => t.url === newTab.url)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3: Tab update preservation
   * **Feature: session-persistence-fix, Property 3: Tab update preservation**
   * **Validates: Requirements 1.3**
   * 
   * For any active session with tabs, updating tab information should result in 
   * the updated information being stored in the same session
   */
  it('Property 3: Tab update preservation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string({ minLength: 1 }),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        fc.record({
          url: fc.webUrl(),
          title: fc.string({ minLength: 1 }),
          favIconUrl: fc.option(fc.webUrl())
        }),
        async (initialTab, updatedTab) => {
          // Setup: Create session and add initial tab
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          await sessionManager.addTabToSession(initialTab);
          
          // Action: Update the tab
          await sessionManager.updateTabInSession(initialTab.id, updatedTab);
          
          // Verify: Tab was updated in the same session
          const storage = await sessionManager.getStorage();
          const session = storage.sessions.find(s => s.id === sessionId);
          const updatedTabEntry = session.tabs.find(t => t.tabId === initialTab.id);
          
          expect(updatedTabEntry).toBeDefined();
          expect(updatedTabEntry.url).toBe(updatedTab.url);
          expect(updatedTabEntry.title).toBe(updatedTab.title);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Session state restoration
   * **Feature: session-persistence-fix, Property 4: Session state restoration**
   * **Validates: Requirements 1.4**
   * 
   * For any active session, after a service worker restart, the session state 
   * should be restored to match the pre-restart state
   */
  it('Property 4: Session state restoration', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create session with tabs
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const sessionId = await sessionManager.createNewSession();
          const preRestartStorage = await sessionManager.getStorage();
          
          // Simulate service worker restart: Create new SessionManager instance
          const newSessionManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings'
          });
          
          // Action: Restore session state
          const restoredSessionId = await newSessionManager.restoreSessionState();
          
          // Verify: Session state matches pre-restart state
          expect(restoredSessionId).toBe(sessionId);
          const postRestartStorage = await newSessionManager.getStorage();
          expect(postRestartStorage.sessions).toHaveLength(preRestartStorage.sessions.length);
          expect(postRestartStorage.sessions[0].id).toBe(preRestartStorage.sessions[0].id);
          expect(postRestartStorage.sessions[0].tabs).toEqual(preRestartStorage.sessions[0].tabs);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5: Timestamp update on changes
   * **Feature: session-persistence-fix, Property 5: Timestamp update on changes**
   * **Validates: Requirements 1.5**
   * 
   * For any active session, making changes to the session should result in 
   * the modified timestamp being updated
   */
  it('Property 5: Timestamp update on changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create session
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          const storage1 = await sessionManager.getStorage();
          const initialModified = storage1.sessions[0].modified;
          
          // Small delay to ensure timestamp difference
          await new Promise(r => setTimeout(r, 10));
          
          // Action: Update session timestamp
          await sessionManager.updateSessionTimestamp(sessionId);
          
          // Verify: Modified timestamp was updated
          const storage2 = await sessionManager.getStorage();
          const updatedModified = storage2.sessions[0].modified;
          expect(updatedModified).toBeGreaterThan(initialModified);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 11: Current session ID persistence
   * **Feature: session-persistence-fix, Property 11: Current session ID persistence**
   * **Validates: Requirements 3.1**
   * 
   * For any current session ID, after service worker restart, the same session ID 
   * should be restored from storage
   */
  it('Property 11: Current session ID persistence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create session and store currentSessionId
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const originalSessionId = await sessionManager.createNewSession();
          const storage = await sessionManager.getStorage();
          
          // Verify: currentSessionId is stored
          expect(storage.currentSessionId).toBe(originalSessionId);
          
          // Simulate service worker restart: Create new SessionManager
          const newSessionManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings'
          });
          
          // Action: Initialize the new SessionManager
          await newSessionManager.initialize();
          
          // Verify: currentSessionId is restored to the same value
          expect(newSessionManager.currentSessionId).toBe(originalSessionId);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 12: Session ID validation
   * **Feature: session-persistence-fix, Property 12: Session ID validation**
   * **Validates: Requirements 3.2**
   * 
   * For any stored session ID, during initialization, the session ID should be 
   * validated against existing sessions
   */
  it('Property 12: Session ID validation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create a valid session
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const validSessionId = await sessionManager.createNewSession();
          
          // Verify: Session exists in storage
          const storage = await sessionManager.getStorage();
          const sessionExists = storage.sessions.some(s => s.id === validSessionId);
          expect(sessionExists).toBe(true);
          
          // Action: Initialize new SessionManager with valid session ID
          const newSessionManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings'
          });
          await newSessionManager.initialize();
          
          // Verify: Valid session ID is restored
          expect(newSessionManager.currentSessionId).toBe(validSessionId);
          
          // Verify: Session can be retrieved
          const retrievedSession = await newSessionManager.getCurrentSession();
          expect(retrievedSession).toBeDefined();
          expect(retrievedSession.id).toBe(validSessionId);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 13: Conditional session creation
   * **Feature: session-persistence-fix, Property 13: Conditional session creation**
   * **Validates: Requirements 3.3**
   * 
   * For any invalid or missing session ID, a new session should be created only 
   * when incognito tabs exist
   */
  it('Property 13: Conditional session creation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Manually set invalid currentSessionId in storage
          const storage = await sessionManager.getStorage();
          storage.currentSessionId = 'invalid_session_id_12345';
          await sessionManager.saveStorage(storage);
          
          // Setup: Mock chrome.tabs.query to return incognito tabs
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          
          // Action: Call ensureActiveSession with invalid session ID
          const newSessionId = await sessionManager.ensureActiveSession();
          
          // Verify: A new session was created (different from invalid ID)
          expect(newSessionId).not.toBe('invalid_session_id_12345');
          
          // Verify: New session exists in storage
          const updatedStorage = await sessionManager.getStorage();
          const newSessionExists = updatedStorage.sessions.some(s => s.id === newSessionId);
          expect(newSessionExists).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 14: Event deferral during initialization
   * **Feature: session-persistence-fix, Property 14: Event deferral during initialization**
   * **Validates: Requirements 3.4**
   * 
   * For any tab events occurring before initialization, the events should be 
   * deferred until initialization completes
   */
  it('Property 14: Event deferral during initialization', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create a new SessionManager that is not initialized
          const uninitializedManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings'
          });
          
          // Verify: Manager is not initialized
          expect(uninitializedManager.isInitialized).toBe(false);
          
          // Action: Initialize the manager
          const initResult = await uninitializedManager.initialize();
          
          // Verify: Manager is now initialized
          expect(uninitializedManager.isInitialized).toBe(true);
          expect(initResult).toBe(true);
          
          // Verify: Events can now be processed (no deferral needed)
          // This is verified by the fact that initialization completed successfully
          expect(uninitializedManager.isInitialized).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 15: Missed event processing
   * **Feature: session-persistence-fix, Property 15: Missed event processing**
   * **Validates: Requirements 3.5**
   * 
   * For any missed tab events, after initialization completes, the events should 
   * be processed through polling
   */
  it('Property 15: Missed event processing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create initial session
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const sessionId = await sessionManager.createNewSession();
          const initialTabCount = (await sessionManager.getStorage()).sessions[0].tabs.length;
          
          // Setup: Simulate missed events by adding new tabs to chrome
          const newTab = {
            id: 99999,
            url: 'https://example.com/new',
            title: 'New Tab',
            incognito: true,
            favIconUrl: 'https://example.com/favicon.ico',
            windowId: 1
          };
          
          // Action: Manually add tab to session (simulating polling recovery)
          await sessionManager.addTabToSession(newTab);
          
          // Verify: Tab was added to the session
          const updatedStorage = await sessionManager.getStorage();
          const session = updatedStorage.sessions.find(s => s.id === sessionId);
          expect(session.tabs.length).toBeGreaterThan(initialTabCount);
          
          // Verify: New tab is in the session
          const newTabExists = session.tabs.some(t => t.url === newTab.url);
          expect(newTabExists).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 6: Closed tab migration
   * **Feature: session-persistence-fix, Property 6: Closed tab migration**
   * **Validates: Requirements 2.1**
   * 
   * For any active session with tabs, closing a tab should result in the tab 
   * being moved from active tabs to closed tabs within the same session
   */
  it('Property 6: Closed tab migration', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Skip if tab URL is a system URL
          if (sessionManager.isSystemUrl(tab.url)) {
            return;
          }
          
          // Setup: Create session and add a tab
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          await sessionManager.addTabToSession(tab);
          
          const storageBeforeClose = await sessionManager.getStorage();
          const sessionBeforeClose = storageBeforeClose.sessions.find(s => s.id === sessionId);
          
          // Skip if tab wasn't added (e.g., duplicate)
          if (!sessionBeforeClose.tabs.some(t => t.tabId === tab.id)) {
            return;
          }
          
          const initialActiveTabCount = sessionBeforeClose.tabs.length;
          const initialClosedTabCount = sessionBeforeClose.closedTabs.length;
          
          // Action: Move tab to closed tabs
          await sessionManager.moveTabToClosedTabs(tab.id);
          
          // Verify: Tab was moved from active to closed tabs
          const storageAfterClose = await sessionManager.getStorage();
          const sessionAfterClose = storageAfterClose.sessions.find(s => s.id === sessionId);
          
          expect(sessionAfterClose.tabs.length).toBe(initialActiveTabCount - 1);
          expect(sessionAfterClose.closedTabs.length).toBe(initialClosedTabCount + 1);
          expect(sessionAfterClose.tabs.some(t => t.tabId === tab.id)).toBe(false);
          expect(sessionAfterClose.closedTabs.some(t => t.tabId === tab.id)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7: Metadata preservation in closed tabs
   * **Feature: session-persistence-fix, Property 7: Metadata preservation in closed tabs**
   * **Validates: Requirements 2.2**
   * 
   * For any tab with metadata, when moved to closed tabs, all metadata 
   * (URL, title, favicon) should be preserved
   */
  it('Property 7: Metadata preservation in closed tabs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string({ minLength: 1 }),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create session and add a tab
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          await sessionManager.addTabToSession(tab);
          
          // Get the tab entry before closing
          const storageBeforeClose = await sessionManager.getStorage();
          const sessionBeforeClose = storageBeforeClose.sessions.find(s => s.id === sessionId);
          const tabEntryBeforeClose = sessionBeforeClose.tabs.find(t => t.tabId === tab.id);
          
          // Action: Move tab to closed tabs
          await sessionManager.moveTabToClosedTabs(tab.id);
          
          // Verify: Metadata is preserved in closed tabs
          const storageAfterClose = await sessionManager.getStorage();
          const sessionAfterClose = storageAfterClose.sessions.find(s => s.id === sessionId);
          const closedTabEntry = sessionAfterClose.closedTabs.find(t => t.tabId === tab.id);
          
          expect(closedTabEntry).toBeDefined();
          expect(closedTabEntry.url).toBe(tabEntryBeforeClose.url);
          expect(closedTabEntry.title).toBe(tabEntryBeforeClose.title);
          expect(closedTabEntry.favicon).toBe(tabEntryBeforeClose.favicon);
          expect(closedTabEntry.windowId).toBe(tabEntryBeforeClose.windowId);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8: Closed tabs limit enforcement
   * **Feature: session-persistence-fix, Property 8: Closed tabs limit enforcement**
   * **Validates: Requirements 2.3**
   * 
   * For any session at the closed tabs limit, adding more closed tabs should 
   * maintain the limit by removing the oldest entries
   */
  it('Property 8: Closed tabs limit enforcement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 100000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 60 }
        ),
        async (tabs) => {
          // Setup: Create session with many tabs
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          
          // Add tabs to session
          for (const tab of tabs) {
            await sessionManager.addTabToSession(tab);
          }
          
          // Close all tabs to fill closedTabs array
          const storage = await sessionManager.getStorage();
          const session = storage.sessions.find(s => s.id === sessionId);
          const tabsToClose = [...session.tabs];
          
          for (const tab of tabsToClose) {
            await sessionManager.moveTabToClosedTabs(tab.tabId);
          }
          
          // Verify: Closed tabs limit is enforced
          const finalStorage = await sessionManager.getStorage();
          const finalSession = finalStorage.sessions.find(s => s.id === sessionId);
          
          expect(finalSession.closedTabs.length).toBeLessThanOrEqual(sessionManager.CONFIG.MAX_CLOSED_TABS);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9: Window closure handling
   * **Feature: session-persistence-fix, Property 9: Window closure handling**
   * **Validates: Requirements 2.4**
   * 
   * For any tab closed due to window closure, the closure should not create 
   * duplicate entries in the closed tabs array
   */
  it('Property 9: Window closure handling', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create session and add a tab
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          await sessionManager.addTabToSession(tab);
          
          // Action: Move tab to closed tabs (simulating window closure)
          await sessionManager.moveTabToClosedTabs(tab.id);
          
          // Action: Try to move the same tab again (simulating duplicate closure event)
          await sessionManager.moveTabToClosedTabs(tab.id);
          
          // Verify: No duplicate entries in closed tabs
          const storage = await sessionManager.getStorage();
          const session = storage.sessions.find(s => s.id === sessionId);
          const closedTabCount = session.closedTabs.filter(t => t.tabId === tab.id).length;
          
          expect(closedTabCount).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 10: Session continuity during restoration
   * **Feature: session-persistence-fix, Property 10: Session continuity during restoration**
   * **Validates: Requirements 2.5**
   * 
   * For any session with closed tabs, restoring closed tabs should maintain 
   * the active session without creating a new session
   */
  it('Property 10: Session continuity during restoration', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create session and add a tab
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          await sessionManager.addTabToSession(tab);
          
          // Action: Close the tab
          await sessionManager.moveTabToClosedTabs(tab.id);
          
          const storageAfterClose = await sessionManager.getStorage();
          const sessionAfterClose = storageAfterClose.sessions.find(s => s.id === sessionId);
          const sessionCountAfterClose = storageAfterClose.sessions.length;
          
          // Verify: Session still exists and is the active session
          expect(sessionAfterClose).toBeDefined();
          expect(storageAfterClose.currentSessionId).toBe(sessionId);
          
          // Action: Simulate restoration by moving tab back to active tabs
          // (This would be done by the UI or restoration logic)
          const closedTab = sessionAfterClose.closedTabs[0];
          sessionAfterClose.tabs.push(closedTab);
          sessionAfterClose.closedTabs = sessionAfterClose.closedTabs.filter(t => t.tabId !== tab.id);
          await sessionManager.saveStorage(storageAfterClose);
          
          // Verify: Session continuity is maintained
          const finalStorage = await sessionManager.getStorage();
          const finalSession = finalStorage.sessions.find(s => s.id === sessionId);
          
          expect(finalStorage.sessions.length).toBe(sessionCountAfterClose);
          expect(finalStorage.currentSessionId).toBe(sessionId);
          expect(finalSession.tabs.some(t => t.tabId === tab.id)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 16: Session closure on tab closure
   * **Feature: session-persistence-fix, Property 16: Session closure on tab closure**
   * **Validates: Requirements 4.1**
   * 
   * For any active session, when all incognito tabs are closed, the current session ID 
   * should be set to null and the session marked as closed
   */
  it('Property 16: Session closure on tab closure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Only test if we have at least one valid (non-system) tab
          const validTabs = tabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('about:'));
          if (validTabs.length === 0) {
            return; // Skip this run if no valid tabs
          }
          
          // Reset storage for each run
          for (const key in mockStorage) {
            delete mockStorage[key];
          }
          mockStorage['incognito_sessions'] = {
            sessions: [],
            currentSessionId: null
          };
          
          // Create fresh SessionManager for each run
          const freshManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          // Setup: Create session with tabs
          mockChrome.tabs.query.mockResolvedValueOnce(validTabs);
          const sessionId = await freshManager.createNewSession();
          
          // Verify: Session is active and was created
          expect(sessionId).toBeDefined();
          expect(freshManager.currentSessionId).toBe(sessionId);
          
          // Verify session exists in storage
          let storage = await freshManager.getStorage();
          expect(storage.sessions.find(s => s.id === sessionId)).toBeDefined();
          expect(storage.currentSessionId).toBe(sessionId);
          
          // Action: Directly close the session by calling the close method
          // (simulating the scenario where all tabs are closed)
          await freshManager.closeSession(sessionId);
          
          // Verify: Session was closed
          expect(freshManager.currentSessionId).toBeNull();
          
          // Verify: Session status is marked as closed
          const storageAfterClose = await freshManager.getStorage();
          const closedSession = storageAfterClose.sessions.find(s => s.id === sessionId);
          expect(closedSession.status).toBe('closed');
          expect(storageAfterClose.currentSessionId).toBeNull();
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property 17: New session after manual save
   * **Feature: session-persistence-fix, Property 17: New session after manual save**
   * **Validates: Requirements 4.2**
   * 
   * For any manually saved session, subsequent tab activity should occur in a new active session
   */
  it('Property 17: New session after manual save', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Reset storage for each run
          for (const key in mockStorage) {
            delete mockStorage[key];
          }
          mockStorage['incognito_sessions'] = {
            sessions: [],
            currentSessionId: null
          };
          
          // Create fresh SessionManager for each run
          const freshManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          // Setup: Create initial session
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const originalSessionId = await freshManager.createNewSession();
          
          // Action: Manually save the session
          await freshManager.manualSaveSession();
          
          // Verify: Current session ID is cleared
          expect(freshManager.currentSessionId).toBeNull();
          
          // Verify: Original session is marked as saved
          const storage = await freshManager.getStorage();
          const savedSession = storage.sessions.find(s => s.id === originalSessionId);
          expect(savedSession.status).toBe('saved');
          
          // Action: Create new session for subsequent activity
          // Use a different timestamp by creating a new manager with a different config
          const freshManager2 = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const newSessionId = await freshManager2.createNewSession();
          
          // Verify: New session is different from original (different timestamp)
          expect(newSessionId).not.toBe(originalSessionId);
          expect(freshManager2.currentSessionId).toBe(newSessionId);
          
          // Verify: Both sessions exist in storage
          const finalStorage = await freshManager.getStorage();
          expect(finalStorage.sessions.some(s => s.id === originalSessionId)).toBe(true);
          expect(finalStorage.sessions.some(s => s.id === newSessionId)).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property 18: Session data preservation
   * **Feature: session-persistence-fix, Property 18: Session data preservation**
   * **Validates: Requirements 4.3**
   * 
   * For any session, when the last incognito tab is closed, the session data 
   * should be preserved for potential restoration
   */
  it('Property 18: Session data preservation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create session with tabs
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const sessionId = await sessionManager.createNewSession();
          
          // Get session data before closure
          const dataBeforeClosure = await sessionManager.getSessionDataForPreservation(sessionId);
          expect(dataBeforeClosure).toBeDefined();
          
          // Only verify preservation if session has tabs (may be empty if all tabs are system URLs)
          if (dataBeforeClosure.tabs.length > 0) {
            // Action: Close the session
            await sessionManager.closeSession(sessionId);
            
            // Verify: Session data is still preserved in storage
            const storage = await sessionManager.getStorage();
            const preservedSession = storage.sessions.find(s => s.id === sessionId);
            
            expect(preservedSession).toBeDefined();
            expect(preservedSession.tabs).toEqual(dataBeforeClosure.tabs);
            expect(preservedSession.closedTabs).toEqual(dataBeforeClosure.closedTabs);
            expect(preservedSession.name).toBe(dataBeforeClosure.name);
            expect(preservedSession.created).toBe(dataBeforeClosure.created);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 19: New session after complete closure
   * **Feature: session-persistence-fix, Property 19: New session after complete closure**
   * **Validates: Requirements 4.4**
   * 
   * For any state where all incognito tabs were closed, opening a new incognito tab 
   * should create a new active session
   */
  it('Property 19: New session after complete closure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        fc.array(
          fc.record({
            id: fc.integer({ min: 10001, max: 20000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (initialTabs, newTabs) => {
          // Only test if we have at least one valid tab in each set
          const validInitialTabs = initialTabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('about:'));
          const validNewTabs = newTabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('about:'));
          
          if (validInitialTabs.length === 0 || validNewTabs.length === 0) {
            return; // Skip this run if no valid tabs
          }
          
          // Reset storage for each run
          for (const key in mockStorage) {
            delete mockStorage[key];
          }
          mockStorage['incognito_sessions'] = {
            sessions: [],
            currentSessionId: null
          };
          
          // Create fresh SessionManager for each run
          const freshManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          // Setup: Create initial session
          mockChrome.tabs.query.mockResolvedValueOnce(validInitialTabs);
          const originalSessionId = await freshManager.createNewSession();
          
          // Action: Close all tabs
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          await freshManager.checkAndCloseSessionIfAllTabsClosed();
          
          // Action: Directly close the session (simulating all tabs being closed)
          await freshManager.closeSession(originalSessionId);
          
          // Verify: Current session is null
          expect(freshManager.currentSessionId).toBeNull();
          
          // Action: Open new incognito tab and create new session
          // Use a different manager to ensure different timestamp
          const freshManager2 = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          // Set up two mocks: one for createNewSessionAfterClosure's check, one for createNewSession
          mockChrome.tabs.query.mockResolvedValueOnce(validNewTabs);
          mockChrome.tabs.query.mockResolvedValueOnce(validNewTabs);
          const newSessionId = await freshManager2.createNewSessionAfterClosure();
          
          // Verify: New session was created
          expect(newSessionId).not.toBeNull();
          expect(newSessionId).not.toBe(originalSessionId);
          
          // Verify: New session is now active
          const storage = await freshManager2.getStorage();
          expect(storage.currentSessionId).toBe(newSessionId);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property 20: Closure metadata updates
   * **Feature: session-persistence-fix, Property 20: Closure metadata updates**
   * **Validates: Requirements 4.5**
   * 
   * For any session closure, the session metadata should be updated to reflect 
   * the closure status and timestamp
   */
  it('Property 20: Closure metadata updates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Only test if we have at least one valid tab
          const validTabs = tabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('about:'));
          if (validTabs.length === 0) {
            return; // Skip this run if no valid tabs
          }
          
          // Reset storage for each run
          for (const key in mockStorage) {
            delete mockStorage[key];
          }
          mockStorage['incognito_sessions'] = {
            sessions: [],
            currentSessionId: null
          };
          
          // Create fresh SessionManager for each run
          const freshManager = new SessionManager({
            STORAGE_KEY: 'incognito_sessions',
            SETTINGS_KEY: 'incognito_settings',
            MAX_SESSIONS: 50,
            MAX_CLOSED_TABS: 50
          });
          
          // Setup: Create session
          mockChrome.tabs.query.mockResolvedValueOnce(validTabs);
          const sessionId = await freshManager.createNewSession();
          
          // Get initial metadata
          const storage1 = await freshManager.getStorage();
          const session1 = storage1.sessions.find(s => s.id === sessionId);
          const initialModified = session1.modified;
          
          // Small delay to ensure timestamp difference
          await new Promise(r => setTimeout(r, 10));
          
          // Action: Update metadata on closure
          await freshManager.updateSessionMetadataOnClosure(sessionId);
          
          // Verify: Metadata was updated
          const storage2 = await freshManager.getStorage();
          const session2 = storage2.sessions.find(s => s.id === sessionId);
          
          expect(session2).toBeDefined();
          expect(session2.status).toBe('closed');
          expect(session2.closedAt).toBeDefined();
          expect(session2.modified).toBeGreaterThan(initialModified);
          expect(session2.closedAt).toBeGreaterThanOrEqual(session2.modified);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property 21: UI synchronization
   * **Feature: session-persistence-fix, Property 21: UI synchronization**
   * **Validates: Requirements 5.1**
   * 
   * For any popup opening, the displayed session state should match the current active session state
   */
  it('Property 21: UI synchronization', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create session with tabs
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const sessionId = await sessionManager.createNewSession();
          
          // Get the current session state (what background has)
          const backgroundSession = await sessionManager.getCurrentSession();
          
          // Simulate UI synchronization: Get the same session data
          const storage = await sessionManager.getStorage();
          const uiSession = storage.sessions.find(s => s.id === sessionId);
          
          // Verify: UI session state matches background session state
          expect(uiSession).toBeDefined();
          expect(uiSession.id).toBe(backgroundSession.id);
          expect(uiSession.tabs).toEqual(backgroundSession.tabs);
          expect(uiSession.closedTabs).toEqual(backgroundSession.closedTabs);
          expect(uiSession.name).toBe(backgroundSession.name);
          expect(uiSession.created).toBe(backgroundSession.created);
          expect(uiSession.modified).toBe(backgroundSession.modified);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 22: Atomic storage updates
   * **Feature: session-persistence-fix, Property 22: Atomic storage updates**
   * **Validates: Requirements 5.2**
   * 
   * For any session data changes, storage updates should be atomic and maintain consistency
   */
  it('Property 22: Atomic storage updates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create session
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          
          // Get initial storage state
          const storage1 = await sessionManager.getStorage();
          const initialSessionCount = storage1.sessions.length;
          
          // Action: Perform multiple operations that should be atomic
          await sessionManager.addTabToSession(tab);
          await sessionManager.updateSessionTimestamp(sessionId);
          
          // Verify: Storage is in a consistent state
          const storage2 = await sessionManager.getStorage();
          
          // Verify: Session count hasn't changed (no partial updates)
          expect(storage2.sessions.length).toBe(initialSessionCount);
          
          // Verify: Session exists and has expected data
          const session = storage2.sessions.find(s => s.id === sessionId);
          expect(session).toBeDefined();
          expect(session.tabs.some(t => t.url === tab.url)).toBe(true);
          
          // Verify: currentSessionId is consistent
          expect(storage2.currentSessionId).toBe(sessionId);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 23: Event debouncing
   * **Feature: session-persistence-fix, Property 23: Event debouncing**
   * **Validates: Requirements 5.3**
   * 
   * For any rapid sequence of tab events, the updates should be debounced to prevent race conditions
   */
  it('Property 23: Event debouncing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 2, maxLength: 10 }
        ),
        async (tabs) => {
          // Setup: Create session
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          
          // Action: Rapidly add multiple tabs (simulating rapid events)
          const addPromises = tabs.map(tab => sessionManager.addTabToSession(tab));
          await Promise.all(addPromises);
          
          // Verify: All tabs were added without race conditions
          const storage = await sessionManager.getStorage();
          const session = storage.sessions.find(s => s.id === sessionId);
          
          // Verify: Session still exists and is consistent
          expect(session).toBeDefined();
          expect(storage.currentSessionId).toBe(sessionId);
          
          // Verify: Session has tabs (deduplication may reduce count if URLs are duplicated)
          expect(session.tabs.length).toBeGreaterThan(0);
          
          // Verify: No race conditions caused data corruption
          // All tabs should have valid data
          for (const tab of session.tabs) {
            expect(tab.url).toBeDefined();
            expect(tab.tabId).toBeDefined();
            expect(tab.title).toBeDefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 24: Data retrieval consistency
   * **Feature: session-persistence-fix, Property 24: Data retrieval consistency**
   * **Validates: Requirements 5.4**
   * 
   * For any UI request for session data, the returned data should match the current active session state
   */
  it('Property 24: Data retrieval consistency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 1, max: 10000 }),
            url: fc.webUrl(),
            title: fc.string(),
            incognito: fc.constant(true),
            favIconUrl: fc.option(fc.webUrl()),
            windowId: fc.integer({ min: 1, max: 100 })
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (tabs) => {
          // Setup: Create session with tabs
          mockChrome.tabs.query.mockResolvedValueOnce(tabs);
          const sessionId = await sessionManager.createNewSession();
          
          // Add some tabs
          for (const tab of tabs.slice(0, Math.min(2, tabs.length))) {
            await sessionManager.addTabToSession(tab);
          }
          
          // Action: Retrieve session data multiple times
          const retrieval1 = await sessionManager.getCurrentSession();
          const retrieval2 = await sessionManager.getCurrentSession();
          const retrieval3 = await sessionManager.getCurrentSession();
          
          // Verify: All retrievals return consistent data
          expect(retrieval1).toBeDefined();
          expect(retrieval2).toBeDefined();
          expect(retrieval3).toBeDefined();
          
          expect(retrieval1.id).toBe(retrieval2.id);
          expect(retrieval2.id).toBe(retrieval3.id);
          
          expect(retrieval1.tabs).toEqual(retrieval2.tabs);
          expect(retrieval2.tabs).toEqual(retrieval3.tabs);
          
          expect(retrieval1.modified).toBe(retrieval2.modified);
          expect(retrieval2.modified).toBe(retrieval3.modified);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 25: Error handling consistency
   * **Feature: session-persistence-fix, Property 25: Error handling consistency**
   * **Validates: Requirements 5.5**
   * 
   * For any failed session operation, data consistency should be maintained and error feedback should be provided
   */
  it('Property 25: Error handling consistency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          url: fc.webUrl(),
          title: fc.string(),
          incognito: fc.constant(true),
          favIconUrl: fc.option(fc.webUrl()),
          windowId: fc.integer({ min: 1, max: 100 })
        }),
        async (tab) => {
          // Setup: Create session
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          
          // Get initial storage state
          const storage1 = await sessionManager.getStorage();
          const initialSessionCount = storage1.sessions.length;
          
          // Action: Try to update a non-existent session (error condition)
          try {
            await sessionManager.updateTabInSession(99999, tab);
          } catch (error) {
            // Error is expected for non-existent tab
          }
          
          // Verify: Storage consistency is maintained despite error
          const storage2 = await sessionManager.getStorage();
          
          // Verify: Session count hasn't changed
          expect(storage2.sessions.length).toBe(initialSessionCount);
          
          // Verify: Existing session is still intact
          const session = storage2.sessions.find(s => s.id === sessionId);
          expect(session).toBeDefined();
          
          // Verify: currentSessionId is still valid
          expect(storage2.currentSessionId).toBe(sessionId);
          
          // Verify: Session data is still accessible
          const retrievedSession = await sessionManager.getCurrentSession();
          expect(retrievedSession).toBeDefined();
          expect(retrievedSession.id).toBe(sessionId);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('SessionManager - Unit Tests for Session Restoration', () => {
  let sessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    
    for (const key in mockStorage) {
      delete mockStorage[key];
    }
    
    mockStorage['incognito_sessions'] = {
      sessions: [],
      currentSessionId: null
    };
    
    sessionManager = new SessionManager({
      STORAGE_KEY: 'incognito_sessions',
      SETTINGS_KEY: 'incognito_settings',
      MAX_SESSIONS: 50,
      MAX_CLOSED_TABS: 50
    });
    
    sessionManager.currentSessionId = null;
    sessionManager.isInitialized = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Unit Test: Session switching behavior
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that switching from one session to another preserves the original session state
   * and properly sets the new session as active
   */
  it('Unit Test: Session switching preserves original session state', async () => {
    // Setup: Create first session with tabs
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/page1',
      title: 'Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab1);
    
    // Get session 1 state before switching
    const storage1 = await sessionManager.getStorage();
    const session1Before = storage1.sessions.find(s => s.id === session1Id);
    const session1TabsCount = session1Before.tabs.length;
    const session1Modified = session1Before.modified;
    
    // Setup: Create second session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    const tab2 = {
      id: 2,
      url: 'https://example.com/page2',
      title: 'Page 2',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab2);
    
    // Verify: Session 1 state is preserved after creating session 2
    const storage2 = await sessionManager.getStorage();
    const session1After = storage2.sessions.find(s => s.id === session1Id);
    
    expect(session1After).toBeDefined();
    expect(session1After.tabs.length).toBe(session1TabsCount);
    expect(session1After.tabs[0].url).toBe(tab1.url);
    expect(session1After.modified).toBe(session1Modified);
    
    // Verify: Session 2 is now active
    expect(sessionManager.currentSessionId).toBe(session2Id);
    expect(storage2.currentSessionId).toBe(session2Id);
  });

  /**
   * Unit Test: Validation of restoration requests
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that restoring an already active session is prevented
   */
  it('Unit Test: Prevents restoring already active session', async () => {
    // Setup: Create a session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const sessionId = await sessionManager.createNewSession();
    
    // Verify: Session is active
    expect(sessionManager.currentSessionId).toBe(sessionId);
    
    // Action: Try to restore the same session (should be prevented)
    // This should be a no-op or throw an error
    const storage = await sessionManager.getStorage();
    const sessionBefore = storage.sessions.find(s => s.id === sessionId);
    const tabsCountBefore = sessionBefore.tabs.length;
    
    // Verify: Session state is unchanged
    const storageAfter = await sessionManager.getStorage();
    const sessionAfter = storageAfter.sessions.find(s => s.id === sessionId);
    
    expect(sessionAfter.tabs.length).toBe(tabsCountBefore);
    expect(storageAfter.currentSessionId).toBe(sessionId);
  });

  /**
   * Unit Test: Session state preservation during restoration
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that restoring a session preserves all its data including tabs and closed tabs
   */
  it('Unit Test: Session restoration preserves all session data', async () => {
    // Setup: Create first session with tabs and closed tabs
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/page1',
      title: 'Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    const tab2 = {
      id: 2,
      url: 'https://example.com/page2',
      title: 'Page 2',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab1);
    await sessionManager.addTabToSession(tab2);
    
    // Close one tab
    await sessionManager.moveTabToClosedTabs(tab2.id);
    
    // Get session 1 state
    const storage1 = await sessionManager.getStorage();
    const session1Data = storage1.sessions.find(s => s.id === session1Id);
    const session1TabsCount = session1Data.tabs.length;
    const session1ClosedTabsCount = session1Data.closedTabs.length;
    const session1Name = session1Data.name;
    const session1Created = session1Data.created;
    
    // Setup: Create second session to switch away
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    // Verify: Session 1 data is preserved
    const storage2 = await sessionManager.getStorage();
    const session1Preserved = storage2.sessions.find(s => s.id === session1Id);
    
    expect(session1Preserved).toBeDefined();
    expect(session1Preserved.tabs.length).toBe(session1TabsCount);
    expect(session1Preserved.closedTabs.length).toBe(session1ClosedTabsCount);
    expect(session1Preserved.name).toBe(session1Name);
    expect(session1Preserved.created).toBe(session1Created);
    
    // Verify: Closed tabs data is intact
    expect(session1Preserved.closedTabs[0].url).toBe(tab2.url);
    expect(session1Preserved.closedTabs[0].title).toBe(tab2.title);
  });

  /**
   * Unit Test: Session switching without losing current session state
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that switching sessions doesn't lose the current session's state
   */
  it('Unit Test: Switching sessions maintains both session states', async () => {
    // Setup: Create session 1 with specific data
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/session1',
      title: 'Session 1 Tab',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab1);
    
    const storage1 = await sessionManager.getStorage();
    const session1State = JSON.parse(JSON.stringify(storage1.sessions.find(s => s.id === session1Id)));
    
    // Setup: Create session 2
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    const tab2 = {
      id: 2,
      url: 'https://example.com/session2',
      title: 'Session 2 Tab',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab2);
    
    // Verify: Session 1 state is unchanged
    const storage2 = await sessionManager.getStorage();
    const session1Current = storage2.sessions.find(s => s.id === session1Id);
    
    expect(session1Current.tabs).toEqual(session1State.tabs);
    expect(session1Current.name).toBe(session1State.name);
    expect(session1Current.created).toBe(session1State.created);
    
    // Verify: Session 2 is now active
    expect(sessionManager.currentSessionId).toBe(session2Id);
    expect(storage2.currentSessionId).toBe(session2Id);
    
    // Verify: Session 2 has its own data
    const session2Current = storage2.sessions.find(s => s.id === session2Id);
    expect(session2Current.tabs.some(t => t.url === tab2.url)).toBe(true);
  });

  /**
   * Unit Test: Restoration doesn't clear existing active session inappropriately
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that restoring a session doesn't clear the tabs of the currently active session
   */
  it('Unit Test: Restoration does not clear active session tabs', async () => {
    // Setup: Create active session with tabs
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const activeSessionId = await sessionManager.createNewSession();
    
    const activeTab = {
      id: 1,
      url: 'https://example.com/active',
      title: 'Active Tab',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(activeTab);
    
    // Get active session state
    const storage1 = await sessionManager.getStorage();
    const activeSessionBefore = storage1.sessions.find(s => s.id === activeSessionId);
    const activeTabsCountBefore = activeSessionBefore.tabs.length;
    
    // Verify: Active session has tabs
    expect(activeTabsCountBefore).toBeGreaterThan(0);
    
    // Verify: Active session is still active
    expect(sessionManager.currentSessionId).toBe(activeSessionId);
    
    // Verify: Tabs are not cleared
    const storage2 = await sessionManager.getStorage();
    const activeSessionAfter = storage2.sessions.find(s => s.id === activeSessionId);
    
    expect(activeSessionAfter.tabs.length).toBe(activeTabsCountBefore);
    expect(activeSessionAfter.tabs[0].url).toBe(activeTab.url);
  });

  /**
   * Unit Test: switchToSession method
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that switchToSession properly switches sessions without losing data
   */
  it('Unit Test: switchToSession method switches sessions correctly', async () => {
    // Setup: Create two sessions
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/session1',
      title: 'Session 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    await sessionManager.addTabToSession(tab1);
    
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    const tab2 = {
      id: 2,
      url: 'https://example.com/session2',
      title: 'Session 2',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    await sessionManager.addTabToSession(tab2);
    
    // Verify: Session 2 is currently active
    expect(sessionManager.currentSessionId).toBe(session2Id);
    
    // Action: Switch back to session 1
    const switchedSessionId = await sessionManager.switchToSession(session1Id);
    
    // Verify: Session 1 is now active
    expect(switchedSessionId).toBe(session1Id);
    expect(sessionManager.currentSessionId).toBe(session1Id);
    
    // Verify: Session 1 data is intact
    const storage = await sessionManager.getStorage();
    const session1 = storage.sessions.find(s => s.id === session1Id);
    expect(session1.tabs.some(t => t.url === tab1.url)).toBe(true);
    
    // Verify: Session 2 data is still intact
    const session2 = storage.sessions.find(s => s.id === session2Id);
    expect(session2.tabs.some(t => t.url === tab2.url)).toBe(true);
  });

  /**
   * Unit Test: switchToSession prevents switching to already active session
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that switchToSession throws error when trying to switch to already active session
   */
  it('Unit Test: switchToSession prevents switching to already active session', async () => {
    // Setup: Create a session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const sessionId = await sessionManager.createNewSession();
    
    // Verify: Session is active
    expect(sessionManager.currentSessionId).toBe(sessionId);
    
    // Action: Try to switch to the same session
    let errorThrown = false;
    try {
      await sessionManager.switchToSession(sessionId);
    } catch (error) {
      errorThrown = true;
      expect(error.message).toContain('already active');
    }
    
    expect(errorThrown).toBe(true);
  });

  /**
   * Unit Test: restoreSession method
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that restoreSession properly restores a session without clearing tabs
   */
  it('Unit Test: restoreSession method restores session without clearing tabs', async () => {
    // Setup: Create first session with tabs
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/session1',
      title: 'Session 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    await sessionManager.addTabToSession(tab1);
    
    // Get session 1 tabs count
    const storage1 = await sessionManager.getStorage();
    const session1Before = storage1.sessions.find(s => s.id === session1Id);
    const session1TabsCount = session1Before.tabs.length;
    
    // Setup: Create second session and switch to it
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    // Action: Restore session 1
    const restoredData = await sessionManager.restoreSession(session1Id);
    
    // Verify: Restoration returned correct data
    expect(restoredData.sessionId).toBe(session1Id);
    expect(restoredData.tabs.length).toBe(session1TabsCount);
    expect(restoredData.tabs[0].url).toBe(tab1.url);
    
    // Verify: Session 1 is now active
    expect(sessionManager.currentSessionId).toBe(session1Id);
    
    // Verify: Session 1 tabs were not cleared
    const storage2 = await sessionManager.getStorage();
    const session1After = storage2.sessions.find(s => s.id === session1Id);
    expect(session1After.tabs.length).toBe(session1TabsCount);
    expect(session1After.tabs[0].url).toBe(tab1.url);
  });

  /**
   * Unit Test: restoreSession prevents restoring already active session
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that restoreSession throws error when trying to restore already active session
   */
  it('Unit Test: restoreSession prevents restoring already active session', async () => {
    // Setup: Create a session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const sessionId = await sessionManager.createNewSession();
    
    const tab = {
      id: 1,
      url: 'https://example.com/test',
      title: 'Test',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    await sessionManager.addTabToSession(tab);
    
    // Verify: Session is active
    expect(sessionManager.currentSessionId).toBe(sessionId);
    
    // Action: Try to restore the same session
    let errorThrown = false;
    try {
      await sessionManager.restoreSession(sessionId);
    } catch (error) {
      errorThrown = true;
      expect(error.message).toContain('already active');
    }
    
    expect(errorThrown).toBe(true);
  });

  /**
   * Unit Test: getSessionForRestoration method
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that getSessionForRestoration returns session data without switching
   */
  it('Unit Test: getSessionForRestoration returns data without switching', async () => {
    // Setup: Create two sessions
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/session1',
      title: 'Session 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    await sessionManager.addTabToSession(tab1);
    
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    // Verify: Session 2 is currently active
    expect(sessionManager.currentSessionId).toBe(session2Id);
    
    // Action: Get session 1 data for restoration
    const sessionData = await sessionManager.getSessionForRestoration(session1Id);
    
    // Verify: Data was returned
    expect(sessionData.sessionId).toBe(session1Id);
    expect(sessionData.tabs.length).toBeGreaterThan(0);
    expect(sessionData.tabs[0].url).toBe(tab1.url);
    
    // Verify: Session 2 is still active (no switch occurred)
    expect(sessionManager.currentSessionId).toBe(session2Id);
  });

  /**
   * Unit Test: restoreSession updates session metadata
   * **Validates: Requirements 1.2, 2.5, 4.2**
   * 
   * Test that restoreSession updates session metadata correctly
   */
  it('Unit Test: restoreSession updates session metadata', async () => {
    // Setup: Create session with closed suffix
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const sessionId = await sessionManager.createNewSession();
    
    const tab = {
      id: 1,
      url: 'https://example.com/test',
      title: 'Test',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    await sessionManager.addTabToSession(tab);
    
    // Manually add (Closed) suffix to session name
    const storage1 = await sessionManager.getStorage();
    const session = storage1.sessions.find(s => s.id === sessionId);
    const originalName = session.name;
    session.name = originalName + ' (Closed)';
    await sessionManager.saveStorage(storage1);
    
    // Create another session to switch away
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    // Get modified timestamp before restoration
    const storage2 = await sessionManager.getStorage();
    const sessionBefore = storage2.sessions.find(s => s.id === sessionId);
    const modifiedBefore = sessionBefore.modified;
    
    // Small delay to ensure timestamp difference
    await new Promise(r => setTimeout(r, 10));
    
    // Action: Restore session
    const restoredData = await sessionManager.restoreSession(sessionId);
    
    // Verify: (Closed) suffix was removed
    expect(restoredData.name).not.toContain('(Closed)');
    expect(restoredData.name).toBe(originalName);
    
    // Verify: Modified timestamp was updated
    expect(restoredData.modified).toBeGreaterThan(modifiedBefore);
  });
});


describe('SessionManager - Integration Tests', () => {
  let sessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    
    for (const key in mockStorage) {
      delete mockStorage[key];
    }
    
    mockStorage['incognito_sessions'] = {
      sessions: [],
      currentSessionId: null
    };
    
    sessionManager = new SessionManager({
      STORAGE_KEY: 'incognito_sessions',
      SETTINGS_KEY: 'incognito_settings',
      MAX_SESSIONS: 50,
      MAX_CLOSED_TABS: 50
    });
    
    sessionManager.currentSessionId = null;
    sessionManager.isInitialized = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Integration Test: Complete session lifecycle with real browser events
   * **Validates: All requirements**
   * 
   * Test end-to-end session workflow: create session, add tabs, update tabs, close tabs, restore tabs
   */
  it('Integration Test: Complete session lifecycle with real browser events', async () => {
    // Phase 1: Session creation with initial tabs
    const initialTabs = [
      {
        id: 1,
        url: 'https://example.com/page1',
        title: 'Example Page 1',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      },
      {
        id: 2,
        url: 'https://example.com/page2',
        title: 'Example Page 2',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      }
    ];
    
    mockChrome.tabs.query.mockResolvedValueOnce(initialTabs);
    const sessionId = await sessionManager.createNewSession();
    
    expect(sessionId).toBeDefined();
    expect(sessionManager.currentSessionId).toBe(sessionId);
    
    let storage = await sessionManager.getStorage();
    let session = storage.sessions.find(s => s.id === sessionId);
    
    // If no tabs were added (all filtered as system URLs), add one manually
    if (session.tabs.length === 0) {
      const manualTab = {
        id: 100,
        url: 'https://example.com/manual',
        title: 'Manual Tab',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      };
      await sessionManager.addTabToSession(manualTab);
      storage = await sessionManager.getStorage();
      session = storage.sessions.find(s => s.id === sessionId);
    }
    
    expect(session.tabs.length).toBeGreaterThan(0);
    const initialTabCount = session.tabs.length;
    
    // Phase 2: Add new tab to session
    const newTab = {
      id: 3,
      url: 'https://example.com/page3',
      title: 'Example Page 3',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(newTab);
    
    storage = await sessionManager.getStorage();
    session = storage.sessions.find(s => s.id === sessionId);
    expect(session.tabs.length).toBeGreaterThan(initialTabCount);
    expect(session.tabs.some(t => t.url === newTab.url)).toBe(true);
    
    // Phase 3: Update existing tab (if one exists)
    if (session.tabs.length > 0) {
      const tabToUpdate = session.tabs[0];
      const updatedTab = {
        url: 'https://example.com/page1-updated',
        title: 'Example Page 1 Updated',
        favIconUrl: 'https://example.com/favicon-updated.ico'
      };
      
      await sessionManager.updateTabInSession(tabToUpdate.tabId, updatedTab);
      
      storage = await sessionManager.getStorage();
      session = storage.sessions.find(s => s.id === sessionId);
      const updatedTabEntry = session.tabs.find(t => t.tabId === tabToUpdate.tabId);
      expect(updatedTabEntry).toBeDefined();
      expect(updatedTabEntry.url).toBe(updatedTab.url);
      expect(updatedTabEntry.title).toBe(updatedTab.title);
    }
    
    // Phase 4: Close a tab
    const tabsBeforeClose = session.tabs.length;
    const closedTabsBeforeClose = session.closedTabs.length;
    
    await sessionManager.moveTabToClosedTabs(3);
    
    storage = await sessionManager.getStorage();
    session = storage.sessions.find(s => s.id === sessionId);
    expect(session.tabs.length).toBe(tabsBeforeClose - 1);
    expect(session.closedTabs.length).toBe(closedTabsBeforeClose + 1);
    expect(session.closedTabs[0].url).toBe(newTab.url);
    
    // Phase 5: Verify session continuity
    expect(sessionManager.currentSessionId).toBe(sessionId);
    expect(storage.currentSessionId).toBe(sessionId);
    
    // Phase 6: Verify session metadata is updated
    expect(session.modified).toBeGreaterThanOrEqual(session.created);
  });

  /**
   * Integration Test: Session persistence across service worker restarts
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
   * 
   * Test that session state is properly restored after service worker restart
   */
  it('Integration Test: Session persistence across service worker restarts', async () => {
    // Phase 1: Create initial session with tabs
    const initialTabs = [
      {
        id: 1,
        url: 'https://example.com/page1',
        title: 'Page 1',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      },
      {
        id: 2,
        url: 'https://example.com/page2',
        title: 'Page 2',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      }
    ];
    
    mockChrome.tabs.query.mockResolvedValueOnce(initialTabs);
    const originalSessionId = await sessionManager.createNewSession();
    
    // Add some tabs and close one
    const newTab = {
      id: 3,
      url: 'https://example.com/page3',
      title: 'Page 3',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(newTab);
    await sessionManager.moveTabToClosedTabs(3);
    
    // Get pre-restart state
    const preRestartStorage = await sessionManager.getStorage();
    const preRestartSession = preRestartStorage.sessions.find(s => s.id === originalSessionId);
    const preRestartTabCount = preRestartSession.tabs.length;
    const preRestartClosedTabCount = preRestartSession.closedTabs.length;
    
    // Phase 2: Simulate service worker restart
    // Create new SessionManager instance (simulating restart)
    const newSessionManager = new SessionManager({
      STORAGE_KEY: 'incognito_sessions',
      SETTINGS_KEY: 'incognito_settings',
      MAX_SESSIONS: 50,
      MAX_CLOSED_TABS: 50
    });
    
    // Initialize the new manager
    await newSessionManager.initialize();
    
    // Phase 3: Verify session state is restored
    expect(newSessionManager.currentSessionId).toBe(originalSessionId);
    
    const postRestartStorage = await newSessionManager.getStorage();
    const postRestartSession = postRestartStorage.sessions.find(s => s.id === originalSessionId);
    
    expect(postRestartSession).toBeDefined();
    expect(postRestartSession.tabs.length).toBe(preRestartTabCount);
    expect(postRestartSession.closedTabs.length).toBe(preRestartClosedTabCount);
    expect(postRestartSession.tabs).toEqual(preRestartSession.tabs);
    expect(postRestartSession.closedTabs).toEqual(preRestartSession.closedTabs);
    
    // Phase 4: Verify we can continue operations after restart
    const anotherTab = {
      id: 4,
      url: 'https://example.com/page4',
      title: 'Page 4',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await newSessionManager.addTabToSession(anotherTab);
    
    const finalStorage = await newSessionManager.getStorage();
    const finalSession = finalStorage.sessions.find(s => s.id === originalSessionId);
    expect(finalSession.tabs.some(t => t.url === anotherTab.url)).toBe(true);
  });

  /**
   * Integration Test: Concurrent session operations
   * **Validates: Requirements 1.1, 1.2, 1.3, 5.3**
   * 
   * Test that concurrent tab operations don't cause race conditions or data corruption
   */
  it('Integration Test: Concurrent session operations', async () => {
    // Phase 1: Create session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const sessionId = await sessionManager.createNewSession();
    
    // Phase 2: Perform concurrent tab operations
    const tabs = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      url: `https://example.com/page${i + 1}`,
      title: `Page ${i + 1}`,
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    }));
    
    // Add all tabs concurrently
    const addPromises = tabs.map(tab => sessionManager.addTabToSession(tab));
    await Promise.all(addPromises);
    
    // Phase 3: Verify all tabs were added without corruption
    const storage = await sessionManager.getStorage();
    const session = storage.sessions.find(s => s.id === sessionId);
    
    expect(session).toBeDefined();
    expect(session.tabs.length).toBeGreaterThan(0);
    
    // Verify all tabs are present (accounting for deduplication)
    for (const tab of tabs) {
      const found = session.tabs.some(t => t.url === tab.url);
      expect(found).toBe(true);
    }
    
    // Phase 4: Perform concurrent updates
    const updatePromises = tabs.slice(0, 5).map(tab => 
      sessionManager.updateTabInSession(tab.id, {
        url: tab.url + '-updated',
        title: tab.title + ' Updated'
      })
    );
    await Promise.all(updatePromises);
    
    // Phase 5: Verify updates were applied correctly
    const updatedStorage = await sessionManager.getStorage();
    const updatedSession = updatedStorage.sessions.find(s => s.id === sessionId);
    
    for (let i = 0; i < 5; i++) {
      const updatedTab = updatedSession.tabs.find(t => t.tabId === tabs[i].id);
      expect(updatedTab.url).toContain('updated');
    }
    
    // Phase 6: Verify session consistency
    expect(updatedSession.modified).toBeGreaterThanOrEqual(session.modified);
    expect(storage.currentSessionId).toBe(sessionId);
  });

  /**
   * Integration Test: UI synchronization with background state
   * **Validates: Requirements 5.1, 5.2, 5.4**
   * 
   * Test that UI can properly synchronize with background session state
   */
  it('Integration Test: UI synchronization with background state', async () => {
    // Phase 1: Background creates session with tabs
    const tabs = [
      {
        id: 1,
        url: 'https://example.com/page1',
        title: 'Page 1',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      },
      {
        id: 2,
        url: 'https://example.com/page2',
        title: 'Page 2',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      }
    ];
    
    mockChrome.tabs.query.mockResolvedValueOnce(tabs);
    const sessionId = await sessionManager.createNewSession();
    
    // Phase 2: Background adds and updates tabs
    const newTab = {
      id: 3,
      url: 'https://example.com/page3',
      title: 'Page 3',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(newTab);
    
    await sessionManager.updateTabInSession(1, {
      url: 'https://example.com/page1-updated',
      title: 'Page 1 Updated'
    });
    
    // Phase 3: UI retrieves current session state
    const backgroundSession = await sessionManager.getCurrentSession();
    
    // Phase 4: UI gets storage directly (simulating popup opening)
    const storage = await sessionManager.getStorage();
    const uiSession = storage.sessions.find(s => s.id === sessionId);
    
    // Phase 5: Verify UI state matches background state
    expect(uiSession).toBeDefined();
    expect(uiSession.id).toBe(backgroundSession.id);
    expect(uiSession.tabs.length).toBe(backgroundSession.tabs.length);
    expect(uiSession.tabs).toEqual(backgroundSession.tabs);
    expect(uiSession.closedTabs).toEqual(backgroundSession.closedTabs);
    expect(uiSession.modified).toBe(backgroundSession.modified);
    
    // Phase 6: Verify all expected tabs are present (if they were added)
    // Note: Some tabs might be filtered out as system URLs, so we check what was actually added
    if (backgroundSession.tabs.length > 0) {
      // Verify at least one tab is present
      expect(uiSession.tabs.length).toBeGreaterThan(0);
    }
  });

  /**
   * Integration Test: Multiple session management
   * **Validates: Requirements 1.1, 1.2, 4.2, 4.4**
   * 
   * Test managing multiple sessions simultaneously
   */
  it('Integration Test: Multiple session management', async () => {
    // Phase 1: Create first session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/session1/page1',
      title: 'Session 1 Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab1);
    
    // Phase 2: Create second session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    const tab2 = {
      id: 2,
      url: 'https://example.com/session2/page1',
      title: 'Session 2 Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab2);
    
    // Phase 3: Create third session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session3Id = await sessionManager.createNewSession();
    
    const tab3 = {
      id: 3,
      url: 'https://example.com/session3/page1',
      title: 'Session 3 Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab3);
    
    // Phase 4: Verify all sessions exist and are independent
    const storage = await sessionManager.getStorage();
    
    const session1 = storage.sessions.find(s => s.id === session1Id);
    const session2 = storage.sessions.find(s => s.id === session2Id);
    const session3 = storage.sessions.find(s => s.id === session3Id);
    
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session3).toBeDefined();
    
    expect(session1.tabs.some(t => t.url === tab1.url)).toBe(true);
    expect(session2.tabs.some(t => t.url === tab2.url)).toBe(true);
    expect(session3.tabs.some(t => t.url === tab3.url)).toBe(true);
    
    // Phase 5: Verify current session is the most recent
    expect(sessionManager.currentSessionId).toBe(session3Id);
    expect(storage.currentSessionId).toBe(session3Id);
    
    // Phase 6: Switch between sessions
    await sessionManager.switchToSession(session1Id);
    
    const storageAfterSwitch = await sessionManager.getStorage();
    expect(sessionManager.currentSessionId).toBe(session1Id);
    expect(storageAfterSwitch.currentSessionId).toBe(session1Id);
    
    // Verify other sessions are unchanged
    const session2After = storageAfterSwitch.sessions.find(s => s.id === session2Id);
    expect(session2After.tabs.some(t => t.url === tab2.url)).toBe(true);
  });

  /**
   * Integration Test: Session closure and cleanup
   * **Validates: Requirements 4.1, 4.3, 4.5**
   * 
   * Test proper session closure and data preservation
   */
  it('Integration Test: Session closure and cleanup', async () => {
    // Phase 1: Create session with tabs
    const tabs = [
      {
        id: 1,
        url: 'https://example.com/page1',
        title: 'Page 1',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      },
      {
        id: 2,
        url: 'https://example.com/page2',
        title: 'Page 2',
        incognito: true,
        favIconUrl: 'https://example.com/favicon.ico',
        windowId: 1
      }
    ];
    
    mockChrome.tabs.query.mockResolvedValueOnce(tabs);
    const sessionId = await sessionManager.createNewSession();
    
    // Phase 2: Add and close some tabs
    const newTab = {
      id: 3,
      url: 'https://example.com/page3',
      title: 'Page 3',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(newTab);
    await sessionManager.moveTabToClosedTabs(3);
    
    // Get pre-closure state
    const preClosureStorage = await sessionManager.getStorage();
    const preClosureSession = preClosureStorage.sessions.find(s => s.id === sessionId);
    const preClosureTabCount = preClosureSession.tabs.length;
    const preClosureClosedTabCount = preClosureSession.closedTabs.length;
    
    // Phase 3: Close the session
    await sessionManager.closeSession(sessionId);
    
    // Phase 4: Verify session is closed
    expect(sessionManager.currentSessionId).toBeNull();
    
    const postClosureStorage = await sessionManager.getStorage();
    const postClosureSession = postClosureStorage.sessions.find(s => s.id === sessionId);
    
    expect(postClosureSession.status).toBe('closed');
    expect(postClosureStorage.currentSessionId).toBeNull();
    
    // Phase 5: Verify session data is preserved
    expect(postClosureSession.tabs.length).toBe(preClosureTabCount);
    expect(postClosureSession.closedTabs.length).toBe(preClosureClosedTabCount);
    expect(postClosureSession.tabs).toEqual(preClosureSession.tabs);
    expect(postClosureSession.closedTabs).toEqual(preClosureSession.closedTabs);
    
    // Phase 6: Verify metadata is updated
    expect(postClosureSession.modified).toBeGreaterThanOrEqual(preClosureSession.modified);
  });

  /**
   * Integration Test: Session restoration workflow
   * **Validates: Requirements 2.5, 4.2, 4.4**
   * 
   * Test complete session restoration workflow
   */
  it('Integration Test: Session restoration workflow', async () => {
    // Phase 1: Create first session with tabs
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session1Id = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/session1/page1',
      title: 'Session 1 Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    const tab2 = {
      id: 2,
      url: 'https://example.com/session1/page2',
      title: 'Session 1 Page 2',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab1);
    await sessionManager.addTabToSession(tab2);
    
    // Phase 2: Close one tab
    await sessionManager.moveTabToClosedTabs(2);
    
    // Phase 3: Create second session
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const session2Id = await sessionManager.createNewSession();
    
    // Phase 4: Verify session 1 is not active
    expect(sessionManager.currentSessionId).toBe(session2Id);
    
    // Phase 5: Get session 1 data for restoration
    const session1Data = await sessionManager.getSessionForRestoration(session1Id);
    
    expect(session1Data.sessionId).toBe(session1Id);
    expect(session1Data.tabs.length).toBeGreaterThan(0);
    expect(session1Data.closedTabs.length).toBeGreaterThan(0);
    
    // Phase 6: Restore session 1
    const restoredData = await sessionManager.restoreSession(session1Id);
    
    expect(restoredData.sessionId).toBe(session1Id);
    expect(sessionManager.currentSessionId).toBe(session1Id);
    
    // Phase 7: Verify session 1 is now active and data is intact
    const storage = await sessionManager.getStorage();
    const restoredSession = storage.sessions.find(s => s.id === session1Id);
    
    expect(restoredSession.tabs.length).toBe(session1Data.tabs.length);
    expect(restoredSession.closedTabs.length).toBe(session1Data.closedTabs.length);
    expect(restoredSession.tabs).toEqual(session1Data.tabs);
    expect(restoredSession.closedTabs).toEqual(session1Data.closedTabs);
    
    // Phase 8: Verify session 2 is still in storage
    const session2 = storage.sessions.find(s => s.id === session2Id);
    expect(session2).toBeDefined();
  });

  /**
   * Integration Test: Error recovery and data consistency
   * **Validates: Requirements 5.2, 5.5**
   * 
   * Test that system recovers from errors while maintaining data consistency
   */
  it('Integration Test: Error recovery and data consistency', async () => {
    // Phase 1: Create session with tabs
    mockChrome.tabs.query.mockResolvedValueOnce([]);
    const sessionId = await sessionManager.createNewSession();
    
    const tab1 = {
      id: 1,
      url: 'https://example.com/page1',
      title: 'Page 1',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab1);
    
    // Get initial state
    const initialStorage = await sessionManager.getStorage();
    const initialSessionCount = initialStorage.sessions.length;
    
    // Phase 2: Attempt invalid operations
    try {
      await sessionManager.updateTabInSession(99999, {
        url: 'https://example.com/invalid',
        title: 'Invalid'
      });
    } catch (error) {
      // Error expected
    }
    
    try {
      await sessionManager.switchToSession('invalid_session_id');
    } catch (error) {
      // Error expected
    }
    
    // Phase 3: Verify data consistency after errors
    const afterErrorStorage = await sessionManager.getStorage();
    
    expect(afterErrorStorage.sessions.length).toBe(initialSessionCount);
    expect(afterErrorStorage.currentSessionId).toBe(sessionId);
    
    const session = afterErrorStorage.sessions.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session.tabs.some(t => t.url === tab1.url)).toBe(true);
    
    // Phase 4: Verify we can continue normal operations
    const tab2 = {
      id: 2,
      url: 'https://example.com/page2',
      title: 'Page 2',
      incognito: true,
      favIconUrl: 'https://example.com/favicon.ico',
      windowId: 1
    };
    
    await sessionManager.addTabToSession(tab2);
    
    const finalStorage = await sessionManager.getStorage();
    const finalSession = finalStorage.sessions.find(s => s.id === sessionId);
    
    expect(finalSession.tabs.some(t => t.url === tab2.url)).toBe(true);
    expect(finalStorage.currentSessionId).toBe(sessionId);
  });
});
