// note.js
const { ipcRenderer, clipboard } = require('electron');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');
const CheckboxManager = require('./checkbox');
const TurndownService = require('turndown');

// katex is heavy (the module itself plus a ~30-file font/CSS payload) and
// most notes never contain math. Lazy-require it only the first time a note
// actually needs it (see hasMathExpression/renderMathInMarkdown below)
// instead of paying that cost on every single note window's startup.
let katex = null;
function getKatex() {
  if (!katex) katex = require('katex');
  return katex;
}

// Same reasoning for the KaTeX stylesheet: it's injected into <head> only
// once a note is found to contain a math expression, instead of note.html
// loading it unconditionally for every note.
let katexCssInjected = false;
function ensureKatexCss() {
  if (katexCssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '../../styles/katex.min.css';
  document.head.appendChild(link);
  katexCssInjected = true;
}

// Theme application function
function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
}

const defaultFontSize = parseInt(process.env.FONT_SIZE_DEFAULT) || 16;
const fontSizeMin = parseInt(process.env.FONT_SIZE_MIN) || 8;
const fontSizeMax = parseInt(process.env.FONT_SIZE_MAX) || 40;

let currentPath = null;
let currentFontSize = defaultFontSize;
let userImagesDir = null; // User image save path
let appRootPath = null; // Variable to store the app root path

// The contenteditable surface and titlebar, and the debounced-save state
// machine around them. Module-scoped (assigned once DOMContentLoaded fires,
// below) rather than local to that closure, because insertImageBuffer/
// captureScreenshot -- which need to read/insert into #preview and trigger a
// save -- are also module-scope functions, not nested inside it.
let preview = null;
let titlebar = null;
let saveTimeout = null;

// "Send to ChatGPT" destination state for the note currently open in this
// window. Declared at module scope (not inside the DOMContentLoaded closure)
// because handleImagePaste, below, also needs to read it and lives outside
// that closure.
let chatgptTagged = false;

let shortcuts = {};

// Load shortcuts
ipcRenderer.invoke('get-shortcuts').then(savedShortcuts => {
    shortcuts = savedShortcuts;
});

// Listen for shortcut updates
ipcRenderer.on('shortcuts-updated', (event, newShortcuts) => {
    shortcuts = newShortcuts;
});

// Listen for theme changes from the main process
ipcRenderer.on('theme-changed', (event, theme) => {
  applyTheme(theme);
});

// Helper function to check if a key combination matches a shortcut
function matchesShortcut(e, shortcut) {
    const isMac = process.platform === 'darwin';
    const modifierKey = isMac ? e.metaKey : e.ctrlKey;

    // Check modifiers
    if (shortcut.modifiers.includes('ctrl') && !modifierKey) return false;
    if (shortcut.modifiers.includes('shift') && !e.shiftKey) return false;
    if (shortcut.modifiers.includes('alt') && !e.altKey) return false;

    // Check key
    return e.key.toLowerCase() === shortcut.key;
}

// Orphaned image management
class OrphanedImageManager {
  constructor() {
    // 1 hour in milliseconds - this condition is no longer used.
  }

  // Check if an image file is in use
  isImageInUse(markdownImagePath) {
    if (!userImagesDir) return false; // Cannot check if userImagesDir is not set

    // Use the base directory where all notes are stored
    const notesRootPath = path.dirname(userImagesDir);
    if (!fs.existsSync(notesRootPath)) return false;

    // Function to recursively find all .md files
    const getAllMarkdownFiles = (dir) => {
      let markdownFiles = [];
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          markdownFiles = markdownFiles.concat(getAllMarkdownFiles(filePath));
        } else if (filePath.endsWith('.md')) {
          markdownFiles.push(filePath);
        }
      }
      return markdownFiles;
    };

    const allNotes = getAllMarkdownFiles(notesRootPath);

    // Normalize path string by removing 'file:///' prefix and unifying backslashes to forward slashes
    // Example: file:///C:/Users/User/AppData/Roaming/Sticky%20Markdown%20Note/notes/images/my%20image%20[1].png
    // -> C:/Users/User/AppData/Roaming/Sticky%20Markdown%20Note/notes/images/my%20image%20[1].png
    const normalizedRawPath = markdownImagePath.replace(/^file:\/\/\/?/, '').replace(/\\/g, '/');

    // Generate all possible markdown link forms to create regex patterns.
    const possiblePathPatterns = [];

    // 1. Original path with spaces (raw path)
    possiblePathPatterns.push(escapeRegExp(normalizedRawPath));

    // 2. Path with spaces encoded as %20
    possiblePathPatterns.push(escapeRegExp(normalizedRawPath.replace(/ /g, '%20')));

    // 3. Path encoded with encodeURI (commonly used)
    // Note: encodeURI does not encode all special characters (e.g., [ ]).
    try {
      possiblePathPatterns.push(escapeRegExp(encodeURI(normalizedRawPath)));
    } catch (e) {
      console.error("Error encoding URI for path:", normalizedRawPath, e);
    }

    // 4. Path encoded with encodePathSpecialChars (additional handling for brackets, etc.)
    possiblePathPatterns.push(escapeRegExp(encodePathSpecialChars(normalizedRawPath)));

    // Add 'file:///' and 'file://' prefixes to each pattern to create final patterns
    const finalRegexPatterns = [];
    for (const pattern of possiblePathPatterns) {
      // file:/// prefix
      finalRegexPatterns.push(`file:\/\/\/?${pattern}`);
      // file:// prefix (for cases where it might sometimes occur)
      finalRegexPatterns.push(`file:\/\/${pattern}`);
    }

    // Combine all patterns with OR (|) to create the final regex
    const fullRegex = new RegExp(
      `(?:${finalRegexPatterns.join('|')})`,
      'gi' // Global and case-insensitive
    );

    for (const notePath of allNotes) {
      try {
        const content = fs.readFileSync(notePath, 'utf-8');
        if (fullRegex.test(content)) {
          return true;
        }
      } catch (err) {
        console.error(`Error reading note file ${notePath}:`, err);
      }
    }
    return false;
  }

  // Clean up orphaned images
  cleanupOrphanedImages() {
    if (!userImagesDir || !fs.existsSync(userImagesDir)) return;

    const images = fs.readdirSync(userImagesDir)
      .filter(file => /\.(png|jpg|jpeg|gif|webp)$/i.test(file));

    for (const image of images) {
      const imagePath = path.join(userImagesDir, image);
      try {
        // Create markdown image link (using file:// protocol and absolute path)
        const absoluteImagePathForMarkdown = `file:///${imagePath.replace(/\\/g, '/')}`;
        if (!this.isImageInUse(absoluteImagePathForMarkdown)) {
          fs.unlinkSync(imagePath);
          console.log(`Deleted orphaned image: ${image}`);
        }
      } catch (err) {
        console.error(`Failed to process image ${image}:`, err);
      }
    }
  }
}

// Orphaned image manager instance
const orphanedImageManager = new OrphanedImageManager();

// Helper function to escape special characters in a regex
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the matched substring
}

// Helper function to encode specific special characters in a URL path
// (encodeURI does not encode some characters, so handle manually)
function encodePathSpecialChars(pathStr) {
  return pathStr
    .replace(/ /g, '%20') // Spaces
    .replace(/\(/g, '%28') // Opening parenthesis
    .replace(/\)/g, '%29') // Closing parenthesis
    .replace(/\[/g, '%5B') // Opening square bracket
    .replace(/\]/g, '%5D') // Closing square bracket
    .replace(/\+/g, '%2B') // Plus sign
    .replace(/\#/g, '%23') // Hash symbol
    .replace(/\?/g, '%3F') // Question mark
    .replace(/\&/g, '%26'); // Ampersand
}

// Function to convert app-asset:/// links to file:// links
async function convertAppAssetLinks(content) {
  if (!content) return content;

  // Find app-asset:/// links and convert them to file:// links
  return content.replace(/!\[([^\]]*)\]\(app-asset:\/\/\/([^)]+)\)/g, (match, alt, assetPath) => {
    // Extract actual file path from app-asset path
    const imagePath = path.join(appRootPath, assetPath);
    // Convert to file:// protocol and absolute path
    const filePath = `file:///${imagePath.replace(/\\/g, '/')}`;
    return `![${alt}](${filePath})`;
  });
}

marked.setOptions({
  breaks: true,
  gfm: true,
});

// Create global renderer instance
const checkboxManager = new CheckboxManager();

// Function to check if markdown contains math expressions
function hasMathExpression(markdown) {
  return /\$(.+?)\$/.test(markdown);
}

// Load-time markdown -> HTML conversion. This now runs exactly ONCE per
// note open (see the 'load-note' handler below), not on every keystroke --
// the single biggest performance change in this rewrite. Typing itself is
// native contenteditable editing with zero parse cost; the only other
// non-trivial work is the debounced save serialization (turndownToMarkdown,
// below), same debounce pattern the old autosave already used.
function renderMathInMarkdown(markdown) {
  // Render checkboxes
  let html = checkboxManager.renderCheckboxes(markdown);

  // Render math expressions only if they exist. Both the katex module and
  // its CSS are lazy-loaded right here, on first actual use, not up front.
  if (hasMathExpression(markdown)) {
    ensureKatexCss();
    const k = getKatex();
    html = html.replace(/\$(.+?)\$/g, (_, expr) => {
      try {
        return k.renderToString(expr, { throwOnError: false });
      } catch (err) {
        return `<code>${expr}</code>`;
      }
    });
  }

  return html;
}

// HTML (the live contenteditable DOM) -> Markdown, for saving. Configured to
// match the plain-markdown conventions this app already produced by hand
// (ATX '#' headings, '-' bullets, fenced ``` code blocks) so a note edited
// only with plain formatting round-trips as clean markdown with no stray
// HTML -- verified live (see worktree test notes): a bold/italic/list/
// checkbox-only note serializes with zero embedded HTML tags.
function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  // GFM task-list items ("- [ ] "/"- [x] ") for the real <input
  // type="checkbox"> elements checkbox.js's marked renderer produces.
  //
  // NOT using turndown-plugin-gfm's own taskListItems rule here: it only
  // fires when the checkbox is a DIRECT child of <li> (node.parentNode.
  // nodeName === 'LI'), but marked wraps list-item content in a <p> for any
  // "loose" list (one with a blank line anywhere between its items, per
  // CommonMark) -- verified live that this is exactly what happens for a
  // real loaded note ("- [ ] first task" / "- [x] done task" followed by a
  // blank-line-separated plain bullet group makes the WHOLE list loose, so
  // marked emits <li><p><input type="checkbox">...</p></li>). With the
  // plugin's strict rule, that checkbox's parent is <p>, not <li>, so the
  // rule silently never matches and the checkbox is serialized as plain,
  // marker-less list text on the very first save -- a real, observed data-
  // loss bug this custom rule exists to close. Matching on the input
  // itself, unconditional on its exact ancestor shape, is also simply
  // correct for this app: a checkbox here always IS a task-list marker,
  // there's no other use of <input type="checkbox"> in this editor.
  service.addRule('taskListItem', {
    filter: node => node.nodeName === 'INPUT' && node.type === 'checkbox',
    // turndown calls replacement(content, node, options) -- content (the
    // checkbox's own, always-empty inner content) is the FIRST argument,
    // not node. Verified live that getting this backwards (a single-param
    // `node =>` arrow, silently receiving `content` instead) makes
    // `node.checked` read `''.checked` (undefined) and every single
    // checkbox -- freshly toggled or loaded already-checked from disk --
    // serialize as unchecked "- [ ] ", regardless of its real state.
    replacement: (content, node) => (node.checked ? '[x]' : '[ ]') + ' ',
  });

  // Underline has no native Markdown syntax. This app has always passed
  // raw <u>...</u> HTML straight through on the way in (marked renders
  // inline HTML as-is; the old surround('<u>','</u>') toolbar button wrote
  // exactly this) -- this rule preserves the same convention on the way
  // back out. Chromium's execCommand('underline') was verified live in this
  // Electron build to emit a plain <u> tag; the inline text-decoration span
  // check is a defensive fallback only, not the observed behavior.
  service.addRule('underline', {
    filter: node => node.nodeName === 'U' ||
      (node.nodeName === 'SPAN' && /text-decoration(-line)?\s*:\s*underline/i.test(node.getAttribute('style') || '')),
    replacement: content => `<u>${content}</u>`,
  });

  // Strikethrough is written from scratch rather than pulling in
  // turndown-plugin-gfm's own strikethrough rule: that rule emits a single
  // tilde ('~text~'), but marked's GFM 'del' extension (this app's
  // renderer) only recognizes the double-tilde CommonMark-GFM form
  // ('~~text~~'). Using the plugin's version would silently lose the
  // strikethrough on the very next reload -- exactly the kind of lossy
  // round-trip this task calls out as the regression to avoid.
  service.addRule('strikethrough', {
    filter: ['s', 'strike', 'del'],
    replacement: content => `~~${content}~~`,
  });

  return service;
}

const turndownService = createTurndownService();

// Serializes the live contenteditable DOM to Markdown. Called only from the
// debounced save path and a few explicit "save now" call sites (image
// insert, checkbox toggle, duplicate/copy/mirror-toggle) -- never per
// keystroke.
function getCurrentMarkdown() {
  return turndownService.turndown(preview);
}

// Saved-pulse indicator: a brief, CSS-only titlebar flash that fires only
// once the debounced autosave's fs.writeFile callback actually confirms the
// write succeeded -- not on every keystroke, and not optimistically before
// the write completes.
function triggerSavePulse() {
  if (!titlebar) return;
  titlebar.classList.remove('save-pulse');
  void titlebar.offsetWidth; // force reflow so re-adding the class restarts the animation
  titlebar.classList.add('save-pulse');
}

// `onSaved` runs only once the write has actually landed -- image insertion
// needs this ordering guarantee (see saveImmediately below): the old code
// ran its orphaned-image sweep from INSIDE the fs.writeFile callback,
// specifically so the sweep's "which images does the file on disk still
// reference" scan reads the just-written content, not whatever was there a
// moment earlier. Calling the sweep synchronously right after a fire-and-
// forget fs.writeFile (rather than from its callback) is a real, observed
// race: the sweep runs before the async write lands, still sees the OLD
// content with no reference to the brand-new image yet, and deletes the
// image it was just asked to insert.
function persistToDisk(markdown, onSaved) {
  if (!currentPath) return;
  fs.writeFile(currentPath, markdown, (err) => {
    if (!err) triggerSavePulse();
    if (onSaved) onSaved(err);
  });
  // Keep the Drive mirror in sync for as long as this note stays tagged.
  // main.js re-checks its own cached tag state before writing, so this is
  // safe to send unconditionally too, but skipping it here avoids a
  // pointless IPC message for the common untagged case.
  if (chatgptTagged) {
    ipcRenderer.send('sync-chatgpt-mirror', markdown);
  }
}

// Debounced autosave (1-second debounce, same window the old textarea
// version used) -- the only per-edit cost is scheduling a timer; the actual
// markdown serialization only runs once the debounce fires, not on every
// keystroke (Item 7).
function scheduleSave() {
  if (!currentPath) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    persistToDisk(getCurrentMarkdown());
  }, 1000);
}

// Bypasses the debounce for edits that should feel instantly persisted
// (image insert, checkbox toggle) -- mirrors the old insertImageBuffer's
// synchronous-feeling direct fs.writeFile. `onSaved` (see persistToDisk)
// lets a caller sequence work that depends on the write having landed.
function saveImmediately(onSaved) {
  if (!currentPath) { if (onSaved) onSaved(new Error('no currentPath')); return; }
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  persistToDisk(getCurrentMarkdown(), onSaved);
}

// Handle image paste
async function handleImagePaste(event) {
  const items = event.clipboardData.items;

  for (const item of items) {
    if (item.type.indexOf('image') === 0) {
      event.preventDefault();

      const file = item.getAsFile();
      const buffer = await file.arrayBuffer();
      const imageBuffer = Buffer.from(buffer);
      const ext = file.type.split('/')[1];

      await insertImageBuffer(imageBuffer, ext);
      break;
    }
  }
}

// Handle image insertion via the bottom toolbar's Image button (a file
// picker, since there's no clipboard image in that flow). `atRange` is a
// Range captured at click time (see fmtImageBtn's listener below) -- the
// native file-picker dialog steals window focus while it's open, so the
// selection captured before opening it is what actually gets restored once
// a file comes back, not whatever (if anything) the selection collapsed to
// in the meantime.
async function handleImageFilePick(file, atRange) {
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const imageBuffer = Buffer.from(buffer);
  const ext = (file.type.split('/')[1]) || path.extname(file.name).slice(1) || 'png';
  await insertImageBuffer(imageBuffer, ext, atRange);
}

// Shared by paste-an-image, the toolbar's Image button, and the screenshot
// flow: writes the image next to the note, inserts a real <img> element
// into the contenteditable DOM at the cursor (or at `atRange` if the caller
// captured one ahead of an async gap -- file picker, native snip overlay --
// during which the live selection can't be trusted), saves immediately, and
// sweeps orphaned images. turndown's default image rule converts the <img>
// straight back into a Markdown image link on save; verified live that the
// link still renders after a save+reload round-trip.
async function insertImageBuffer(imageBuffer, ext, atRange = null) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const filename = `${timestamp}-${random}.${ext}`;
  const imagePath = path.join(userImagesDir, filename);

  fs.writeFileSync(imagePath, imageBuffer);

  // Same space/paren/bracket encoding the old raw-text insertion used (the
  // notes directory itself contains a space -- "C:\Users\shiva\Sticky
  // Notes" -- so this isn't optional).
  const absoluteImagePath = `file:///${encodePathSpecialChars(imagePath.replace(/\\/g, '/'))}`;

  const img = document.createElement('img');
  img.setAttribute('src', absoluteImagePath);
  img.setAttribute('alt', filename);

  const sel = window.getSelection();
  let range = atRange || (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
  if (!range || !preview.contains(range.startContainer)) {
    // No usable selection inside the note (window never had focus, or lost
    // it) -- fall back to appending at the end rather than dropping the
    // image silently.
    range = document.createRange();
    range.selectNodeContents(preview);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(img);
  range.setStartAfter(img);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  preview.focus();

  // Cleanup has to wait for the write to actually land (see persistToDisk's
  // onSaved) -- running it right after a fire-and-forget write is a real
  // race that deletes the image this function just inserted, because the
  // sweep would still see the OLD on-disk content with no reference to it
  // yet. Verified live: this exact ordering bug caused a pasted image to
  // vanish from disk seconds after being inserted.
  saveImmediately(() => orphanedImageManager.cleanupOrphanedImages());
}

// Screenshot capture (v2 rework): triggers Windows' own native region-select
// snip overlay (the same UI as Win+Shift+S -- see main.js's
// 'trigger-native-snip' handler for which underlying mechanism launches it
// and why) instead of the old in-app desktopCapturer thumbnail picker.
//
// There's no "snip completed" event to subscribe to: the OS just copies the
// captured region to the clipboard once the user finishes dragging a
// selection, full stop. So completion is detected by polling
// clipboard.readImage() for a NEW image (compared against whatever was
// already on the clipboard before the snip was triggered, so a pre-existing
// clipboard image isn't mistaken for the capture) until one shows up, a
// timeout elapses, or the user cancels. Whatever's detected feeds into the
// exact same insertImageBuffer() used by paste-image and the toolbar's Image
// button -- not a second image pipeline.
const SNIP_POLL_INTERVAL_MS = 400;
const SNIP_TIMEOUT_MS = 90000; // generous -- the user may take a while to drag-select

let snipPollTimer = null;
let snipTimeoutTimer = null;
let snipCapturedRange = null; // selection at the moment the snip overlay opened

function isSnipPending() {
  return snipPollTimer !== null;
}

// Clears both timers and restores the button to its idle look/title. Safe to
// call redundantly (timeout, detection, cancel-click, and window teardown
// all funnel through this).
function stopSnipPolling() {
  if (snipPollTimer) {
    clearInterval(snipPollTimer);
    snipPollTimer = null;
  }
  if (snipTimeoutTimer) {
    clearTimeout(snipTimeoutTimer);
    snipTimeoutTimer = null;
  }
  const screenshotBtn = document.getElementById('screenshot-btn');
  if (screenshotBtn) {
    screenshotBtn.classList.remove('pending');
    screenshotBtn.title = 'Screenshot';
    screenshotBtn.setAttribute('aria-label', 'Screenshot');
  }
}

async function captureScreenshot() {
  const screenshotBtn = document.getElementById('screenshot-btn');

  // Clicking Screenshot again while a snip is already pending cancels it --
  // same "click to toggle off" language the pin/ChatGPT-mirror buttons use.
  if (isSnipPending()) {
    stopSnipPolling();
    return;
  }

  // The native snip overlay takes OS focus away from this window for as
  // long as the user is dragging a selection, which can silently collapse
  // or move the contenteditable Selection. Capture it now, before that
  // happens, so the eventual insert lands where the user actually clicked
  // Screenshot from, not wherever focus/selection ends up afterward.
  const sel = window.getSelection();
  snipCapturedRange = (sel && sel.rangeCount > 0 && preview.contains(sel.anchorNode))
    ? sel.getRangeAt(0).cloneRange()
    : null;

  let result;
  try {
    result = await ipcRenderer.invoke('trigger-native-snip');
  } catch (err) {
    console.error('trigger-native-snip failed:', err);
    return;
  }
  if (!result || !result.ok) {
    console.error('Could not launch the native snip overlay:', result && result.error);
    return;
  }

  // Baseline the clipboard's current image (if any) before the overlay
  // opens, so an unrelated image already sitting there doesn't false-
  // positive as "the capture" the moment polling starts.
  const before = clipboard.readImage();
  const beforePng = before.isEmpty() ? null : before.toPNG();

  if (screenshotBtn) {
    screenshotBtn.classList.add('pending');
    screenshotBtn.title = 'Waiting for snip... (click to cancel)';
    screenshotBtn.setAttribute('aria-label', 'Waiting for snip... (click to cancel)');
  }

  snipPollTimer = setInterval(() => {
    const current = clipboard.readImage();
    if (current.isEmpty()) return; // nothing captured yet, keep waiting
    const currentPng = current.toPNG();
    if (beforePng && currentPng.equals(beforePng)) return; // unchanged, keep waiting

    stopSnipPolling();
    insertImageBuffer(currentPng, 'png', snipCapturedRange).catch(err => {
      console.error('Failed to insert captured snip:', err);
    });
  }, SNIP_POLL_INTERVAL_MS);

  snipTimeoutTimer = setTimeout(() => {
    console.log('Snip capture timed out waiting for a clipboard image (cancelled or took too long).');
    stopSnipPolling();
  }, SNIP_TIMEOUT_MS);
}

// Belt-and-suspenders cleanup: the timers above are scoped to this render
// process, so closing the note window already tears them down for free, but
// this makes the "stop polling when the note window closes" requirement
// explicit rather than incidental.
window.addEventListener('beforeunload', stopSnipPolling);

// Loading indicator control functions
function showLoadingIndicator() {
    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) {
        loadingIndicator.style.display = 'flex';
    }
}

function hideLoadingIndicator() {
    const loadingIndicator = document.getElementById('loading-indicator');
    if (loadingIndicator) {
        loadingIndicator.style.display = 'none';
    }
}

// --- Selection/Range helpers shared by formatting commands, checklist
// Enter-handling, and initial cursor placement. ---

function placeCursorAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCursorAtStart(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Wraps the current selection in a plain inline tag (used for the
// inline-code keyboard shortcut, which has no execCommand equivalent).
// A no-op on a collapsed selection -- same "select something first" contract
// the old raw-text version had for this shortcut.
function wrapSelectionWithTag(tagName, preview) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !preview.contains(range.commonAncestorContainer)) return false;
  const el = document.createElement(tagName);
  el.appendChild(range.extractContents());
  range.insertNode(el);
  range.setStartAfter(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

function escapeHtmlForInsertHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Wraps the current selection's plain text in <pre><code> (the code-block
// keyboard shortcut). Code blocks are plain text by nature, so this
// deliberately flattens any nested formatting in the selection via
// range.toString() rather than preserving it. Goes through
// execCommand('insertHTML', ...) rather than a raw Range.insertNode for the
// same reason the checklist button does (see fmtChecklistBtn below): a raw
// insertNode can leave this block-level <pre> nested inside an active
// inline-formatting element instead of breaking out of it, which then
// serializes into invalid, marker-wrapped Markdown.
function wrapSelectionInPreCode(preview) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!preview.contains(range.commonAncestorContainer)) return false;
  const text = range.collapsed ? '' : range.toString();
  return document.execCommand('insertHTML', false, `<pre><code>${escapeHtmlForInsertHtml(text)}</code></pre>`);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Set initial theme
  ipcRenderer.invoke('get-current-theme').then(theme => {
      applyTheme(theme);
  });

  // Get app root path
  appRootPath = await ipcRenderer.invoke('get-app-path');

  const userDataPath = await ipcRenderer.invoke('get-user-data-path');
  const settingsPath = path.join(userDataPath, 'settings.json');

  // Set user image save path and create folder. This is kept alongside the
  // real notes directory (not Electron's userData) so the orphaned-image
  // scan (which looks for .md files next to the images folder) keeps working.
  const notesDir = await ipcRenderer.invoke('get-notes-dir');
  userImagesDir = path.join(notesDir, 'images');
  if (!fs.existsSync(userImagesDir)) {
    fs.mkdirSync(userImagesDir, { recursive: true });
  }

  // Initial orphaned image cleanup
  console.log('DOMContentLoaded: Initial cleanup triggered.');
  orphanedImageManager.cleanupOrphanedImages();

  preview = document.getElementById('preview');
  titlebar = document.getElementById('titlebar');
  const openListBtn = document.getElementById('open-list');
  const newNoteBtn = document.getElementById('new-note');
  const pinToggleBtn = document.getElementById('pin-toggle');
  const chatgptToggleBtn = document.getElementById('chatgpt-toggle');

  // Reflect actual window state (set by main.js at creation time, defaulting
  // to pinned) rather than assuming -- keeps the button honest even if main
  // process logic changes.
  function applyPinState(pinned) {
    if (!pinToggleBtn) return;
    pinToggleBtn.classList.toggle('pinned', pinned);
    const label = pinned
      ? 'Pinned: note stays on top (click to unpin)'
      : 'Not pinned (click to keep on top)';
    pinToggleBtn.title = label;
    // Kept in sync with `title` (Item 2) so a screen reader hears the
    // current pinned/unpinned state, not just a static "Pin" label.
    pinToggleBtn.setAttribute('aria-label', label);
  }

  ipcRenderer.invoke('get-pin-state').then(applyPinState);

  pinToggleBtn?.addEventListener('click', async () => {
    const newState = await ipcRenderer.invoke('toggle-pin');
    applyPinState(newState);
  });

  // "Send to ChatGPT" destination toggle. `chatgptTagged` (module-scoped,
  // shared with handleImagePaste) mirrors the state main.js caches on the
  // BrowserWindow.
  function applyChatgptState(tagged) {
    chatgptTagged = tagged;
    if (!chatgptToggleBtn) return;
    chatgptToggleBtn.classList.toggle('tagged', tagged);
    const label = tagged
      ? 'Sent to ChatGPT: mirrored in Google Drive (click to stop)'
      : 'Send to ChatGPT (mirror to Google Drive)';
    chatgptToggleBtn.title = label;
    chatgptToggleBtn.setAttribute('aria-label', label);
  }

  ipcRenderer.invoke('get-destinations').then(destinations => {
    applyChatgptState(!!destinations?.chatgpt);
  });

  chatgptToggleBtn?.addEventListener('click', async () => {
    const newState = await ipcRenderer.invoke('toggle-chatgpt-destination', getCurrentMarkdown());
    applyChatgptState(newState);
  });

  // Per-note color (Item 1). Setting data-color on <body> is the only thing
  // needed to retint the whole window -- see common.css's
  // body[data-color="..."] blocks, which override the same --bg/--surface/
  // --titlebar-bg variables note.css already uses everywhere else.
  const colorToggleBtn = document.getElementById('color-toggle');
  const colorPopover = document.getElementById('color-popover');
  const colorSwatches = colorPopover ? Array.from(colorPopover.querySelectorAll('.color-swatch')) : [];

  function applyNoteColor(color) {
    document.body.setAttribute('data-color', color);
    colorSwatches.forEach(sw => {
      const isActive = sw.dataset.color === color;
      sw.classList.toggle('active', isActive);
      sw.setAttribute('aria-pressed', String(isActive));
    });
  }

  ipcRenderer.invoke('get-note-color').then(applyNoteColor);

  colorToggleBtn?.addEventListener('click', e => {
    e.stopPropagation();
    colorPopover?.classList.toggle('hidden');
  });

  colorSwatches.forEach(sw => {
    sw.addEventListener('click', async e => {
      e.stopPropagation();
      const newColor = await ipcRenderer.invoke('set-note-color', sw.dataset.color);
      applyNoteColor(newColor);
      colorPopover?.classList.add('hidden');
    });
  });

  // "..." menu: Copy Note + Duplicate + Export as PDF.
  const moreMenuBtn = document.getElementById('more-menu-btn');
  const moreMenu = document.getElementById('more-menu');
  const copyNoteBtn = document.getElementById('copy-note-btn');
  const duplicateNoteBtn = document.getElementById('duplicate-note-btn');
  const exportPdfBtn = document.getElementById('export-pdf-btn');

  moreMenuBtn?.addEventListener('click', e => {
    e.stopPropagation();
    moreMenu?.classList.toggle('hidden');
  });

  copyNoteBtn?.addEventListener('click', () => {
    const { clipboard } = require('electron');
    clipboard.writeText(getCurrentMarkdown());
    moreMenu?.classList.add('hidden');
    window.showToast('Copied to clipboard');
  });

  // Duplicate (Item 4): copies the current, live content (serialized to
  // markdown) into a new note file (main.js's duplicate-note handler
  // generates the new filename and opens it as its own window with fresh
  // isNew=true defaults).
  duplicateNoteBtn?.addEventListener('click', async () => {
    moreMenu?.classList.add('hidden');
    try {
      const result = await ipcRenderer.invoke('duplicate-note', getCurrentMarkdown());
      window.showToast(result?.ok ? 'Note duplicated' : "Couldn't duplicate note");
    } catch (err) {
      console.error('Duplicate note failed:', err);
      window.showToast("Couldn't duplicate note");
    }
  });

  exportPdfBtn?.addEventListener('click', async () => {
    moreMenu?.classList.add('hidden');
    try {
      const result = await ipcRenderer.invoke('export-note-pdf');
      if (result?.canceled) return;
      window.showToast(result?.ok ? 'Exported as PDF' : 'Export failed');
    } catch (err) {
      console.error('Export as PDF failed:', err);
      window.showToast('Export failed');
    }
  });

  // Closes any open popover/dropdown on an outside click -- the color
  // popover and the "..." menu share this one listener.
  document.addEventListener('click', () => {
    colorPopover?.classList.add('hidden');
    moreMenu?.classList.add('hidden');
  });

  // Screenshot capture (Item 2).
  const screenshotBtn = document.getElementById('screenshot-btn');
  screenshotBtn?.addEventListener('click', () => {
    captureScreenshot().catch(err => console.error('Screenshot capture failed:', err));
  });

  // Auto-start the snip when this note was opened via the list's "Screenshot"
  // tile (main.js sends this once, after load-note, only for such notes).
  ipcRenderer.on('start-screenshot', () => {
    captureScreenshot().catch(err => console.error('Screenshot capture failed:', err));
  });

  function saveSettings() {
    const settings = { fontSize: currentFontSize };
    fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), () => {});
  }

  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (typeof settings.fontSize === 'number') {
        currentFontSize = settings.fontSize;
      }
    }
  } catch {
    // Ignore if settings file does not exist or is malformed
  }

  preview.style.fontSize = `${currentFontSize}px`;

  ipcRenderer.on('load-note', async (event, notePath, isNew) => {
    currentPath = notePath;

    showLoadingIndicator();

    try {
      if (currentPath && fs.existsSync(currentPath)) {
        const content = await new Promise((resolve, reject) => {
          fs.readFile(currentPath, 'utf-8', (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });

        // Convert existing app-asset:/// links to file:// links
        const convertedContent = await convertAppAssetLinks(content);

        // One-time markdown -> HTML parse (Item 7: the only per-load parse
        // cost, not a per-keystroke one).
        preview.innerHTML = renderMathInMarkdown(convertedContent);

        // If content was converted, save to file
        if (convertedContent !== content) {
          await new Promise((resolve, reject) => {
            fs.writeFile(currentPath, convertedContent, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
      } else {
        preview.innerHTML = '';
      }
    } catch (error) {
      console.error('Error loading note:', error);
      preview.innerHTML = '';
    } finally {
      hideLoadingIndicator();
      // Land the cursor in the actual content immediately, rather than
      // requiring an extra click to "find" the editable surface -- this is
      // the direct fix for the "hard to click in" root cause called out in
      // this task (a prior fix addressed the old textarea+preview model's
      // version of the same bug; verified live here that the new
      // single-surface model doesn't reintroduce it).
      placeCursorAtEnd(preview);
      preview.focus();
    }
  });

  // Window focus/blur: the titlebar recedes (fades, stops taking clicks) on
  // blur rather than disappearing outright, so there's no pop-in/out
  // flicker when refocusing (see #titlebar.blurred in note.css).
  ipcRenderer.on('window-focused', () => {
    titlebar?.classList.remove('blurred');
  });

  ipcRenderer.on('window-blurred', () => {
    titlebar?.classList.add('blurred');
  });

  // Checkbox toggle -- event delegation, same shape as the old
  // preview.addEventListener('change', ...) except there's no raw-text
  // rewrite step anymore: the DOM checkbox's checked state IS the state,
  // so toggling it just needs to be persisted, immediately (matches the old
  // checkbox handler's un-debounced fs.writeFile).
  preview.addEventListener('change', (event) => {
    if (event.target.type !== 'checkbox') return;
    saveImmediately();
  });

  // Any native editing operation inside the contenteditable surface --
  // typing, execCommand-driven formatting, paste, list toggling -- fires
  // 'input' here. This is the ONLY thing that runs per keystroke, and it
  // does nothing more expensive than scheduling a debounced timer; there is
  // no markdown parse, no innerHTML replace, no DOM diffing on this path.
  preview.addEventListener('input', () => {
    // Chrome leaves a lone <br> behind when a contenteditable is emptied by
    // deleting all its content; clearing it out keeps the CSS
    // #preview:empty placeholder (see note.css) actually working. Cheap
    // exact-string check, not a tree walk.
    if (preview.innerHTML === '<br>') preview.innerHTML = '';
    scheduleSave();
  });

  // Finds the nearest ancestor <li> of the current selection, if any --
  // used by both the checklist Enter-key handling and Tab indent/outdent
  // below.
  function ancestorListItem(sel) {
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    while (node && node !== preview) {
      if (node.nodeType === 1 && node.nodeName === 'LI') return node;
      node = node.parentNode;
    }
    return null;
  }

  // Finds the nearest block-level ancestor of the current selection (a
  // <div>/<p>/<li>/heading -- whatever Chromium wrapped the current line in),
  // used only by the '- ' auto-list shortcut below to know where "the start
  // of this line" is. Falls back to #preview itself for the one case where
  // there's no wrapping block yet: the very first line typed into a brand
  // new, empty note.
  function ancestorBlock(node) {
    while (node && node !== preview) {
      if (node.nodeType === 1) {
        const display = window.getComputedStyle(node).display;
        if (display === 'block' || display === 'list-item') return node;
      }
      node = node.parentNode;
    }
    return preview;
  }

  // Markdown-style auto-list shortcut (Item: '-' starts a bulleted list).
  // Mirrors what Typora/Notion/Obsidian do: typing '-' then Space at the
  // start of an otherwise-empty line converts that line into a bullet list
  // item, instead of leaving a literal "- " for the user to format by hand.
  // Detection happens on keydown for the Space key, BEFORE the space is
  // inserted, by checking that everything in the current line from its
  // start up to the cursor is exactly the single character '-'. Reuses the
  // exact same execCommand('insertUnorderedList') the toolbar's Bullet list
  // button (fmtListBtn) already calls, so the created list is
  // indistinguishable from one made via the toolbar, and Turndown's
  // bulletListMarker: '-' config (see createTurndownService above) means it
  // round-trips back to the same '- ' markdown on save.
  function tryDashAutoList(e, sel) {
    if (e.key !== ' ') return false;
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range || !range.collapsed) return false;
    // Skip inside an existing list item: execCommand('insertUnorderedList')
    // TOGGLES, so firing it again here (e.g. typing '- ' to start a nested
    // line inside an already-bulleted item) would strip the surrounding list
    // instead of adding one -- let Space behave normally there.
    if (ancestorListItem(sel)) return false;

    const block = ancestorBlock(range.startContainer);
    const blockRange = document.createRange();
    blockRange.selectNodeContents(block);
    blockRange.setEnd(range.startContainer, range.startOffset);
    if (blockRange.toString() !== '-') return false;

    e.preventDefault();
    // Select the '-' and remove it via the native 'delete' command rather
    // than a raw Range.deleteContents(). Verified live in Electron that the
    // raw-Range path matters here: deleteContents() leaves a truly empty
    // block with no placeholder <br>, and execCommand('insertUnorderedList')
    // immediately afterward gets confused by that and wraps the PREVIOUS
    // block instead of this one. Routing the deletion through execCommand
    // too keeps Chromium's own empty-block/<br>-placeholder bookkeeping
    // consistent, so the following insertUnorderedList reliably targets the
    // now-empty current line.
    sel.removeAllRanges();
    sel.addRange(blockRange);
    document.execCommand('delete');
    document.execCommand('insertUnorderedList');
    scheduleSave();
    return true;
  }

  // Checkbox-specific Enter handling (Item 5). The browser's native list
  // continuation (Enter in a plain <li> creates a new <li>) doesn't know to
  // carry a checkbox along -- it would just produce a checkbox-less line.
  // This mirrors the old raw-text behavior instead: Enter on a non-empty
  // checklist item continues with a fresh, unchecked checkbox; Enter on an
  // EMPTY checklist item exits the list (same "double-Enter backs out of a
  // list" shape the browser's own default list handling already has).
  function handleChecklistEnter(li) {
    const isEmpty = li.textContent.trim() === '';
    const listEl = li.parentNode;

    if (isEmpty) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      if (listEl.nextSibling) {
        listEl.parentNode.insertBefore(p, listEl.nextSibling);
      } else {
        listEl.parentNode.appendChild(p);
      }
      li.remove();
      if (listEl.children.length === 0) listEl.remove();
      placeCursorAtStart(p);
      return;
    }

    const newLi = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('contenteditable', 'false');
    newLi.appendChild(cb);
    newLi.appendChild(document.createTextNode(' '));
    li.after(newLi);
    placeCursorAtEnd(newLi);
  }

  document.addEventListener('keydown', e => {
    const previewFocused = document.activeElement === preview || preview.contains(document.activeElement);

    // Check for custom shortcuts
    for (const [action, shortcut] of Object.entries(shortcuts)) {
        if (matchesShortcut(e, shortcut)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            switch (action) {
                // View-mode switching no longer applies -- there is only
                // one surface now (Item 1). Kept as recognized, harmless
                // no-ops instead of removing the shortcut entirely, so a
                // custom-bound key doesn't start doing something
                // unexpected for anyone who had it muscle-memorized.
                case 'preview':
                case 'toggle-view':
                    break;
                case 'open-main':
                    ipcRenderer.send('open-main-window');
                    break;
                case 'new-note':
                    ipcRenderer.send('create-new-note-nearby');
                    break;
                case 'bold':
                    if (previewFocused) { document.execCommand('bold'); scheduleSave(); }
                    break;
                case 'italic':
                    if (previewFocused) { document.execCommand('italic'); scheduleSave(); }
                    break;
                case 'inline-code':
                    if (previewFocused && wrapSelectionWithTag('code', preview)) scheduleSave();
                    break;
                case 'code-block':
                    if (previewFocused && wrapSelectionInPreCode(preview)) scheduleSave();
                    break;
                case 'quote':
                    if (previewFocused) { document.execCommand('formatBlock', false, 'blockquote'); scheduleSave(); }
                    break;
                case 'heading':
                    if (previewFocused && !e.shiftKey) { document.execCommand('formatBlock', false, 'h1'); scheduleSave(); }
                    break;
                case 'strikethrough':
                    if (previewFocused && e.shiftKey) { document.execCommand('strikeThrough'); scheduleSave(); }
                    break;
            }
            return;
        }
    }

    if (!previewFocused) return;

    const sel = window.getSelection();

    if (e.key === 'Tab') {
        e.preventDefault();
        const li = ancestorListItem(sel);
        if (li) {
          document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        } else {
          document.execCommand('insertText', false, '    ');
        }
        scheduleSave();
        return;
    }

    if (e.key === ' ' && tryDashAutoList(e, sel)) {
        return;
    }

    if (e.key === 'Enter') {
        const li = ancestorListItem(sel);
        const checkbox = li && li.querySelector('input[type="checkbox"]');
        // Only intercept Enter for a checklist item where the checkbox is
        // that item's own direct marker (not one belonging to a nested
        // sub-list), and let every other Enter (plain text, plain list
        // items, headings, etc.) fall through to the browser's own native,
        // already-correct contenteditable handling.
        if (checkbox && checkbox.parentNode === li) {
          e.preventDefault();
          handleChecklistEnter(li);
          scheduleSave();
        }
        return;
    }
  });

  openListBtn?.addEventListener('click', () => {
    ipcRenderer.send('open-main-window');
  });

  newNoteBtn?.addEventListener('click', () => {
    ipcRenderer.send('create-new-note-nearby');
  });

  window.addEventListener(
    'wheel',
    e => {
      const isMac = process.platform === 'darwin';
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;

      if (!modifierKey) return;
      e.preventDefault();
      currentFontSize += e.deltaY < 0 ? 1 : -1;
      currentFontSize = Math.max(fontSizeMin, Math.min(currentFontSize, fontSizeMax));
      preview.style.fontSize = `${currentFontSize}px`;
      saveSettings();
    },
    { passive: false }
  );

  ipcRenderer.send('note-ready');

  // Add image paste event listener -- now on the contenteditable surface
  // itself, since that's the only surface left.
  preview.addEventListener('paste', handleImagePaste);

  // Persistent bottom formatting toolbar (Bold/Italic/List/Checklist/
  // Underline/Strikethrough/Image) -- same seven controls as before this
  // rewrite (Shivam's explicit call: keep the toolbar exactly this dense,
  // no new Word/Docs-style additions). Rewired from surround()'s literal
  // markdown-character insertion to act on the live selection/DOM via
  // execCommand, since there's no raw text buffer left to splice into.
  // Verified live in this Electron build: bold/italic/underline/
  // strikeThrough/insertUnorderedList all apply correctly and visibly.
  const fmtBoldBtn = document.getElementById('fmt-bold');
  const fmtItalicBtn = document.getElementById('fmt-italic');
  const fmtListBtn = document.getElementById('fmt-list');
  const fmtChecklistBtn = document.getElementById('fmt-checklist');
  const fmtUnderlineBtn = document.getElementById('fmt-underline');
  const fmtStrikeBtn = document.getElementById('fmt-strike');
  const fmtImageBtn = document.getElementById('fmt-image');
  const imageFileInput = document.getElementById('image-file-input');

  function runFormatCommand(command, value) {
    preview.focus();
    document.execCommand(command, false, value);
    scheduleSave();
  }

  fmtBoldBtn?.addEventListener('click', () => runFormatCommand('bold'));
  fmtItalicBtn?.addEventListener('click', () => runFormatCommand('italic'));
  fmtListBtn?.addEventListener('click', () => runFormatCommand('insertUnorderedList'));
  fmtUnderlineBtn?.addEventListener('click', () => runFormatCommand('underline'));
  fmtStrikeBtn?.addEventListener('click', () => runFormatCommand('strikeThrough'));

  // Checklist: inserts a fresh single-item task list at the cursor. There's
  // no execCommand for this specific markup, so it goes through
  // execCommand('insertHTML', ...) rather than a raw Range.insertNode --
  // verified live that raw insertNode is unsafe here: if the cursor happens
  // to sit inside an active inline-formatting run (e.g. right after
  // toggling Bold with nothing typed since), insertNode drops the new
  // block-level <ul> AS A CHILD of that inline element (invalid
  // block-inside-inline nesting), which then serializes into garbled,
  // marker-wrapped Markdown on save. execCommand's own insertion path
  // handles breaking out of an inline context correctly; a raw DOM range
  // does not. The browser also places the cursor right after inserted HTML
  // automatically, landing exactly after the trailing space -- ready to
  // type the item's text -- so no manual cursor placement is needed here.
  fmtChecklistBtn?.addEventListener('click', () => {
    preview.focus();
    document.execCommand('insertHTML', false, '<ul><li><input type="checkbox" contenteditable="false"> </li></ul>');
    scheduleSave();
  });

  // Insert-image button: opens a native file picker, so the current
  // selection has to be captured BEFORE that dialog steals focus (same
  // reasoning as the screenshot flow above).
  let pendingImageRange = null;
  fmtImageBtn?.addEventListener('click', () => {
    const sel = window.getSelection();
    pendingImageRange = (sel && sel.rangeCount > 0 && preview.contains(sel.anchorNode))
      ? sel.getRangeAt(0).cloneRange()
      : null;
    imageFileInput?.click();
  });
  imageFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    imageFileInput.value = ''; // allow picking the same file again later
    const atRange = pendingImageRange;
    pendingImageRange = null;
    await handleImageFilePick(file, atRange);
  });
});
