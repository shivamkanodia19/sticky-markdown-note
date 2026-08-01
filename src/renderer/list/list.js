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

  function loadNotes() {
    container.innerHTML = '';
    
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
      if (
        currentSearch &&
        !lowerContent.includes(currentSearch) &&
        !lowerTitle.includes(currentSearch)
      ) {
        return;
      }
      visibleNotes.push({ note, content });
    });

    if (visibleNotes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = currentSearch
        ? 'No notes match your search.'
        : 'No notes yet. Click New note to get started.';
      container.appendChild(empty);
      return;
    }

    visibleNotes.forEach(({ note, content }) => {
      const div = document.createElement('div');
      div.className = 'note';
      div.innerHTML = `
                <div class="title">${escapeHtml(getNoteTitle(content))}</div>
                <div class="snippet">${escapeHtml(getNoteSnippet(content))}</div>
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