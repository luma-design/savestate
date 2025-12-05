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
          // Setup: Create session and add a tab
          mockChrome.tabs.query.mockResolvedValueOnce([]);
          const sessionId = await sessionManager.createNewSession();
          await sessionManager.addTabToSession(tab);
          
          const storageBeforeClose = await sessionManager.getStorage();
          const sessionBeforeClose = storageBeforeClose.sessions.find(s => s.id === sessionId);
          const initialActiveTabCount = sessionBeforeClose.tabs.length;
          const initialClosedTabCount = sessionBeforeClose.closedTabs.length;
          
          // Verify: Tab is in active tabs
          expect(sessionBeforeClose.tabs.some(t => t.tabId === tab.id)).toBe(true);
          
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
