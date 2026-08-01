const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Theme application function
function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
}

let notesDir;
let currentSearch = '';
let shortcuts = {};

function getNoteTitle(content) {
  const firstLine = content.split('\n')[0];
  return firstLine.trim().substring(0, 30) || '(No title)';
}

// Body preview shown under the timestamp in the list row: the second
// non-empty line of the note (the first non-empty line is already used as
// the title above).
function getNoteSnippet(content) {
  const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return lines[1] || '';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Wraps the first case-insensitive occurrence of `query` inside `text` in
// <mark>, escaping the three slices (before/match/after) separately rather
// than escaping first and searching second -- escaping can change string
// length (e.g. "&" -> "&amp;"), which would throw off a match index found
// against the already-escaped string.
function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

// Search-aware snippet (Item 5): when there's no query, or the query only
// hits the title (already highlighted separately), this is just the normal
// second-line preview. When the query hits the body text, build a small
// window of context AROUND the actual match instead of the fixed
// second-line preview, so the match is guaranteed to be visible and
// highlightable rather than possibly appearing later in the note than
// whatever line normally gets shown.
function getSearchSnippet(content, query) {
  const plainSnippet = getNoteSnippet(content);
  if (!query) return escapeHtml(plainSnippet);

  const lowerTitle = getNoteTitle(content).toLowerCase();
  if (lowerTitle.includes(query) && !plainSnippet.toLowerCase().includes(query)) {
    // Title already carries the highlighted match; snippet stays as-is.
    return escapeHtml(plainSnippet);
  }

  const lowerContent = content.toLowerCase();
  const idx = lowerContent.indexOf(query);
  if (idx === -1) return escapeHtml(plainSnippet);

  const radius = 50;
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + query.length + radius);
  let windowText = content.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) windowText = '…' + windowText;
  if (end < content.length) windowText += '…';

  return highlightMatch(windowText, query);
}

document.addEventListener('DOMContentLoaded', async () => {
  notesDir = await ipcRenderer.invoke('get-notes-dir');

  // Set initial theme
  ipcRenderer.invoke('get-current-theme').then(theme => {
      applyTheme(theme);
  });

  const container = document.getElementById('notes');
  const addButton = document.getElementById('add');
  const searchInput = document.getElementById('search');
  const settingsButton = document.getElementById('settings-button'); // Get the new settings button

  settingsButton.addEventListener('click', () => { // Add event listener for settings button
    ipcRenderer.send('open-settings-window');
  });

  // Listen for theme changes from the main process
  ipcRenderer.on('theme-changed', (event, theme) => {
    applyTheme(theme);
  });

  async function loadNotes() {
    container.innerHTML = '';

    // Per-note colors (Item 1's list-row dot) live in main.js's state file,
    // keyed by full path -- read once per render rather than per row.
    const colors = await ipcRenderer.invoke('get-note-colors').catch(() => ({}));

    const allNoteFiles = fs.readdirSync(notesDir)
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const fullPath = path.join(notesDir, file);
        const stats = fs.statSync(fullPath);
        return {
          file: file,
          fullPath: fullPath,
          mtime: stats.mtime.getTime() // Last modified time (timestamp)
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // Sort by modification time in descending order (latest first)

    const visibleNotes = [];

    allNoteFiles.forEach(note => {
      const content = fs.readFileSync(note.fullPath, 'utf-8');
      const lowerContent = content.toLowerCase();
      const lowerTitle = getNoteTitle(content).toLowerCase();

      // Ranking (Item 5): title matches outrank content-only matches. Score
      // stays 0 (all equal) when there's no search, so the existing mtime
      // order below is untouched in the no-search case -- this is a
      // ranking/display upgrade on top of the same substring match, not a
      // new match algorithm.
      let score = 0;
      if (currentSearch) {
        const titleMatch = lowerTitle.includes(currentSearch);
        const contentMatch = lowerContent.includes(currentSearch);
        if (!titleMatch && !contentMatch) return;
        score = titleMatch ? 2 : 1;
      }

      visibleNotes.push({ note, content, score, color: colors[note.fullPath] || 'yellow' });
    });

    if (currentSearch) {
      // Array.prototype.sort is stable (guaranteed since ES2019), so notes
      // with equal scores keep the mtime-descending order they arrived in.
      visibleNotes.sort((a, b) => b.score - a.score);
    }

    if (visibleNotes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = currentSearch
        ? 'No notes match your search.'
        : 'No notes yet. Click New note to get started.';
      container.appendChild(empty);
      return;
    }

    visibleNotes.forEach(({ note, content, color }) => {
      const titleHtml = currentSearch
        ? highlightMatch(getNoteTitle(content), currentSearch)
        : escapeHtml(getNoteTitle(content));
      const snippetHtml = getSearchSnippet(content, currentSearch);

      const div = document.createElement('div');
      div.className = 'note';
      div.innerHTML = `
                <div class="row-top">
                  <span class="color-dot" data-color="${color}" title="${color}"></span>
                  <div class="title">${titleHtml}</div>
                </div>
                <div class="snippet">${snippetHtml}</div>
                <div class="time">${new Date(note.mtime).toLocaleString()}</div>
                <button class="delete-btn" title="Delete note">
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>
                  </svg>
                </button>
            `;
      div.addEventListener('click', () => {
        ipcRenderer.send('open-note', note.file);
      });
      div.querySelector('.delete-btn').addEventListener('click', e => {
        e.stopPropagation(); // Don't also trigger the row's open-note click
        ipcRenderer.send('delete-note', note.file);
      });
      container.appendChild(div);
    });
  }

  loadNotes();

  addButton.addEventListener('click', () => {
    ipcRenderer.send('create-new-note');
  });

  ipcRenderer.on('refresh-list', () => {
    loadNotes();
  });

  searchInput.addEventListener('input', e => {
    currentSearch = e.target.value.toLowerCase();
    loadNotes();
  });

  // Load shortcuts
  ipcRenderer.invoke('get-shortcuts').then(savedShortcuts => {
    shortcuts = savedShortcuts;
  });

  // Listen for shortcut updates
  ipcRenderer.on('shortcuts-updated', (event, newShortcuts) => {
    shortcuts = newShortcuts;
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

  // Replace the existing keydown event listener
  document.addEventListener('keydown', e => {
    // Check for custom shortcuts
    for (const [action, shortcut] of Object.entries(shortcuts)) {
      if (matchesShortcut(e, shortcut)) {
        e.preventDefault();
        
        switch (action) {
          case 'new-note':
            ipcRenderer.send('create-new-note');
            return;
          case 'focus-search':
            document.getElementById('search').focus();
            return;
        }
      }
    }
  });
}); 