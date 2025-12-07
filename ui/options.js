// Options page for Incognito Tab Saver

const SETTINGS_KEY = 'incognito_settings';
const STORAGE_KEY = 'incognito_sessions';

const autoDeleteCheckbox = document.getElementById('autoDelete');
const retentionDaysInput = document.getElementById('retentionDays');
const deduplicateTabsCheckbox = document.getElementById('deduplicateTabs');
const storageUsedDiv = document.getElementById('storageUsed');
const storageTextDiv = document.getElementById('storageText');
const clearAllBtn = document.getElementById('clearAllBtn');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const toast = document.getElementById('toast');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');

let lastStorageWarning = null; // Track last warning to avoid spam

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  updateStorageInfo();
  setupEventListeners();
  setInterval(updateStorageInfo, 5000);
});

function setupEventListeners() {
  saveBtn.addEventListener('click', saveSettings);
  resetBtn.addEventListener('click', resetSettings);
  clearAllBtn.addEventListener('click', clearAllSessions);
  autoDeleteCheckbox.addEventListener('change', toggleRetentionDays);

  // Import/Export
  exportBtn.addEventListener('click', exportSessions);
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', importSessionsFromFile);
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
      showToast('Sessions exported successfully', 'success');
    } else {
      showToast('Failed to export sessions', 'error');
    }
  } catch (error) {
    console.error('Error exporting sessions:', error);
    showToast('Failed to export sessions', 'error');
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
      updateStorageInfo();
      showToast('Sessions imported successfully', 'success');
    } catch (error) {
      console.error('Error importing sessions:', error);
      showToast('Failed to import sessions', 'error');
    }
  };
  reader.readAsText(file);

  event.target.value = '';
}

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = data[SETTINGS_KEY] || {
    maxSessions: 50,
    autoDelete: false,
    retentionDays: 30,
    deduplicateTabs: true
  };

  autoDeleteCheckbox.checked = settings.autoDelete;
  document.getElementById('promptForName').checked = settings.promptForName !== false; // Default true
  retentionDaysInput.value = settings.retentionDays;
  deduplicateTabsCheckbox.checked = settings.deduplicateTabs;

  toggleRetentionDays();
}

async function saveSettings() {
  const settings = {
    maxSessions: 50,
    autoDelete: autoDeleteCheckbox.checked,
    promptForName: document.getElementById('promptForName').checked,
    retentionDays: parseInt(retentionDaysInput.value) || 30,
    deduplicateTabs: deduplicateTabsCheckbox.checked
  };

  // Enhanced validation
  if (isNaN(settings.retentionDays) || settings.retentionDays < 1) {
    showToast('Retention days must be at least 1', 'error');
    return;
  }

  if (settings.retentionDays > 365) {
    showToast('Retention period cannot exceed 365 days', 'error');
    return;
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  showToast('Settings saved successfully', 'success');
}

async function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;

  const defaults = {
    maxSessions: 50,
    autoDelete: false,
    promptForName: true,
    retentionDays: 30,
    deduplicateTabs: true
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: defaults });
  loadSettings();
  showToast('Settings reset to defaults', 'success');
}

async function clearAllSessions() {
  if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      sessions: [],
      currentSessionId: null
    }
  });

  updateStorageInfo();
  showToast('All sessions cleared', 'success');
}

function toggleRetentionDays() {
  retentionDaysInput.disabled = !autoDeleteCheckbox.checked;
}

async function updateStorageInfo() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const storage = data[STORAGE_KEY] || { sessions: [] };

    const jsonString = JSON.stringify(storage);
    const sizeBytes = new Blob([jsonString]).size;
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
    const maxMB = 100;
    const percentage = Math.min((sizeBytes / (maxMB * 1024 * 1024)) * 100, 100);

    storageUsedDiv.style.width = percentage + '%';
    storageTextDiv.textContent = `${sizeMB} MB / ${maxMB} MB`;

    // Add warning system with deduplication to avoid spam
    storageTextDiv.classList.remove('critical', 'warning');
    if (percentage > 90) {
      storageTextDiv.classList.add('critical');
      // Only show warning once per level change
      if (lastStorageWarning !== 'critical') {
        showToast('Storage critically full (>90%)! Please delete old sessions to avoid data loss.', 'error');
        lastStorageWarning = 'critical';
      }
    } else if (percentage > 80) {
      storageTextDiv.classList.add('warning');
      // Only show warning once per level change
      if (lastStorageWarning !== 'warning' && lastStorageWarning !== 'critical') {
        showToast('Storage 80% full. Consider deleting old sessions.', 'error');
        lastStorageWarning = 'warning';
      }
    } else {
      // Reset warning state when storage drops below thresholds
      lastStorageWarning = null;
    }
  } catch (error) {
    console.error('Error updating storage info:', error);
  }
}

function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}
