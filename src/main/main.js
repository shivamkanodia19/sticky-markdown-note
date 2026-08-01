// main.js
const { app, BrowserWindow, ipcMain, protocol, net, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { dialog, nativeTheme } = require('electron');

app.setAppUserModelId('com.hsmin.stickymarkdownnote');

const openNoteWindows = {}; // { fullPath: BrowserWindow }

const stateFilePath = path.join(app.getPath('userData'), 'note-window-state.json');

// Notes are saved as plain .md files in their own dedicated folder, not
// Electron's default userData folder and not the vault -- kept independent
// so this app stays simple and an AI agent can read notes here directly
// instead of the vault modeling sticky-note capture.
const notesDir = 'C:\\Users\\shiva\\Sticky Notes';
if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });

// "Send to ChatGPT" destination: mirrors a tagged note's content into the
// Google Drive desktop-sync folder, which Shivam has connected to ChatGPT as
// a native Drive connector. This is a *mirror*, never the source of truth --
// the vault Inbox copy above is always the real note. Drive may not be
// mounted (sync client not running yet, drive letter changed, etc.), so every
// mirror operation checks for the mount rather than assuming it exists.
const driveRoot = 'G:\\My Drive';
const chatgptMirrorDir = path.join(driveRoot, 'ChatGPT Notes');

// The main process is shared across every open note window, so ANY
// synchronous fs call in here blocks typing/clicking/dragging in every
// other open window, not just the one being mirrored -- not just "this
// note freezes", the whole app freezes. G:\My Drive is a cloud-sync mount
// (placeholder resolution, antivirus scanning, network hiccups), so a slow
// round-trip there is exactly the kind of call that must never be
// synchronous. Everything below uses fs.promises instead of the *Sync
// variants, and the mount check itself is cached (re-verified at most once
// per DRIVE_MOUNT_CACHE_MS) so a mirror write doesn't stat the drive root
// on every single call.
const DRIVE_MOUNT_CACHE_MS = 45000;
let driveMountCache = { checkedAt: 0, mounted: false };

async function isDriveMounted() {
  const now = Date.now();
  if (now - driveMountCache.checkedAt < DRIVE_MOUNT_CACHE_MS) {
    return driveMountCache.mounted;
  }
  let mounted = false;
  try {
    await fs.promises.access(driveRoot);
    mounted = true;
  } catch {
    mounted = false;
  }
  driveMountCache = { checkedAt: now, mounted };
  return mounted;
}

async function ensureChatgptMirrorDir() {
  const mounted = await isDriveMounted();
  if (!mounted) {
    console.warn('Google Drive not mounted at', driveRoot, '- skipping ChatGPT mirror');
    return false;
  }
  try {
    await fs.promises.mkdir(chatgptMirrorDir, { recursive: true });
    return true;
  } catch (e) {
    console.error('Failed to prepare ChatGPT mirror dir:', e);
    return false;
  }
}

function chatgptMirrorPathFor(notePath) {
  return path.join(chatgptMirrorDir, path.basename(notePath));
}

// Tagging now defaults ON for every new note (see createNoteWindow below),
// so this write path is about to become the common case across every open,
// actively-typed-in note instead of a rare opt-in one. The debounce that
// calls this already lives on the renderer's existing 1s autosave timer (one
// per note window, independent of every other window), so write *frequency*
// per note doesn't change -- but content that hasn't actually changed since
// the last successful mirror write (e.g. a save re-firing with identical
// text, or a stray call right after the mirror already caught up) shouldn't
// cost a real Drive write. Tracked per note path, in memory only.
const lastMirroredContent = new Map(); // fullPath -> last content written

async function writeChatgptMirror(notePath, content) {
  const fullPath = path.resolve(notePath);
  const normalized = content ?? '';
  if (lastMirroredContent.get(fullPath) === normalized) return;

  const ok = await ensureChatgptMirrorDir();
  if (!ok) return;
  try {
    await fs.promises.writeFile(chatgptMirrorPathFor(notePath), normalized, 'utf-8');
    lastMirroredContent.set(fullPath, normalized);
  } catch (e) {
    console.error('ChatGPT mirror write failed:', e);
  }
}

async function deleteChatgptMirror(notePath) {
  const fullPath = path.resolve(notePath);
  lastMirroredContent.delete(fullPath);
  const mirrorPath = chatgptMirrorPathFor(notePath);
  try {
    await fs.promises.unlink(mirrorPath);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('ChatGPT mirror delete failed:', e);
  }
}

// For saving the last session (open notes)
const sessionFile = path.join(app.getPath('userData'), 'last-session.json');

// === Immediate Session Save Function ===
function writeSessionNow() {
  const openPaths = Object.keys(openNoteWindows).filter(fullPath => {
    const w = openNoteWindows[fullPath];
    return w && !w.isDestroyed();
  });
  try {
    fs.writeFileSync(sessionFile, JSON.stringify(openPaths, null, 2));
  } catch (e) {
    console.error('last-session write failed:', e);
  }
}

let Store; // Declare Store as a variable globally
let store; // Declare store instance globally

let mainWindow;
let settingsWindow; // Add this line to declare settingsWindow globally
let tray; // System tray icon, keeps the app reachable after all note windows close

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    frame: false,
    hasShadow: true,
    show: false, // Start hidden
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('src/renderer/list/list.html');

  // Set initial theme and show window when ready
  mainWindow.webContents.once('did-finish-load', () => {
    if (store) {
      mainWindow.webContents.send('theme-changed', store.get('theme'));
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Settings button click event handler
  ipcMain.on('open-settings-window', () => {
    createSettingsWindow();
  });
}

function showMemoList() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// Tray icon keeps the app running in the background so closing every note
// window (and the Memo List) doesn't quit the whole app -- matches the
// "always-on sticky notes" behavior. Lets Shivam get back in or quit for real.
function createTray() {
  if (tray) return;

  tray = new Tray(path.join(app.getAppPath(), 'assets', 'icon.ico'));
  tray.setToolTip('Sticky Markdown Note');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Memo List', click: showMemoList },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', showMemoList);
}

function createNoteWindow(notePath, position = null, isNew = false) {
  const fullPath = path.resolve(notePath); // Standardize path

  if (!fs.existsSync(fullPath)) {
    console.error('This file does not exist:', fullPath);
    return;
  }

  // If window is already open, just focus it
  if (openNoteWindows[fullPath]) {
    if (!openNoteWindows[fullPath].isDestroyed()) {
      openNoteWindows[fullPath].focus();
      return;
    } else {
      // If destroyed but still registered -> clean up and reopen
      delete openNoteWindows[fullPath];
    }
  }

  // Load previous position/size/pin state
  const savedBounds = loadWindowState(fullPath);

  // Pin ("always on top") defaults to true: the whole point of this app is
  // behaving like a real sticky note that stays visible, so a note only
  // stops being pinned if Shivam explicitly un-pins it (recorded below).
  const pinned = savedBounds?.pinned !== undefined ? savedBounds.pinned : true;

  // Create new window
  const win = new BrowserWindow({
    width: savedBounds?.width || 400,
    height: savedBounds?.height || 400,
    x: position?.x ?? savedBounds?.x,
    y: position?.y ?? savedBounds?.y,
    alwaysOnTop: pinned,
    frame: false,
    hasShadow: true,
    show: false, // Start hidden
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile('src/renderer/note/note.html');

  // Set initial theme and show window when ready
  win.webContents.once('did-finish-load', () => {
    if (store) { // Ensure 'store' is initialized before accessing it
      win.webContents.send('theme-changed', store.get('theme'));
    } else {
      console.warn("Store not initialized when setting initial theme for note window.");
    }
    
    // Show window and focus it
    win.show();
    win.focus();
  });

  win.notePath = notePath;
  win.isNewNote = isNew;
  // Cached on the window instance so the frequent autosave-driven mirror
  // sync (see 'sync-chatgpt-mirror') doesn't have to re-read/parse the
  // state JSON file on every keystroke -- only the toggle handler mutates it.
  //
  // ChatGPT mirroring defaults to ON for brand-new notes -- opt-OUT instead
  // of opt-IN, so it doesn't require remembering to flip the toggle before
  // writing anything worth syncing. Mirrors the `pinned` default pattern
  // immediately above: an explicit saved value (on OR off) always wins
  // regardless of isNew, so a note that already existed before this default
  // changed, and simply has no destinations entry yet, still comes up
  // untagged exactly as before -- only genuinely new notes get the new
  // default.
  win.chatgptTagged = savedBounds?.destinations?.chatgpt !== undefined
    ? !!savedBounds.destinations.chatgpt
    : !!isNew;

  win.on('focus', () => {
    win.webContents.send('window-focused');
  });

  win.on('blur', () => {
    win.webContents.send('window-blurred');
    win.flashFrame(false); // Stop flashing when focus is lost
  });

  win.on('close', () => {
    // Save window position/size
    const bounds = win.getBounds();
    saveWindowState(fullPath, bounds);
  });

  win.on('moved', () => {
    // Save every time the window is moved
    const bounds = win.getBounds();
    saveWindowState(fullPath, bounds);
  });

  win.on('resized', () => {
    // Save every time the window is resized
    const bounds = win.getBounds();
    saveWindowState(fullPath, bounds);
  });

  win.on('closed', () => {
    delete openNoteWindows[fullPath];
    writeSessionNow(); // Window closed, save session again

    // Refresh list when window is closed
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('refresh-list');
    }
  });

  // Register note path -> window
  openNoteWindows[fullPath] = win;

  // Window is new, save session immediately
  writeSessionNow();
}

function createNewNote(position = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `note-${timestamp}.md`;
  const filePath = path.join(notesDir, fileName);

  // Create file with empty content
  fs.writeFileSync(filePath, '', 'utf-8');

  // New notes default to ChatGPT-tagged now (see createNoteWindow), so the
  // mirror should exist from the moment the note does, not only once the
  // first edit happens to flush the autosave debounce. Fire-and-forget and
  // fully async -- never block note creation on Drive I/O.
  writeChatgptMirror(filePath, '').catch(() => {});

  // Open new window
  createNoteWindow(filePath, position, /* isNew */ true);

  // Request refresh to list window
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }
}

function loadWindowState(notePath) {
  const fullPath = path.resolve(notePath);
  if (!fs.existsSync(stateFilePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    return data[fullPath] || null;
  } catch {
    return null;
  }
}

// Merges `updates` (bounds and/or pinned) into the existing record for this
// note instead of overwriting it, so saving new bounds doesn't wipe out a
// previously saved pin state (and vice versa) -- they're written by
// different event handlers at different times.
function saveWindowState(notePath, updates) {
  const fullPath = path.resolve(notePath);
  let data = {};
  if (fs.existsSync(stateFilePath)) {
    try {
      data = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    } catch {
      data = {};
    }
  }
  data[fullPath] = { ...(data[fullPath] || {}), ...updates };
  fs.writeFileSync(stateFilePath, JSON.stringify(data, null, 2));
}

// Destinations are stored as their own nested object (`destinations: {
// chatgpt: true }`) rather than a top-level boolean, so this merges one key
// into that object instead of replacing it wholesale -- keeps room to add a
// second destination later (e.g. `destinations.somewhereElse`) without ever
// touching this shape again, and keeps routing state fully independent of
// `pinned`, which saveWindowState above already owns.
function saveDestinationState(notePath, destKey, value) {
  const fullPath = path.resolve(notePath);
  let data = {};
  if (fs.existsSync(stateFilePath)) {
    try {
      data = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    } catch {
      data = {};
    }
  }
  const existing = data[fullPath] || {};
  const destinations = { ...(existing.destinations || {}), [destKey]: value };
  data[fullPath] = { ...existing, destinations };
  fs.writeFileSync(stateFilePath, JSON.stringify(data, null, 2));
}

function cleanStartup() {
  if (process.platform === 'win32') {
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const toDelete = [
      'electron.app.Sticky Markdown Note',
      'electron.app.Electron',
      'com.hsmin.stickymarkdownnote',
    ];

    // delete registry Run key
    toDelete.forEach(name => {
      try {
        execSync(`reg delete "${runKey}" /v "${name}" /f`, { stdio: 'ignore' });
      } catch (error) {
        console.warn('Failed to delete registry key ${name}:', error);
      }
    });

    // 1) per-user Startup folder
    const userStartup = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    // 2) all-users Startup folder
    const commonStartup = path.join(
      process.env.ProgramData || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    [userStartup, commonStartup].forEach(dir => {
      const lnk = path.join(dir, 'Sticky Markdown Note.lnk');
      if (fs.existsSync(lnk)) {
        try {
          fs.unlinkSync(lnk);
        } catch (e) {
          console.warn('Startup shortcut deletion failed:', e);
        }
      }
    });
  } else if (process.platform === 'darwin') {
    // macOS startup items cleanup
    const launchAgentsDir = path.join(app.getPath('home'), 'Library/LaunchAgents');
    const plistFile = path.join(launchAgentsDir, 'com.sticky.markdown.note.plist');
    
    if (fs.existsSync(plistFile)) {
      try {
        fs.unlinkSync(plistFile);
      } catch (e) {
        console.warn('Failed to remove macOS launch agent:', e);
      }
    }
  }
}

ipcMain.on('open-note', (event, noteFile) => {
  const notePath = path.join(notesDir, noteFile);
  createNoteWindow(notePath);
});

ipcMain.on('note-ready', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win.notePath) {
    const isNew = !!win.isNewNote;
    win.webContents.send('load-note', win.notePath, isNew);
  }
});

ipcMain.on('create-new-note', () => {
  createNewNote();
});

ipcMain.on('create-new-note-nearby', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;

  const bounds = win.getBounds();
  const offset = 40;

  const newPos = {
    x: bounds.x + offset,
    y: bounds.y + offset,
  };

  createNewNote(newPos);
});

ipcMain.on('delete-note', async (event, noteFile) => {
  const fullPath = path.resolve(path.join(notesDir, noteFile));

  // Close the window (if open) BEFORE wiping its state entry. win.close()
  // synchronously fires the 'close' listener, which calls saveWindowState
  // and would otherwise re-write a fresh bounds-only record for fullPath
  // right after we deleted it, leaving a stale orphaned entry behind for
  // every deleted note.
  if (openNoteWindows[fullPath]) {
    openNoteWindows[fullPath].close(); // Automatically cleaned up in 'closed' event
  }

  // Deleting a note that's mirrored shouldn't leave an orphaned copy behind
  // in Drive. Called unconditionally rather than gated on a persisted
  // destinations flag: new notes now default to tagged (see
  // createNoteWindow) without that default ever being written to disk, so a
  // brand-new tagged note deleted before any explicit toggle would have no
  // state-file entry to check. deleteChatgptMirror already no-ops silently
  // (ENOENT) when there's nothing to remove, so this is safe for untagged
  // notes too.
  await deleteChatgptMirror(fullPath);

  const stateDataPath = path.join(app.getPath('userData'), 'note-window-state.json');
  if (fs.existsSync(stateDataPath)) {
    try {
      const stateData = JSON.parse(fs.readFileSync(stateDataPath, 'utf-8'));
      delete stateData[fullPath];
      fs.writeFileSync(stateDataPath, JSON.stringify(stateData, null, 2));
    } catch (err) {
      console.error('Failed to clean up window state:', err);
    }
  }

  // Delete file
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }

  // Refresh list
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }
});

ipcMain.on('open-main-window', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(); // Create new window
  } else {
    mainWindow.focus(); // Focus existing window
  }
});

ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('get-notes-dir', () => {
  return notesDir;
});

ipcMain.handle('get-app-path', () => {
  return app.getAppPath();
});

// Pin ("always on top") toggle for the calling note window specifically --
// mirrors the get-notes-dir/get-app-path pattern of resolving state from
// the sender's own BrowserWindow rather than trusting an argument.
ipcMain.handle('toggle-pin', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;

  const newState = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(newState);

  if (win.notePath) {
    saveWindowState(win.notePath, { pinned: newState });
  }

  return newState;
});

ipcMain.handle('get-pin-state', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  return win.isAlwaysOnTop();
});

// "Send to ChatGPT" destination toggle -- same fromWebContents pattern as
// toggle-pin. `content` is the renderer's current (possibly still-debouncing)
// editor text, passed explicitly so turning the mirror on captures exactly
// what's on screen rather than whatever was last flushed to disk.
ipcMain.handle('toggle-chatgpt-destination', async (event, content) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath) return false;

  const newState = !win.chatgptTagged;
  win.chatgptTagged = newState;
  saveDestinationState(win.notePath, 'chatgpt', newState);

  if (newState) {
    await writeChatgptMirror(win.notePath, content);
  } else {
    await deleteChatgptMirror(win.notePath);
  }

  return newState;
});

ipcMain.handle('get-destinations', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return {};
  return { chatgpt: !!win.chatgptTagged };
});

// Fire-and-forget mirror sync, called from the renderer's existing autosave
// path right after it writes the primary file. Guarded by the cached
// win.chatgptTagged flag so untagged notes never touch Drive.
ipcMain.on('sync-chatgpt-mirror', (event, content) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath || !win.chatgptTagged) return;
  writeChatgptMirror(win.notePath, content);
});

app.on('ready', async () => {
  // Dynamically import electron-store and initialize the store instance --
  // and register every IPC handler that depends on it -- BEFORE creating any
  // window. Windows are created with show:false and only shown after
  // did-finish-load, but their renderers call ipcRenderer.invoke('get-
  // current-theme') as soon as their own script runs; if that happens
  // before these handlers exist the invoke rejects, the dark-mode class
  // never gets applied, and the window shows with whatever background the
  // HTML/CSS defaulted to regardless of the real stored theme (a FOUC/wrong-
  // theme flash). Registering handlers first removes the race entirely.
  Store = (await import('electron-store')).default;
  store = new Store();

  // Initial theme setting (system theme or stored setting)
  if (store.get('theme') === undefined) {
    store.set('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  }

  // IPC handlers for theme
  ipcMain.handle('toggle-theme', () => {
    const currentTheme = store.get('theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    store.set('theme', newTheme);

    // Notify all open windows about theme change
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('theme-changed', newTheme);
    });

    return newTheme;
  });

  ipcMain.handle('get-current-theme', () => {
    return store.get('theme');
  });

  // Set default shortcuts if not exists
  if (!store.get('shortcuts')) {
    store.set('shortcuts', {
      'preview': { key: 'p', modifiers: ['ctrl'] },
      'toggle-view': { key: 'o', modifiers: ['ctrl'] },
      'open-main': { key: 'm', modifiers: ['ctrl'] },
      'new-note': { key: 'n', modifiers: ['ctrl'] },
      'bold': { key: 'b', modifiers: ['ctrl'] },
      'italic': { key: 'i', modifiers: ['ctrl'] },
      'inline-code': { key: '`', modifiers: ['ctrl'] },
      'code-block': { key: 'k', modifiers: ['ctrl'] },
      'quote': { key: 'q', modifiers: ['ctrl'] },
      'heading': { key: 'h', modifiers: ['ctrl'] },
      'strikethrough': { key: 's', modifiers: ['ctrl', 'shift'] },
      'link': { key: 'l', modifiers: ['ctrl'] },
      'bullet-list': { key: 'l', modifiers: ['ctrl', 'shift'] },
      'numbered-list': { key: 'o', modifiers: ['ctrl', 'shift'] },
      'focus-search': { key: 'f', modifiers: ['ctrl'] }
    });
  }

  // Register IPC handlers for shortcuts
  ipcMain.handle('get-shortcuts', () => {
    return store.get('shortcuts');
  });

  ipcMain.on('save-shortcuts', (event, shortcuts) => {
    store.set('shortcuts', shortcuts);
    // Notify all windows about shortcut changes
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('shortcuts-updated', shortcuts);
    });
  });

  createMainWindow();
  createTray();

  // Launch on login by default, so the app behaves like a real always-on
  // sticky notes app instead of something that has to be started from a
  // terminal each time. Only meaningful for an installed/packaged build --
  // in dev mode this would register the dev Electron.exe path, which isn't
  // useful. Uses Electron's built-in login-item API (HKCU Run key on
  // Windows), not the unused `electron-auto-launch` dependency: that
  // library's Windows implementation targets HKLM on x64, which a normal
  // per-user, non-admin install cannot write to.
  if (app.isPackaged) {
    cleanStartup(); // remove any stale/old autostart entries first
    const loginSettings = app.getLoginItemSettings();
    if (!loginSettings.openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    }
  }

  // Last session restore
  try {
    if (fs.existsSync(sessionFile)) {
      const lastSession = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      if (Array.isArray(lastSession)) {
        lastSession.forEach(notePath => {
          if (fs.existsSync(notePath)) {
            createNoteWindow(notePath, null, false);
          }
        });
      }
    }
  } catch (e) {
    console.error('last-session restore failed:', e);
  }

  // Register a custom protocol to serve local assets securely
  protocol.handle('app-asset', (request) => {
    const assetPath = request.url.replace(/^app-asset:\/\//, '');
    const fullPath = path.join(app.getAppPath(), assetPath);
    console.log('Serving asset:', fullPath);
    return net.fetch(fullPath);
  });

  // ===== Auto-update logic start =====
  // Don't check for updates in development mode
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
      // Notify user about available update (show dialog if needed)
      console.log('Update available. Downloading...');
    });

    autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
      const dialogOpts = {
        type: 'info',
        buttons: ['Restart', 'Later'],
        title: 'Application Update',
        message: process.platform === 'win32' ? releaseNotes : releaseName,
        detail: 'A new version has been downloaded. Restart the application to apply the updates.'
      };

      dialog.showMessageBox(dialogOpts).then((returnValue) => {
        if (returnValue.response === 0) autoUpdater.quitAndInstall();
      });
    });

    autoUpdater.on('error', message => {
      console.error('There was a problem updating the application');
      console.error(message);
    });

    // (Optional) Show download progress
    autoUpdater.on('download-progress', (progressObj) => {
      let log_message = "Download speed: " + progressObj.bytesPerSecond;
      log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
      log_message = log_message + ' (' + progressObj.transferred + '/' + progressObj.total + ')';
      console.log(log_message);
    });
  }
  // ===== Auto-update logic end =====
});

app.on('before-quit', writeSessionNow);

// Without this listener, Electron quits the whole app the moment the last
// window (Memo List or a note) is closed. Registering it -- without ever
// calling app.quit() inside it -- keeps the process alive in the tray so
// Shivam can reopen the Memo List instead of losing the app entirely.
// Deliberate real quit still works via the tray's "Quit" item, which calls
// app.quit() directly.
app.on('window-all-closed', () => {});

// Settings window creation function
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    hasShadow: true,
    show: false, // Start hidden
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  settingsWindow.loadFile('src/renderer/settings/settings.html');

  // Set initial theme and show window when ready
  settingsWindow.webContents.once('did-finish-load', () => {
    if (store) {
      settingsWindow.webContents.send('theme-changed', store.get('theme'));
    }
    settingsWindow.show();
    settingsWindow.focus();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}