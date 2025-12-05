# Debugging on Kiwi Browser

The extension now has extensive logging to help diagnose issues.

## How to View Console Logs on Kiwi Browser

### Option 1: Desktop Mode DevTools (Recommended)
1. In Kiwi Browser, tap the **three dots** menu
2. Enable **Desktop site** mode
3. Navigate to `chrome://extensions/`
4. Find "Incognito Tab Saver"
5. Look for **Inspect views: popup.html** (appears when popup is open)
6. Tap it to open DevTools

### Option 2: Check Service Worker Logs
1. Navigate to `chrome://extensions/`
2. Find "Incognito Tab Saver"
3. Tap **"service worker"** or **"background page"**
4. View logs in the console

## Testing Steps

### Test 1: Check if Extension Loads
1. Open the extension popup
2. Do you see sessions listed?
3. Do you see the red warning banner (if in normal tab)?

**Expected**: Popup shows sessions and warning banner if not in incognito

### Test 2: Check Console Logs
1. Open popup from an **incognito tab**
2. Open DevTools (see above)
3. In the console, look for:
   - `[POPUP] Incognito mode: true`
   - Session data

**Expected**: Should see `Incognito mode: true` and your saved sessions

### Test 3: Click Restore Button
1. Click the "Restore" button on any session
2. Watch the console for logs starting with `[POPUP HANDLER]` and `[POPUP RESTORE]`

**What to look for:**
- `[POPUP HANDLER] ========== EVENT HANDLER TRIGGERED ==========`
- `[POPUP RESTORE] ========== RESTORE STARTED ==========`
- `[POPUP RESTORE] Session tabs:` - **Does it show your tabs?**
- `[POPUP RESTORE] Number of tabs:` - **Is it > 0?**

### Test 4: Click Individual Tab
1. Click on any individual tab in a session
2. Watch for `[POPUP OPEN TAB]` logs
3. Does a tab open?

## Common Issues

### Issue: "No tabs to restore in this session"
**Cause**: The session's `tabs` array is empty
**Solution**:
- Make sure tabs are being saved automatically
- Open some incognito tabs and wait 1 minute
- Check if they appear in "Current Session"

### Issue: Restore button does nothing (no alert, no logs)
**Cause**: Event handler not being triggered
**Solution**:
- Check console for JavaScript errors
- Make sure you clicked the correct button
- Try reloading the extension

### Issue: Tabs open in normal mode instead of incognito

**ROOT CAUSE**: Kiwi Browser has NO working API to create incognito tabs programmatically

**FINAL SOLUTION**: Manual workaround - pre-open incognito tabs, then navigate them

**How it works**:
1. **Before restoring**: Manually open enough blank incognito tabs
   - Example: Session has 5 URLs → Open 5 blank incognito tabs first
   - Open them to any URL (google.com, about:blank, etc.)

2. **Click "Restore"**: Extension will:
   - Find all your existing incognito tabs
   - Navigate each one to a saved URL
   - All tabs stay in incognito mode ✅

3. **If you don't have enough tabs**:
   - Dialog shows: "You have 3 tabs, need 5, open 2 more"
   - Options:
     - OK = Restore first 3 URLs only
     - Cancel = Open more tabs and try again

**Why this is the ONLY solution**:
- Navigating existing incognito tabs PRESERVES incognito status ✅
- Every other method FAILS on Kiwi Browser ❌

**EXHAUSTIVE LIST of attempts that failed**:
1. ❌ `chrome.windows.create({incognito: true})` - Creates normal tabs (no real windows on mobile)
2. ❌ `chrome.tabs.create({windowId: incognitoWindowId})` - Creates normal tabs even in incognito window
3. ❌ `chrome.tabs.create({openerTabId: incognitoTabId})` - Ignores incognito inheritance on Kiwi
4. ❌ `chrome.windows.create({url: [...]})` - Creates tabs but ignores URLs
5. ❌ `chrome.tabs.duplicate(incognitoTab)` - **CRASHES the entire browser**
6. ✅ Changed manifest to `"incognito": "split"` - Required but not sufficient
7. ✅ Navigate existing incognito tabs - **ONLY working method**

**This is a fundamental Kiwi Browser limitation, not a bug in the extension.**

## Send Me Debug Info

If it still doesn't work, please send:
1. Screenshot of the popup
2. Console logs (copy/paste all text starting with `[POPUP]`)
3. Answer these questions:
   - Do you see any sessions?
   - How many tabs are in the session you're trying to restore?
   - Are you opening the popup from an incognito tab?
   - Do you see any error messages?
