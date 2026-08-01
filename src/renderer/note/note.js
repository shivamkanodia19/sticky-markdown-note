// note.js
const { ipcRenderer } = require('electron');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');
const CheckboxManager = require('./checkbox');

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
// picker, since there's no clipboard image in that flow).
async function handleImageFilePick(file) {
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const imageBuffer = Buffer.from(buffer);
  const ext = (file.type.split('/')[1]) || path.extname(file.name).slice(1) || 'png';
  await insertImageBuffer(imageBuffer, ext);
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

function surround(before, after = before) {
  const editor = document.getElementById('editor');
  const text = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = text.slice(start, end);

  // Insert text at cursor position
  const newText = text.slice(0, start) + before + selected + after + text.slice(end);
  editor.value = newText;

  // Dispatch the same 'input' event typing fires, so this goes through the
  // normal debounced preview-render + autosave path instead of duplicating
  // it (and instead of silently skipping the save, which direct preview
  // writes used to do here).
  editor.dispatchEvent(new Event('input'));

  // Focus editor and set cursor position
  editor.focus();
  const newPosition = start + before.length;
  editor.selectionStart = newPosition;
  editor.selectionEnd = newPosition;

  // Force cursor position update
  setTimeout(() => {
    editor.selectionStart = newPosition;
    editor.selectionEnd = newPosition;
  }, 0);
}

// Wraps each selected line (or just inserts a bare bullet at the cursor) in
// a Markdown list marker. Shared by the bottom toolbar's List button.
function insertBulletList() {
  const editor = document.getElementById('editor');
  const text = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = text.slice(start, end);

  const bulleted = selected
    ? selected.split('\n').map(line => '- ' + line).join('\n')
    : '- ';

  const newText = text.slice(0, start) + bulleted + text.slice(end);
  editor.value = newText;
  editor.dispatchEvent(new Event('input'));

  editor.focus();
  const newPosition = start + bulleted.length;
  editor.selectionStart = editor.selectionEnd = newPosition;
}

// Shared by paste-an-image and the toolbar's Image button: writes the image
// next to the note, inserts a Markdown image link at the cursor, and saves.
async function insertImageBuffer(imageBuffer, ext) {
  const editor = document.getElementById('editor');
  const preview = document.getElementById('preview');

  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const filename = `${timestamp}-${random}.${ext}`;
  const imagePath = path.join(userImagesDir, filename);

  fs.writeFileSync(imagePath, imageBuffer);

  const absoluteImagePath = `file:///${imagePath.replace(/\\/g, '/')}`;
  const imageMarkdown = `![${filename}](${absoluteImagePath})`;

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const text = editor.value;
  editor.value = text.slice(0, start) + imageMarkdown + text.slice(end);
  editor.selectionStart = editor.selectionEnd = start + imageMarkdown.length;

  preview.innerHTML = renderMathInMarkdown(editor.value);

  if (currentPath) {
    fs.writeFile(currentPath, String(editor.value), () => {
      orphanedImageManager.cleanupOrphanedImages();
    });
    // This save path bypasses the debounced 'input' handler (no native
    // input event dispatched), so the mirror sync has to be triggered
    // explicitly too.
    if (chatgptTagged) {
      ipcRenderer.send('sync-chatgpt-mirror', String(editor.value));
    }
  }
}

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

  const editor = document.getElementById('editor');
  const preview = document.getElementById('preview');
  const titlebar = document.getElementById('titlebar');
  const openListBtn = document.getElementById('open-list');
  const viewEditBtn = document.getElementById('view-edit');
  const viewPreviewBtn = document.getElementById('view-preview');
  const viewSplitBtn = document.getElementById('view-split');
  const newNoteBtn = document.getElementById('new-note');
  const pinToggleBtn = document.getElementById('pin-toggle');
  const chatgptToggleBtn = document.getElementById('chatgpt-toggle');

  // Reflect actual window state (set by main.js at creation time, defaulting
  // to pinned) rather than assuming -- keeps the button honest even if main
  // process logic changes.
  function applyPinState(pinned) {
    if (!pinToggleBtn) return;
    pinToggleBtn.classList.toggle('pinned', pinned);
    pinToggleBtn.title = pinned
      ? 'Pinned: note stays on top (click to unpin)'
      : 'Not pinned (click to keep on top)';
  }

  ipcRenderer.invoke('get-pin-state').then(applyPinState);

  pinToggleBtn?.addEventListener('click', async () => {
    const newState = await ipcRenderer.invoke('toggle-pin');
    applyPinState(newState);
  });

  // "Send to ChatGPT" destination toggle. `chatgptTagged` (module-scoped,
  // shared with handleImagePaste) mirrors the state main.js caches on the
  // BrowserWindow -- kept here too so the autosave handler below can decide,
  // on every keystroke, whether to also sync the Drive mirror without an
  // extra IPC round-trip per character typed.
  function applyChatgptState(tagged) {
    chatgptTagged = tagged;
    if (!chatgptToggleBtn) return;
    chatgptToggleBtn.classList.toggle('tagged', tagged);
    chatgptToggleBtn.title = tagged
      ? 'Sent to ChatGPT: mirrored in Google Drive (click to stop)'
      : 'Send to ChatGPT (mirror to Google Drive)';
  }

  ipcRenderer.invoke('get-destinations').then(destinations => {
    applyChatgptState(!!destinations?.chatgpt);
  });

  chatgptToggleBtn?.addEventListener('click', async () => {
    const newState = await ipcRenderer.invoke('toggle-chatgpt-destination', editor.value);
    applyChatgptState(newState);
  });

  // viewMode is one of 'edit' | 'preview' | 'split'. Titlebar visibility is
  // handled entirely by CSS (opacity, via the 'blurred' class below) so
  // there's no display state to set here.
  //
  // Defaults to 'split' unconditionally (new AND existing notes) so a
  // clickable, focusable <textarea> is always on screen the moment a note
  // opens. This used to default to 'preview' for existing notes, which put
  // a non-editable preview div where the cursor lands -- clicking did
  // nothing because there was no editable element under the pointer. That
  // was the actual cause of "hard to click in", not a styling issue.
  let viewMode = 'split';
  let saveTimeout = null;
  let previewRenderTimeout = null;

  // Checkbox click event listener (event delegation)
  preview.addEventListener('change', (event) => {
    checkboxManager.handleCheckboxChange(event, editor, preview, currentPath);
  });

  function saveSettings() {
    const settings = { fontSize: currentFontSize };
    fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), () => {});
  }

  // Debounced, and skipped entirely while the preview pane isn't visible
  // (viewMode === 'edit') -- called from the per-keystroke input handler
  // below, where a synchronous full markdown re-parse + DOM replace on
  // every character was the main cause of typing lag.
  function schedulePreviewRender(text) {
    if (viewMode === 'edit') return;
    if (previewRenderTimeout) clearTimeout(previewRenderTimeout);
    previewRenderTimeout = setTimeout(() => {
      preview.innerHTML = renderMathInMarkdown(text);
    }, 80);
  }

  function updateView() {
    if (viewMode === 'split') {
      editor.style.display = 'block';
      preview.style.display = 'block';
    } else {
      editor.style.display = viewMode === 'edit' ? 'block' : 'none';
      preview.style.display = viewMode === 'preview' ? 'block' : 'none';
    }
    if (viewMode === 'edit') {
      editor.focus();
    } else {
      // The preview may have missed renders while it was hidden in
      // edit-only mode (schedulePreviewRender skips those). Refresh it
      // immediately -- this is a one-off mode switch, not a per-keystroke
      // call, so an undebounced render here is not a performance concern.
      if (previewRenderTimeout) {
        clearTimeout(previewRenderTimeout);
        previewRenderTimeout = null;
      }
      preview.innerHTML = renderMathInMarkdown(editor.value);
    }
    document.body.classList.remove('both-mode', 'only-mode');
    document.body.classList.add(viewMode === 'split' ? 'both-mode' : 'only-mode');

    [viewEditBtn, viewPreviewBtn, viewSplitBtn].forEach(btn => btn?.classList.remove('active'));
    const activeBtn = viewMode === 'edit' ? viewEditBtn : viewMode === 'preview' ? viewPreviewBtn : viewSplitBtn;
    activeBtn?.classList.add('active');
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

  editor.style.fontSize = `${currentFontSize}px`;
  preview.style.fontSize = `${currentFontSize}px`;

  ipcRenderer.on('load-note', async (event, notePath, isNew) => {
    currentPath = notePath;
    // viewMode is already 'split' by default (see declaration above) for
    // both new and existing notes -- nothing to branch on here anymore.

    showLoadingIndicator(); // Show loading indicator before reading file

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
        editor.value = convertedContent;
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
      }
    } catch (error) {
      console.error('Error loading note:', error);
      editor.value = '';
      preview.innerHTML = '';
    } finally {
      hideLoadingIndicator(); // Hide loading indicator after everything is done
      updateView();
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

  editor.addEventListener('input', () => {
    const text = editor.value;
    // Debounced (80ms) and skipped entirely in edit-only mode -- see
    // schedulePreviewRender above. This used to be a synchronous full
    // markdown re-parse + DOM replace on every keystroke, which was the
    // main cause of typing lag, especially since it ran even when the
    // preview pane was display:none.
    schedulePreviewRender(text);

    // Auto-save (1-second debounce)
    if (currentPath) {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      saveTimeout = setTimeout(() => {
        fs.writeFile(currentPath, String(text), () => {});
        // Keep the Drive mirror in sync for as long as this note stays
        // tagged. main.js re-checks its own cached tag state before writing,
        // so this is safe to send unconditionally too, but skipping it here
        // avoids a pointless IPC message for the common untagged case.
        if (chatgptTagged) {
          ipcRenderer.send('sync-chatgpt-mirror', String(text));
        }
      }, 1000);
    }
  });

  document.addEventListener('keydown', e => {
    const editorIsFocused = document.activeElement === editor;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = editor.value;
    const selected = text.slice(start, end);

    // Check for custom shortcuts
    for (const [action, shortcut] of Object.entries(shortcuts)) {
        if (matchesShortcut(e, shortcut)) {
            // Stop all event propagation
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            // Execute the action
            switch (action) {
                case 'preview':
                    viewMode = 'split';
                    updateView();
                    break;
                case 'toggle-view':
                    // Toggle between edit-only and preview-only, exiting split.
                    viewMode = (viewMode === 'split' || viewMode === 'preview') ? 'edit' : 'preview';
                    updateView();
                    break;
                case 'open-main':
                    ipcRenderer.send('open-main-window');
                    break;
                case 'new-note':
                    ipcRenderer.send('create-new-note-nearby');
                    break;
                case 'bold':
                    if (editorIsFocused) {
                        const text = editor.value;
                        const start = editor.selectionStart;
                        const end = editor.selectionEnd;
                        const selected = text.slice(start, end);
                        
                        // Check if we're inside a bold text
                        const beforeText = text.slice(0, start);
                        const afterText = text.slice(end);
                        const beforeBold = beforeText.lastIndexOf('**');
                        const afterBold = afterText.indexOf('**');
                        
                        if (beforeBold !== -1 && afterBold !== -1) {
                            // We're inside a bold text, move cursor after the closing **
                            editor.selectionStart = editor.selectionEnd = end + afterBold + 2;
                        } else {
                            // Start new bold text
                            const newText = text.slice(0, start) + '**' + selected + '**' + text.slice(end);
                            editor.value = newText;
                            preview.innerHTML = renderMathInMarkdown(newText);
                            editor.focus();
                            editor.selectionStart = editor.selectionEnd = start + 2;
                        }
                    }
                    break;
                case 'italic':
                    if (editorIsFocused) {
                        const text = editor.value;
                        const start = editor.selectionStart;
                        const end = editor.selectionEnd;
                        const selected = text.slice(start, end);
                        
                        // Check if we're inside italic text
                        const beforeText = text.slice(0, start);
                        const afterText = text.slice(end);
                        const beforeItalic = beforeText.lastIndexOf('*');
                        const afterItalic = afterText.indexOf('*');
                        
                        if (beforeItalic !== -1 && afterItalic !== -1) {
                            // We're inside italic text, move cursor after the closing *
                            editor.selectionStart = editor.selectionEnd = end + afterItalic + 1;
                        } else {
                            // Start new italic text
                            const newText = text.slice(0, start) + '*' + selected + '*' + text.slice(end);
                            editor.value = newText;
                            preview.innerHTML = renderMathInMarkdown(newText);
                            editor.focus();
                            editor.selectionStart = editor.selectionEnd = start + 1;
                        }
                    }
                    break;
                case 'inline-code':
                    if (editorIsFocused) {
                        const text = editor.value;
                        const start = editor.selectionStart;
                        const end = editor.selectionEnd;
                        const selected = text.slice(start, end);
                        
                        // Check if we're inside inline code
                        const beforeText = text.slice(0, start);
                        const afterText = text.slice(end);
                        const beforeCode = beforeText.lastIndexOf('`');
                        const afterCode = afterText.indexOf('`');
                        
                        if (beforeCode !== -1 && afterCode !== -1) {
                            // We're inside inline code, move cursor after the closing `
                            editor.selectionStart = editor.selectionEnd = end + afterCode + 1;
                        } else {
                            // Start new inline code
                            const newText = text.slice(0, start) + '`' + selected + '`' + text.slice(end);
                            editor.value = newText;
                            preview.innerHTML = renderMathInMarkdown(newText);
                            editor.focus();
                            editor.selectionStart = editor.selectionEnd = start + 1;
                        }
                    }
                    break;
                case 'code-block':
                    if (editorIsFocused) {
                        const newText = text.slice(0, start) + '\n```\n' + selected + '\n```' + text.slice(end);
                        editor.value = newText;
                        preview.innerHTML = renderMathInMarkdown(newText);
                        editor.focus();
                        editor.selectionStart = editor.selectionEnd = start + 5;
                    }
                    break;
                case 'quote':
                    if (editorIsFocused) {
                        const quote = selected
                            ? selected
                                .split('\n')
                                .map(line => '> ' + line)
                                .join('\n')
                            : '> ';
                        const newText = text.slice(0, start) + quote + text.slice(end);
                        editor.value = newText;
                        preview.innerHTML = renderMathInMarkdown(newText);
                        editor.focus();
                        editor.selectionStart = editor.selectionEnd = start + quote.length;
                    }
                    break;
                case 'heading':
                    if (editorIsFocused && !e.shiftKey) {
                        const heading = selected
                            ? selected
                                .split('\n')
                                .map(line => '# ' + line)
                                .join('\n')
                            : '# ';
                        const newText = text.slice(0, start) + heading + text.slice(end);
                        editor.value = newText;
                        preview.innerHTML = renderMathInMarkdown(newText);
                        editor.focus();
                        editor.selectionStart = editor.selectionEnd = start + heading.length;
                    }
                    break;
                case 'strikethrough':
                    if (editorIsFocused && e.shiftKey) {
                        const text = editor.value;
                        const start = editor.selectionStart;
                        const end = editor.selectionEnd;
                        const selected = text.slice(start, end);
                        
                        // Check if we're inside strikethrough text
                        const beforeText = text.slice(0, start);
                        const afterText = text.slice(end);
                        const beforeStrike = beforeText.lastIndexOf('~~');
                        const afterStrike = afterText.indexOf('~~');
                        
                        if (beforeStrike !== -1 && afterStrike !== -1) {
                            // We're inside strikethrough text, move cursor after the closing ~~
                            editor.selectionStart = editor.selectionEnd = end + afterStrike + 2;
                        } else {
                            // Start new strikethrough text
                            const newText = text.slice(0, start) + '~~' + selected + '~~' + text.slice(end);
                            editor.value = newText;
                            preview.innerHTML = renderMathInMarkdown(newText);
                            editor.focus();
                            editor.selectionStart = editor.selectionEnd = start + 2;
                        }
                    }
                    break;
            }
            return;
        }
    }

    // Handle Tab key for indentation
    if (!editorIsFocused) return;
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const text = editor.value;
        
        // Get the current line
        const before = text.slice(0, start);
        const after = text.slice(end);
        const currentLineStart = before.lastIndexOf('\n') + 1;
        const currentLineEnd = after.indexOf('\n') === -1 ? text.length : end + after.indexOf('\n');
        const currentLine = text.slice(currentLineStart, currentLineEnd);
        
        // Check if we're in a list item
        const isListItem = /^(\s*)([-*+]\s|\d+\.\s)/.test(currentLine);
        
        let newText;
        if (e.shiftKey) {
            // Unindent
            if (isListItem) {
                const match = currentLine.match(/^(\s*)([-*+]\s|\d+\.\s)(.*)/);
                if (match) {
                    const [, indent, bullet, content] = match;
                    const newIndent = indent.length >= 4 ? indent.slice(4) : '';
                    newText = text.slice(0, currentLineStart) + newIndent + bullet + content + text.slice(currentLineEnd);
                    editor.value = newText;
                    editor.selectionStart = editor.selectionEnd = start - 4;
                }
            } else {
                const lines = text.slice(start, end).split('\n');
                newText = lines
                    .map(line => {
                        if (line.startsWith('    ')) {
                            return line.slice(4);
                        } else if (line.startsWith('\t')) {
                            return line.slice(1);
                        }
                        return line;
                    })
                    .join('\n');
                editor.value = before + newText + after;
                if (start === end) {
                    editor.selectionStart = editor.selectionEnd = start - 4;
                } else {
                    editor.selectionStart = start;
                    editor.selectionEnd = start + newText.length;
                }
            }
        } else {
            // Indent
            if (isListItem) {
                const match = currentLine.match(/^(\s*)([-*+]\s|\d+\.\s)(.*)/);
                if (match) {
                    const [, indent, bullet, content] = match;
                    newText = text.slice(0, currentLineStart) + indent + '    ' + bullet + content + text.slice(currentLineEnd);
                    editor.value = newText;
                    editor.selectionStart = editor.selectionEnd = start + 4;
                }
            } else {
                const lines = text.slice(start, end).split('\n');
                newText = lines.map(line => '    ' + line).join('\n');
                editor.value = before + newText + after;
                if (start === end) {
                    editor.selectionStart = editor.selectionEnd = start + 4;
                } else {
                    editor.selectionStart = start;
                    editor.selectionEnd = start + newText.length;
                }
            }
        }
        
        editor.dispatchEvent(new Event('input'));
        return;
    }

    // Handle Enter key for lists
    if (e.key === 'Enter') {
        const text = editor.value;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const before = text.slice(0, start);
        const after = text.slice(end);
        const lines = before.split('\n');
        const currentLine = lines[lines.length - 1];
        
        // Handle consecutive bullet points
        const bulletMatch = currentLine.match(/^(\s*)([-*+]\s)/);
        const numberMatch = currentLine.match(/^(\s*)(\d+\.\s)/);
        const checkboxMatch = currentLine.match(/^(\s*)([-*+]|\d+\.)\s\[[ x]\]\s/);
        
        if (bulletMatch || numberMatch || checkboxMatch) {
            e.preventDefault();
            const match = bulletMatch || numberMatch || checkboxMatch;
            const [, indent, bullet] = match;
            
            // If current line only contains a bullet point (no content)
            if (currentLine.trim() === bullet.trim() || (checkboxMatch && currentLine.trim() === bullet.trim() + '[ ]')) {
                // If bullet point is indented, unindent it
                if (indent.length >= 4) {
                    const newIndent = indent.slice(4);
                    const newText = before.slice(0, -currentLine.length) + newIndent + bullet + '\n' + after;
                    editor.value = newText;
                    editor.selectionStart = editor.selectionEnd = start - 4;
                } else {
                    // Remove bullet point and add new line
                    const newText = before.slice(0, -currentLine.length) + '\n' + after;
                    editor.value = newText;
                    editor.selectionStart = editor.selectionEnd = start - currentLine.length;
                }
            } else {
                // Normal case: add bullet point to next line
                let nextBullet = bullet;
                if (numberMatch) {
                    // For numbered lists, increment to the next number
                    const currentNumber = parseInt(bullet);
                    nextBullet = `${indent}${currentNumber + 1}. `;
                } else {
                    nextBullet = `${indent}${bullet}`;
                }

                // If current line has a checkbox, add checkbox to next line
                if (checkboxMatch) {
                    nextBullet += '[ ] ';
                }

                const newText = before + '\n' + nextBullet + after;
                editor.value = newText;
                editor.selectionStart = editor.selectionEnd = start + nextBullet.length + 1;
            }
            preview.innerHTML = renderMathInMarkdown(editor.value);
            return;
        }
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
      editor.style.fontSize = `${currentFontSize}px`;
      preview.style.fontSize = `${currentFontSize}px`;
      saveSettings();
    },
    { passive: false }
  );

  viewEditBtn?.addEventListener('click', () => {
    viewMode = 'edit';
    updateView();
  });

  viewPreviewBtn?.addEventListener('click', () => {
    viewMode = 'preview';
    updateView();
  });

  viewSplitBtn?.addEventListener('click', () => {
    viewMode = 'split';
    updateView();
  });

  updateView();

  ipcRenderer.send('note-ready');

  // Add image paste event listener
  editor.addEventListener('paste', handleImagePaste);

  // Persistent bottom formatting toolbar (Bold/Italic/List/Image) --
  // replaces the old edit/preview/split segmented control now that 'split'
  // is always the default, real view (see viewMode declaration above).
  const fmtBoldBtn = document.getElementById('fmt-bold');
  const fmtItalicBtn = document.getElementById('fmt-italic');
  const fmtListBtn = document.getElementById('fmt-list');
  const fmtImageBtn = document.getElementById('fmt-image');
  const imageFileInput = document.getElementById('image-file-input');

  fmtBoldBtn?.addEventListener('click', () => surround('**'));
  fmtItalicBtn?.addEventListener('click', () => surround('*'));
  fmtListBtn?.addEventListener('click', () => insertBulletList());
  fmtImageBtn?.addEventListener('click', () => imageFileInput?.click());
  imageFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    imageFileInput.value = ''; // allow picking the same file again later
    await handleImageFilePick(file);
  });
});
