// main.js
const { app, BrowserWindow, ipcMain, protocol, net, Tray, Menu, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { dialog, nativeTheme } = require('electron');

// The 7-swatch palette real Sticky Notes ships (see common.css --swatch-*
// for the actual hex values). Kept as an allowlist here so a malformed/stale
// IPC call can't ever write an arbitrary string into the state file.
const NOTE_COLORS = ['yellow', 'green', 'blue', 'purple', 'pink', 'gray', 'charcoal'];
const DEFAULT_NOTE_COLOR = 'yellow';

// Multi-source feature: a note "source" conceptually means "a webpage", not
// "any open window" -- get-windows' openWindows() returns every top-level OS
// window (VS Code, File Explorer, this app's own windows, etc.), so this
// allowlist narrows candidates down to recognized browsers only. Deliberately
// window-level, not tab-level: there is no way to see individual tabs without
// a separate browser-extension project, which is explicitly out of scope --
// the UI says this plainly (see note.js's source popover help text) rather
// than imply more than it delivers.
const BROWSER_EXECUTABLES = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe'];

app.setAppUserModelId('com.hsmin.stickymarkdownnote');

// Single-instance lock. Windows launches every "open" (desktop icon,
// Start Menu, installer's "run after install" checkbox) as a brand new
// process. Without this, each launch attempt spins up its own full second
// copy of the app sharing the same userData folder -- same
// note-window-state.json, same last-session.json -- as any already-running
// instance. That's exactly the setup that let two live instances race on
// note-window-state.json and wipe real pin/color/ChatGPT-destination
// entries in a prior incident. requestSingleInstanceLock() makes every
// launch attempt after the first fail to acquire the lock; that failing
// attempt quits immediately below, before creating any windows or
// registering any of the handlers further down this file. The lock-holding
// (first) instance gets a 'second-instance' event instead and brings itself
// to the foreground -- the standard "clicking the icon again just focuses
// what's already running" behavior.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance already holds the lock -- quit immediately. The
  // app.on('ready', ...) handler below still guards on
  // gotSingleInstanceLock too, so even in the brief window before quit()
  // takes effect this process never creates a window or registers a
  // duplicate set of ipcMain handlers.
  app.quit();
}

app.on('second-instance', () => {
  showMemoList();
});

const openNoteWindows = {}; // { fullPath: BrowserWindow }

const stateFilePath = path.join(app.getPath('userData'), 'note-window-state.json');

// Notes are saved as plain .md files in their own dedicated folder, not
// Electron's default userData folder and not the vault -- kept independent
// so this app stays simple and an AI agent can read notes here directly
// instead of the vault modeling sticky-note capture.
// STICKY_NOTES_DIR is a test-only escape hatch (isolated automated test runs
// need a throwaway notes folder instead of the real one below) -- unset in
// every normal launch, so production behavior is unchanged.
const notesDir = process.env.STICKY_NOTES_DIR || 'C:\\Users\\shiva\\Sticky Notes';
if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });

// Recently Deleted / trash: a subfolder of notesDir, not userData -- trashed
// notes are still real .md files, just moved out of the "visible" folder, so
// they stay alongside the notes they came from (same drive/volume, which
// also keeps the delete-time rename atomic -- see delete-note below) and are
// still directly readable by an agent/human poking at the filesystem.
const trashDir = path.join(notesDir, '.trash');
if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });

// Retention window for the trash: 48 hours. Picked over a shorter window
// (e.g. 24h) so a note deleted Friday evening is still recoverable Monday
// morning -- the whole point of a "Recently Deleted" view over the old
// 6-second in-memory cache is surviving exactly that kind of gap. Picked
// over a much longer window (e.g. 7-30 days) because this is a single-user
// sticky-notes app with no manual "empty trash" UI -- an unbounded or
// long-lived trash would just quietly accumulate every deleted note's file
// forever. 48h is long enough to catch "oh wait, I needed that" the next
// time the app is used, without becoming a second permanent notes folder.
const TRASH_RETENTION_MS = 48 * 60 * 60 * 1000;

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

// get-windows (ESM-only, same interop problem electron-store already solved
// above) -- assigned inside app.on('ready', ...) below, before any window is
// created, so every IPC handler that reads this closure variable is
// registered before a renderer can possibly race it.
let openWindows;

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

  // Show on ready-to-show (first frame) with a fallback timer, same reasoning
  // as createNoteWindow: a slow renderer spawn on this machine otherwise left
  // the Memo List hidden for several seconds after launch. showList() is
  // idempotent.
  let listShown = false;
  const showList = () => {
    if (listShown || mainWindow.isDestroyed()) return;
    listShown = true;
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showList);
  setTimeout(showList, 1200);

  // Apply the saved/system theme once the page's DOM + scripts have loaded.
  mainWindow.webContents.once('did-finish-load', () => {
    if (store) {
      mainWindow.webContents.send('theme-changed', store.get('theme'));
    }
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

// Applies pin ("always on top") state to a note window using a real, strong
// z-order level instead of the previous no-level setAlwaysOnTop(bool) call.
// Electron's setAlwaysOnTop(true) with no level argument uses the default
// 'floating' level, which macOS/Windows both still let genuine OS-level
// fullscreen surfaces (a video call, a game, a presentation) draw over --
// defeating the entire point of "pin this note so it's always visible".
// 'screen-saver' is Electron's documented highest window level, used
// specifically for content that must stay visible above fullscreen apps.
//
// setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) is the
// second half of the same fix: without it, a pinned note is tied to whatever
// virtual desktop/Space it was created on and won't follow the user to
// another one. Per Electron's docs this is primarily a macOS/Linux concept
// (Windows has no native "workspaces" API Electron hooks into for this
// method), so it is a documented no-op on Windows rather than something that
// needs an OS guard here -- safe and correct to call unconditionally on every
// platform, including Windows.
function applyPinState(win, pinned) {
  if (!win || win.isDestroyed()) return;
  if (pinned) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  }
}

function createNoteWindow(notePath, position = null, isNew = false) {
  const fullPath = path.resolve(notePath); // Standardize path

  if (!fs.existsSync(fullPath)) {
    console.error('This file does not exist:', fullPath);
    return;
  }

  // If window is already open, reveal it. A session-restored note is
  // registered here but can still be hidden -- its renderer may not have
  // painted yet (see the ready-to-show/fallback show logic below), and a
  // user-minimized note is hidden too. In both cases plain focus() cannot
  // make an invisible window appear, so clicking such a note in the Memo List
  // looked like a dead no-op. show() (+ restore if minimized) guarantees it
  // actually comes to the foreground.
  if (openNoteWindows[fullPath]) {
    const existing = openNoteWindows[fullPath];
    if (!existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
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
    // Pin level/workspace-visibility is applied explicitly via
    // applyPinState right below instead of the boolean alwaysOnTop option
    // here, since the constructor option has no way to request the
    // stronger 'screen-saver' z-order level that fix requires.
    frame: false,
    hasShadow: true,
    show: false, // Start hidden
    // Opt-in only (Item 6, Settings): defaults to false (visible in
    // taskbar, current/original behavior) unless Shivam explicitly turns
    // this on in Settings. Only note windows respect this -- the Memo List
    // window is deliberately never skip-taskbar (see createMainWindow),
    // since it should always stay discoverable there.
    skipTaskbar: store ? !!store.get('skipTaskbarNotes') : false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  applyPinState(win, pinned);

  win.loadFile('src/renderer/note/note.html');

  // Show the window as soon as its first frame is ready (ready-to-show)
  // instead of waiting for did-finish-load. On this machine a note window's
  // renderer can take several seconds to spin up (antivirus scans each
  // freshly-spawned Electron process), and gating show() on the *full* page
  // load left session-restored notes invisible for that entire stretch --
  // the note appeared impossible to open. A fallback timer force-shows the
  // window if ready-to-show is itself slow, so a note can never get stuck
  // hidden. showNote() is idempotent.
  let shown = false;
  const showNote = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    win.focus();
  };
  win.once('ready-to-show', showNote);
  setTimeout(showNote, 1200);

  // Apply the saved/system theme once the page's DOM + scripts have loaded.
  win.webContents.once('did-finish-load', () => {
    if (store) { // Ensure 'store' is initialized before accessing it
      win.webContents.send('theme-changed', store.get('theme'));
    } else {
      console.warn("Store not initialized when setting initial theme for note window.");
    }
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

  // Per-note color, same cached-on-window-instance pattern as chatgptTagged
  // above. Every note (new or pre-existing, tagged or not) gets a real
  // color rather than staying colorless -- defaults to yellow, matching
  // real Sticky Notes' own default.
  win.noteColor = NOTE_COLORS.includes(savedBounds?.color) ? savedBounds.color : DEFAULT_NOTE_COLOR;

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

// Shared by createNewNote and the "Duplicate" more-menu action (Item 4) --
// both need a fresh, collision-free filename in notesDir following the same
// naming convention (note-<ISO-timestamp-with-colons/dots-as-dashes>.md).
function generateNewNoteFilePath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `note-${timestamp}.md`;
  return path.join(notesDir, fileName);
}

function createNewNote(position = null) {
  const filePath = generateNewNoteFilePath();

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

// Atomic write for note-window-state.json. Every write site below used to
// write straight to stateFilePath -- fs.writeFileSync() to an existing path
// truncates it first, then streams the new content in. If the process dies
// between the truncate and the final byte (crash, kill, power loss, or a
// second process fighting over the same file -- exactly what happened here
// once already, wiping several of Shivam's real pin/color/ChatGPT-
// destination entries), the file is left as an unrecoverable partial blob
// instead of either the old or the new content.
//
// The fix is the standard atomic-write pattern: write the full new content
// to a throwaway temp file in the SAME directory as stateFilePath (same
// directory matters -- fs.renameSync is only atomic when source and
// destination share a filesystem/volume), then fs.renameSync it over the
// real path. rename() is atomic at the OS level, so any reader always sees
// either the complete old file or the complete new one, never a partial
// write -- a crash after the temp file is written but before the rename
// just leaves an orphaned temp file, never a corrupted real one. The temp
// name includes this process's pid so two note-window-state writers (e.g.
// this app plus some future second writer) can never collide on the same
// temp path.
function writeStateFileAtomic(data) {
  const tmpPath = path.join(
    path.dirname(stateFilePath),
    `.note-window-state.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, stateFilePath);
}

// Centralized, BOM-tolerant read for note-window-state.json. Every call site
// below used to do its own `JSON.parse(fs.readFileSync(stateFilePath,
// 'utf-8'))` with a bare try/catch that fell back to `{}` on ANY parse
// failure -- including a leading UTF-8 BOM (e.g. from the file once being
// opened/saved in Notepad, which adds one by default), which this Node/V8
// version's JSON.parse does NOT strip automatically. That fallback-to-`{}`
// is exactly the corruption path this whole hardening pass exists to close:
// a BOM'd-but-otherwise-perfectly-valid file was silently treated as empty,
// so the very next save wrote back a file containing ONLY that one update,
// discarding every other note's pin/color/ChatGPT-destination entry --
// confirmed live while testing this fix. Stripping a leading U+FEFF before
// parsing (and normalizing to always return an object, never null/undefined)
// makes every one of the read sites below immune to this, regardless of how
// the BOM got there in the first place.
function readStateFile() {
  if (!fs.existsSync(stateFilePath)) return {};
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf-8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    console.error('note-window-state.json failed to parse -- treating as empty rather than overwriting:', e);
    return {};
  }
}

function loadWindowState(notePath) {
  const fullPath = path.resolve(notePath);
  const data = readStateFile();
  return data[fullPath] || null;
}

// Merges `updates` (bounds and/or pinned) into the existing record for this
// note instead of overwriting it, so saving new bounds doesn't wipe out a
// previously saved pin state (and vice versa) -- they're written by
// different event handlers at different times.
function saveWindowState(notePath, updates) {
  const fullPath = path.resolve(notePath);
  const data = readStateFile();
  data[fullPath] = { ...(data[fullPath] || {}), ...updates };
  writeStateFileAtomic(data);
}

// Destinations are stored as their own nested object (`destinations: {
// chatgpt: true }`) rather than a top-level boolean, so this merges one key
// into that object instead of replacing it wholesale -- keeps room to add a
// second destination later (e.g. `destinations.somewhereElse`) without ever
// touching this shape again, and keeps routing state fully independent of
// `pinned`, which saveWindowState above already owns.
function saveDestinationState(notePath, destKey, value) {
  const fullPath = path.resolve(notePath);
  const data = readStateFile();
  const existing = data[fullPath] || {};
  const destinations = { ...(existing.destinations || {}), [destKey]: value };
  data[fullPath] = { ...existing, destinations };
  writeStateFileAtomic(data);
}

// Per-note "sources" (multi-source feature): a note can be tagged with one
// or more currently-open BROWSER windows as its source. No window handle/HWND
// is stored -- those aren't stable across restarts -- only the title/owner
// identity plus when it was attached (capturedAt), which also doubles as the
// per-source removal key. Same readStateFile/writeStateFileAtomic
// merge-not-overwrite pattern as saveWindowState/saveDestinationState above;
// both return the FULL resulting sources array so the renderer can re-render
// its chip row/checkbox state directly off the response, no extra round trip.
function addNoteSourceState(notePath, source) {
  const fullPath = path.resolve(notePath);
  const data = readStateFile();
  const existing = data[fullPath] || {};
  const sources = Array.isArray(existing.sources) ? [...existing.sources] : [];

  const isDuplicate = sources.some(
    s => s.ownerPath === source.ownerPath && s.title === source.title
  );
  if (!isDuplicate) {
    sources.push({
      title: source.title,
      ownerName: source.ownerName || '',
      ownerPath: source.ownerPath,
      capturedAt: Date.now(),
    });
    data[fullPath] = { ...existing, sources };
    writeStateFileAtomic(data);
  }
  return sources;
}

function removeNoteSourceState(notePath, capturedAt) {
  const fullPath = path.resolve(notePath);
  const data = readStateFile();
  const existing = data[fullPath] || {};
  const sources = (Array.isArray(existing.sources) ? existing.sources : [])
    .filter(s => s.capturedAt !== capturedAt);
  data[fullPath] = { ...existing, sources };
  writeStateFileAtomic(data);
  return sources;
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

// Delete + Undo + Recently Deleted (real soft-delete). An empty note
// (confirmed by reading the actual file content -- trimmed, not a UI flag)
// still deletes for real, with zero friction, exactly like before: nothing
// worth restoring, so no trash entry, no toast.
//
// A note with real content is soft-deleted instead: the file is MOVED (a
// real fs.rename, not copy-then-unlink) from notesDir into notesDir/.trash,
// and its state-file entry (pin/color/chatgpt destination) moves out of the
// top-level per-path map into a `_trash` bucket, keyed by basename, tagged
// with a `trashedAt` timestamp. This replaces the old approach (delete the
// real file immediately, keep its content in an in-memory Map for ~6s so
// the toast's Undo had something to restore from) -- that cache was lost on
// an app restart and expired for good after 6 seconds, so a note was only
// ever a few seconds and one crash away from being gone forever. Moving the
// file into an on-disk trash folder instead means restoring it later is just
// moving it back, and it survives a restart -- see purgeOldTrash below for
// the 48h retention window that eventually cleans it up for real.
//
// The note's ChatGPT mirror is deleted immediately either way, unconditional
// on hadMirror (deleteChatgptMirror already no-ops silently on ENOENT) --
// a trashed note has no reason to stay visible to ChatGPT. Whether it HAD a
// mirror is recorded in the trash entry so restoreFromTrash can re-create it.
ipcMain.handle('delete-note', async (event, noteFile) => {
  const fullPath = path.resolve(path.join(notesDir, noteFile));

  let content;
  try {
    content = await fs.promises.readFile(fullPath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: 'not found' };
    console.error('Failed to read note before delete:', e);
    return { ok: false, error: String(e) };
  }
  const isEmpty = content.trim().length === 0;

  // Close the window (if open) BEFORE wiping its state entry. win.close()
  // synchronously fires the 'close' listener, which calls saveWindowState
  // and would otherwise re-write a fresh bounds-only record for fullPath
  // right after we deleted it, leaving a stale orphaned entry behind for
  // every deleted note. Doing this first also means that stray bounds-only
  // write lands (merged into the existing entry, harmlessly) BEFORE the
  // snapshot-then-delete below, so the snapshot still captures the real
  // pinned/color/destinations values, not a stripped-down stub.
  if (openNoteWindows[fullPath]) {
    openNoteWindows[fullPath].close(); // Automatically cleaned up in 'closed' event
  }

  // Mirror presence is checked against the actual file on disk -- the
  // ground truth -- rather than any cached tag flag, since the note's
  // window (and its win.chatgptTagged) may not even be open right now.
  let hadMirror = false;
  try {
    await fs.promises.access(chatgptMirrorPathFor(fullPath));
    hadMirror = true;
  } catch {
    hadMirror = false;
  }
  await deleteChatgptMirror(fullPath);

  const stateData = readStateFile();
  const stateEntry = stateData[fullPath] || null;
  delete stateData[fullPath];

  if (isEmpty) {
    // Nothing worth restoring -- real, permanent delete, no trash entry, no
    // toast, matches the "empty notes deletion should be automatic" behavior
    // exactly as before.
    writeStateFileAtomic(stateData);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('refresh-list');
    }
    return { ok: true, isEmpty: true };
  }

  const basename = path.basename(fullPath);
  const trashPath = path.join(trashDir, basename);
  try {
    await fs.promises.rename(fullPath, trashPath);
  } catch (e) {
    console.error('Failed to move note to trash:', e);
    return { ok: false, error: String(e) };
  }

  stateData._trash = stateData._trash || {};
  stateData._trash[basename] = {
    originalPath: fullPath,
    trashedAt: Date.now(),
    stateEntry,
    hadMirror,
  };
  writeStateFileAtomic(stateData);

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }

  return { ok: true, isEmpty: false };
});

// Shared by BOTH the fast 5-second toast Undo AND the Recently Deleted
// view's per-item Restore button -- from the trash's point of view they're
// the same operation (move a note back out of .trash, restore its state,
// recreate its mirror if it had one), just triggered from two different UI
// entry points. `noteFile` is the trashed file's basename: exactly the same
// string delete-note above received and used as the `_trash` bucket's key.
async function restoreFromTrash(noteFile) {
  const basename = path.basename(noteFile);
  const data = readStateFile();
  const trashEntry = data._trash && data._trash[basename];
  if (!trashEntry) {
    // Expired past the retention window and already purged, already
    // restored once, or never existed -- either way, nothing to undo.
    return { ok: false, error: 'not in trash' };
  }

  const trashPath = path.join(trashDir, basename);
  const destPath = trashEntry.originalPath || path.join(notesDir, basename);

  let content;
  try {
    await fs.promises.rename(trashPath, destPath);
    content = await fs.promises.readFile(destPath, 'utf-8');
  } catch (e) {
    console.error('Restore from trash failed:', e);
    return { ok: false, error: String(e) };
  }

  if (trashEntry.stateEntry) {
    data[destPath] = trashEntry.stateEntry;
  }
  delete data._trash[basename];
  writeStateFileAtomic(data);

  if (trashEntry.hadMirror) {
    await writeChatgptMirror(destPath, content);
  }

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }

  return { ok: true };
}

ipcMain.handle('undo-delete-note', (event, noteFile) => restoreFromTrash(noteFile));

// Bulk read for the Recently Deleted view -- same readStateFile source of
// truth as get-note-meta/get-note-colors below, just reading the `_trash`
// bucket instead of the top-level per-path entries.
ipcMain.handle('get-trash-notes', () => {
  const data = readStateFile();
  const trash = data._trash || {};
  return Object.entries(trash).map(([basename, entry]) => {
    const se = entry.stateEntry || {};
    return {
      file: basename,
      fullPath: path.join(trashDir, basename),
      trashedAt: entry.trashedAt,
      color: NOTE_COLORS.includes(se.color) ? se.color : DEFAULT_NOTE_COLOR,
      pinned: se.pinned !== undefined ? !!se.pinned : true,
      chatgpt: !!(se.destinations && se.destinations.chatgpt),
    };
  });
});

// Permanently purges any trash entry older than TRASH_RETENTION_MS -- run
// once at startup (app.on('ready') below) and on a periodic interval while
// the app stays running, so "empty the trash" is never a manual chore. Not
// gated on the Memo List or Recently Deleted view being open.
async function purgeOldTrash() {
  const data = readStateFile();
  const trash = data._trash || {};
  const now = Date.now();
  let changed = false;

  for (const [basename, entry] of Object.entries(trash)) {
    if (!entry || typeof entry.trashedAt !== 'number') continue;
    if (now - entry.trashedAt <= TRASH_RETENTION_MS) continue;

    try {
      await fs.promises.unlink(path.join(trashDir, basename));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Trash purge failed to delete file:', e);
    }
    delete trash[basename];
    changed = true;
  }

  if (changed) {
    data._trash = trash;
    writeStateFileAtomic(data);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('refresh-list');
    }
  }
}

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
  applyPinState(win, newState);

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

// Per-note color swatch -- same fromWebContents + saveWindowState pattern as
// toggle-pin. Unlike toggle-pin/toggle-chatgpt-destination (both booleans
// that just flip), this sets one of 7 explicit values, so the handler name
// and shape differ (set-note-color, not toggle-note-color) but the
// persistence mechanism is identical.
ipcMain.handle('set-note-color', (event, color) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath) return win?.noteColor || DEFAULT_NOTE_COLOR;
  if (!NOTE_COLORS.includes(color)) return win.noteColor || DEFAULT_NOTE_COLOR;

  win.noteColor = color;
  saveWindowState(win.notePath, { color });

  // The list window shows a color dot per note (read from disk, not from
  // this window's in-memory state), so it needs a nudge to pick up the change.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }

  return color;
});

ipcMain.handle('get-note-color', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return DEFAULT_NOTE_COLOR;
  return win.noteColor || DEFAULT_NOTE_COLOR;
});

// Bulk color lookup for the list window, which needs every note's color
// (not just one window's) to render its per-row dot -- reads the state file
// directly rather than going through any open BrowserWindow, since most
// listed notes have no open window at all.
ipcMain.handle('get-note-colors', () => {
  const data = readStateFile();
  const colors = {};
  for (const [fullPath, entry] of Object.entries(data)) {
    if (fullPath === '_trash') continue; // reserved bucket, not a note entry
    if (entry && NOTE_COLORS.includes(entry.color)) {
      colors[fullPath] = entry.color;
    }
  }
  return colors;
});

// Bulk metadata lookup for the Memo List's filter chips (Pinned / Sent to
// ChatGPT / per-color) -- same readStateFile source of truth as
// get-note-colors above (deliberately not a second read path: the list
// window calls this ONCE per render instead of get-note-colors, getting
// color plus pinned/chatgpt in the same pass). Defaults mirror the ones
// createNoteWindow itself applies when a note has no state entry yet: color
// defaults to yellow, pinned defaults to true (this app's pin-by-default
// behavior), chatgpt defaults to false (opt-out default only applies to
// brand-new notes at creation time, which isn't knowable from here).
ipcMain.handle('get-note-meta', () => {
  const data = readStateFile();
  const meta = {};
  for (const [fullPath, entry] of Object.entries(data)) {
    if (fullPath === '_trash') continue; // reserved bucket, not a note entry
    if (!entry || typeof entry !== 'object') continue;
    meta[fullPath] = {
      color: NOTE_COLORS.includes(entry.color) ? entry.color : DEFAULT_NOTE_COLOR,
      pinned: entry.pinned !== undefined ? !!entry.pinned : true,
      chatgpt: !!(entry.destinations && entry.destinations.chatgpt),
      // Item 9: source badge/count on each list row. Only the COUNT crosses
      // to the list window (not the full source objects) -- the badge just
      // needs "how many", so this stays the single bulk read the list render
      // already makes rather than adding a second get-note-sources call.
      sources: Array.isArray(entry.sources) ? entry.sources.length : 0,
    };
  }
  return meta;
});

// ===== Multi-source feature =====
//
// "Source" candidates are currently-open BROWSER windows (window-level, not
// tab-level -- see BROWSER_EXECUTABLES's comment above). Own-app windows are
// excluded by comparing owner.path against process.execPath, same identity
// check used to recognize "is this a Sticky Markdown Note window" without
// needing a separate allowlist for it.
function isOwnAppWindow(ownerPath) {
  if (!ownerPath) return false;
  try {
    return path.resolve(ownerPath) === path.resolve(process.execPath);
  } catch {
    return false;
  }
}

function isRecognizedBrowser(owner) {
  const base = owner?.path ? path.basename(owner.path).toLowerCase() : '';
  if (BROWSER_EXECUTABLES.includes(base)) return true;
  // Fallback for the rare case a window's path can't be resolved but its
  // process display name still identifies a known browser.
  const name = (owner?.name || '').toLowerCase();
  return ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'].some(n => name.includes(n));
}

async function listRecognizedBrowserWindows() {
  if (!openWindows) return [];
  let windows;
  try {
    windows = await openWindows();
  } catch (e) {
    console.error('get-windows openWindows() failed:', e);
    return [];
  }
  return windows.filter(
    w => w.title && !isOwnAppWindow(w.owner?.path) && isRecognizedBrowser(w.owner)
  );
}

// app.getFileIcon results are cached per exe path (in-memory, cleared on
// restart) -- multiple open windows from the same browser, and repeated
// popover opens, would otherwise re-fetch the identical icon over and over.
const fileIconCache = new Map();
async function getFileIconDataUrl(ownerPath) {
  if (!ownerPath) return null;
  if (fileIconCache.has(ownerPath)) return fileIconCache.get(ownerPath);
  try {
    const icon = await app.getFileIcon(ownerPath, { size: 'small' });
    const dataUrl = icon.toDataURL();
    fileIconCache.set(ownerPath, dataUrl);
    return dataUrl;
  } catch (e) {
    console.error('app.getFileIcon failed for', ownerPath, e);
    return null;
  }
}

// Window enumeration for the note window's source popover (Item 2/5). Only
// ever returns recognized browsers, per the "a source means a webpage, not
// any window" reasoning above.
ipcMain.handle('get-open-windows', async () => {
  const windows = await listRecognizedBrowserWindows();
  const results = [];
  for (const w of windows) {
    results.push({
      title: w.title,
      ownerName: w.owner?.name || '',
      ownerPath: w.owner?.path || '',
      iconDataUrl: await getFileIconDataUrl(w.owner?.path),
    });
  }
  return results;
});

// The on-disk shape (addNoteSourceState/removeNoteSourceState) intentionally
// stores only { title, ownerName, ownerPath, capturedAt } per source -- no
// icon, per the design brief's exact field list. Icons are re-derived here,
// on the way OUT to a note window's own chip row/popover, from the same
// cached app.getFileIcon lookup 'get-open-windows' already uses, rather than
// bloating the state file with base64 icon data that could also go stale if
// a browser's own icon ever changes.
async function enrichSourcesWithIcons(sources) {
  return Promise.all(sources.map(async s => ({
    ...s,
    iconDataUrl: await getFileIconDataUrl(s.ownerPath),
  })));
}

ipcMain.handle('add-note-source', async (event, source) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath) return { ok: false };
  if (!source || typeof source.title !== 'string' || typeof source.ownerPath !== 'string') {
    return { ok: false };
  }

  const sources = addNoteSourceState(win.notePath, {
    title: source.title,
    ownerName: typeof source.ownerName === 'string' ? source.ownerName : '',
    ownerPath: source.ownerPath,
  });

  // The list window shows a source badge + count per note (read from disk,
  // not from any window's in-memory state), same refresh-list nudge
  // set-note-color already sends for the same reason.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }

  return { ok: true, sources: await enrichSourcesWithIcons(sources) };
});

ipcMain.handle('remove-note-source', async (event, capturedAt) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath) return { ok: false };

  const sources = removeNoteSourceState(win.notePath, capturedAt);

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }

  return { ok: true, sources: await enrichSourcesWithIcons(sources) };
});

// Per-window read (Item 5's note-open state and the popover's checkbox
// state) -- same BrowserWindow.fromWebContents + direct-state-file-read
// pattern as get-note-color/get-destinations, rather than trusting a path
// argument from the renderer.
ipcMain.handle('get-note-sources-for-window', async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath) return [];
  const data = readStateFile();
  const entry = data[path.resolve(win.notePath)];
  const sources = Array.isArray(entry?.sources) ? entry.sources : [];
  return enrichSourcesWithIcons(sources);
});

// Bulk source lookup for the list window (Item 9) -- same shape/reasoning as
// get-note-colors immediately above: reads the state file directly since
// most listed notes have no open window at all.
ipcMain.handle('get-note-sources', () => {
  const data = readStateFile();
  const sourcesByPath = {};
  for (const [fullPath, entry] of Object.entries(data)) {
    if (entry && Array.isArray(entry.sources) && entry.sources.length > 0) {
      sourcesByPath[fullPath] = entry.sources;
    }
  }
  return sourcesByPath;
});

// Jump-to-source (Item 7). There is no Electron API to bring an arbitrary
// FOREIGN window to the foreground -- BrowserWindow.focus() only works on
// this app's own windows. Researched the current best approach for this on
// Windows: a raw user32.dll SetForegroundWindow P/Invoke is the "obvious"
// answer, but Windows' focus-stealing-prevention heuristic frequently just
// silently ignores that call for a background process with no recent input.
// WScript.Shell's AppActivate (invoked here via a one-off PowerShell call,
// no native module/node-gyp build needed) is what real-world Windows tools
// actually rely on for this instead: it's treated like a user-driven Alt+Tab
// by the shell, not a raw window-message call, so it reliably brings the
// target window forward where SetForegroundWindow often doesn't. Matched by
// process id (not HWND, which isn't stable/storable across restarts anyway,
// and not window title text, which AppActivate treats as a substring match
// against EVERY top-level window and can pick the wrong one) -- bringing
// forward "the browser process's window" is exactly the window-level (not
// tab-level) granularity this whole feature already promises.
function focusWindowByProcessId(pid) {
  return new Promise(resolve => {
    let settled = false;
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ws = New-Object -ComObject WScript.Shell; Write-Output $ws.AppActivate(${Number(pid)})`,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      console.error('focusWindowByProcessId spawn failed:', err);
      resolve(false);
      return;
    }

    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.once('error', err => {
      if (settled) return;
      settled = true;
      console.error('focusWindowByProcessId powershell error:', err);
      resolve(false);
    });
    child.once('close', () => {
      if (settled) return;
      settled = true;
      resolve(out.trim().toLowerCase() === 'true');
    });
  });
}

ipcMain.handle('focus-source-window', async (event, source) => {
  if (!source || typeof source.title !== 'string' || typeof source.ownerPath !== 'string') {
    return { ok: false };
  }

  const windows = await listRecognizedBrowserWindows();
  const match = windows.find(w => w.owner?.path === source.ownerPath && w.title === source.title);
  if (!match) return { ok: false, stale: true };

  const focused = await focusWindowByProcessId(match.owner.processId);
  return { ok: focused, stale: false };
});

// Screenshot capture (v2 rework): launches Windows' own native region-select
// snip overlay (the Win+Shift+S experience) instead of the old in-app
// desktopCapturer picker. Researched both candidate mechanisms before
// picking one -- see notes below, this isn't the historically-assumed
// default:
//
// - `shell.openExternal('ms-screenclip:')`, the URI historically documented
//   for this, is NOT reliable here. Microsoft replaced the legacy
//   `ms-screenclip:` scheme on 2025-05-01 with a structured protocol
//   (learn.microsoft.com/windows/apps/develop/launch/launch-snipping-tool)
//   that (a) requires a mode parameter (rectangle/freeform/window) on the
//   capture/image path -- a bare `ms-screenclip:` with no path is no longer
//   a valid request -- and (b) requires a `redirect-uri`, whose response
//   delivery is explicitly gated on the caller being a packaged MSIX app:
//   "Unpackaged (Win32) callers cannot receive responses via redirect-uri.
//   If an unpackaged app provides a redirect-uri, Snipping Tool will not
//   deliver the response and may exit without showing the capture UI." This
//   Electron app is unpackaged (NSIS installer, not MSIX), so it can't use
//   the supported path at all, and real-world reports (see "You'll need a
//   new app to open this ms-screenclip link") confirm the old bare-URI
//   shortcut is now unreliable in practice too.
// - `SnippingTool.exe /clip` (undocumented but long-standing) launches
//   straight into rectangle-select capture mode via a plain process launch,
//   not protocol activation -- no app identity/MSIX requirement, because
//   there's no redirect-uri round-trip involved at all. The legacy stub
//   still lives in System32 and forwards to the modern Snip & Sketch capture
//   UI. This is what's actually shipped as the primary mechanism, with the
//   URI scheme kept as a fallback only for the (unlikely) case Windows drops
//   the legacy stub entirely.
//
// Either way, there is no "snip completed" event to subscribe to -- the OS
// copies the captured region to the clipboard when the user finishes
// selecting, full stop. Detecting that is the renderer's job (note.js polls
// clipboard.readImage()); this handler only has to get the overlay open.
ipcMain.handle('trigger-native-snip', () => {
  return new Promise(resolve => {
    let settled = false;
    let child;
    try {
      // Deliberately NOT shell:true: with a shell wrapping the call, the
      // 'spawn' event below would fire as soon as cmd.exe itself starts
      // (which always succeeds), masking a missing/renamed SnippingTool.exe
      // instead of surfacing it as an 'error' event. Without a shell,
      // Windows' CreateProcess still resolves a bare executable name via
      // System32/PATH on its own, so this doesn't need a hardcoded path.
      child = spawn('SnippingTool.exe', ['/clip'], { stdio: 'ignore' });
    } catch (err) {
      resolve(fallbackToScreenClipUri(err));
      return;
    }

    child.once('error', err => {
      if (settled) return;
      settled = true;
      resolve(fallbackToScreenClipUri(err));
    });

    // Node's ChildProcess emits 'spawn' once the OS has actually started the
    // process (Node 15+) -- a real success signal, not a guess/timeout.
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ ok: true, method: 'snippingtool-clip' });
    });
  });
});

function fallbackToScreenClipUri(primaryErr) {
  console.error('SnippingTool.exe /clip failed, falling back to ms-screenclip: URI:', primaryErr);
  try {
    // Best-effort only -- see the block comment above for why this is not
    // expected to reliably show the capture UI from an unpackaged app.
    shell.openExternal('ms-screenclip:');
    return { ok: true, method: 'ms-screenclip-fallback', warning: String(primaryErr && primaryErr.message || primaryErr) };
  } catch (fallbackErr) {
    return { ok: false, error: String(fallbackErr && fallbackErr.message || fallbackErr) };
  }
}

// "Export as PDF" -- printToPDF and the save dialog are both main-process-
// only APIs (webContents.printToPDF, dialog.showSaveDialog), so this has to
// be an invoke handler rather than something the renderer can do directly
// the way it does clipboard.writeText for "Copy Note". note.css's @media
// print rules hide the titlebar/toolbar/editor so the PDF captures only the
// rendered preview, not the raw chrome of the note window.
ipcMain.handle('export-note-pdf', async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };

  const defaultName = win.notePath
    ? `${path.basename(win.notePath, '.md')}.pdf`
    : 'note.pdf';

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export as PDF',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    const pdfBuffer = await win.webContents.printToPDF({});
    await fs.promises.writeFile(filePath, pdfBuffer);
    return { ok: true, filePath };
  } catch (e) {
    console.error('Export PDF failed:', e);
    return { ok: false, error: String(e) };
  }
});

// "Duplicate" more-menu action (Item 4). `content` is the renderer's current
// (possibly still-debouncing) editor text -- same reason toggle-chatgpt-
// destination and export-note-pdf take the live value rather than trusting
// whatever was last flushed to disk. The copy is opened via the normal
// createNoteWindow(..., isNew = true) path, which is deliberate: a genuinely
// new file with no existing note-window-state.json entry means it picks up
// the SAME defaults a brand-new note gets (pinned=true, color=yellow,
// chatgpt-tagged=true) rather than inheriting the original's pin/color/
// destination flags. A duplicate is a new note that happens to start with
// the same text, not a linked clone of the original's settings.
ipcMain.handle('duplicate-note', async (event, content) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.notePath) return { ok: false, error: 'no window' };

  const filePath = generateNewNoteFilePath();
  const normalized = content ?? '';

  try {
    await fs.promises.writeFile(filePath, normalized, 'utf-8');
  } catch (e) {
    console.error('Duplicate note failed:', e);
    return { ok: false, error: String(e) };
  }

  // New notes default to ChatGPT-tagged (see createNoteWindow) -- mirror the
  // duplicate's content immediately, same as createNewNote does for a blank
  // brand-new note, so the mirror exists from the moment the window does.
  writeChatgptMirror(filePath, normalized).catch(() => {});

  createNoteWindow(filePath, null, /* isNew */ true);

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('refresh-list');
  }

  return { ok: true, filePath };
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
  // Second instance already told to quit above -- never create a window or
  // register a second copy of every handler below.
  if (!gotSingleInstanceLock) return;

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

  // get-windows is ESM-only, identical interop problem/fix as electron-store
  // directly above -- deferred here so 'get-open-windows'/'focus-source-
  // window' (registered at module scope, further down this file) are already
  // registered before any window exists to race them; openWindows is simply
  // unset until this line runs.
  //
  // CRITICAL: this MUST be non-fatal. It is an optional feature (the note
  // "source" popover), but it runs before createMainWindow() and the session
  // restore below -- so if the import throws (e.g. its native binding can't
  // be resolved out of the asar in a packaged build), an un-caught rejection
  // here aborts the entire ready handler and NO window ever opens, making the
  // whole app look dead. Swallowing it leaves openWindows undefined, which
  // listRecognizedBrowserWindows() already treats as "no sources available".
  try {
    ({ openWindows } = await import('get-windows'));
  } catch (e) {
    console.error('get-windows failed to load; note "source" feature disabled for this session:', e);
    openWindows = null;
  }

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

  // "Hide from taskbar" setting (Item 6). Defaults to false/OFF -- the
  // current, original behavior (note windows visible in the taskbar) --
  // since some users rely on taskbar previews to find a specific note. This
  // only ever applies to note windows, never the Memo List window (see
  // createMainWindow, which never reads this setting), so the Memo List
  // stays discoverable regardless. Persisted through the same electron-store
  // instance every other setting (theme, shortcuts) already uses.
  if (store.get('skipTaskbarNotes') === undefined) {
    store.set('skipTaskbarNotes', false);
  }

  ipcMain.handle('get-skip-taskbar-notes', () => {
    return !!store.get('skipTaskbarNotes');
  });

  ipcMain.on('set-skip-taskbar-notes', (event, value) => {
    const newValue = !!value;
    store.set('skipTaskbarNotes', newValue);

    // Applies immediately to every already-open note window -- not just
    // future ones -- without touching mainWindow/settingsWindow, which are
    // never in this map.
    Object.values(openNoteWindows).forEach(win => {
      if (win && !win.isDestroyed()) {
        win.setSkipTaskbar(newValue);
      }
    });
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

  // Recently Deleted retention enforcement: once now at startup (catches
  // whatever aged past 48h while the app was closed) and again on a
  // periodic interval so it's also enforced across a long-running session
  // without ever requiring a manual "empty trash" action.
  purgeOldTrash().catch(e => console.error('Startup trash purge failed:', e));
  setInterval(() => {
    purgeOldTrash().catch(e => console.error('Periodic trash purge failed:', e));
  }, 6 * 60 * 60 * 1000); // every 6h

  // Global "new note" hotkey -- registered once here at startup (not
  // per-window) and unregistered in the 'will-quit' handler below, per
  // Electron's own globalShortcut docs: a shortcut registered with
  // globalShortcut.register keeps working system-wide, even while the app
  // has no focused window, until it's explicitly unregistered -- it does
  // NOT auto-clear on its own, so skipping the will-quit unregister would
  // leave Ctrl+Alt+N dead-bound to this app (or erroring) after quit until
  // next reboot. Ctrl+Alt+N: chosen to avoid the common collisions Ctrl+N
  // (new-note-in-app shortcuts almost everywhere) and Ctrl+Shift+N
  // (new incognito window in every Chromium browser) would both hit.
  const NEW_NOTE_HOTKEY = 'Control+Alt+N';
  const hotkeyRegistered = globalShortcut.register(NEW_NOTE_HOTKEY, () => {
    createNewNote();
  });
  if (!hotkeyRegistered) {
    console.warn('Failed to register global shortcut', NEW_NOTE_HOTKEY, '-- likely already claimed by another app.');
  }

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

// Unregisters the global "new note" hotkey registered in app.on('ready')
// above. Required -- globalShortcut bindings otherwise persist at the OS
// level past this process's lifetime.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

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