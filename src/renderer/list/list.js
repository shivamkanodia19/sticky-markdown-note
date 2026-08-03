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

// Which view the window is currently showing -- 'notes' (the normal list,
// with search + filter chips) or 'trash' (Recently Deleted, toggled via the
// titlebar's #trash-button). Both views share the same #notes container and
// row-click-opens/row-hover-shows-action visual language; they render
// different data and a different per-row action button.
let viewMode = 'notes';

// Filter chips (redesign Item 3) -- AND'd together across categories
// (pinned/chatgpt/color), but OR'd within the color set itself: a note has
// exactly one color, so selecting two colors and AND-ing them would always
// show zero notes, which isn't a useful filter. Selecting "blue" + "green"
// means "blue OR green", same as selecting just "Pinned" means every pinned
// note regardless of color.
const activeFilters = {
  pinned: false,
  chatgpt: false,
  colors: new Set(),
};

function getNoteTitle(content) {
  const firstLine = content.split('\n')[0];
  return firstLine.trim().substring(0, 30) || '(No title)';
}

// Strips the raw markdown syntax markers that would otherwise show up
// verbatim in a plain-text preview line (e.g. "- [ ] Buy milk" or
// "![shot](img.png)") -- cheap, single-pass regexes, not a render pass.
// Only applied to the plain (non-search) snippet line; getSearchSnippet's
// match-window extraction below is left raw so its highlight-index math
// (already non-trivial -- see that function's own comment) isn't disturbed.
function cleanSnippetLine(line) {
  return line
    .replace(/^[-*+]\s+\[[ xX]\]\s*/, '') // checklist marker
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')  // image markdown -- the glyph already signals "has an image"
    .replace(/^#{1,6}\s+/, '')             // heading marker
    .replace(/^>\s+/, '')                  // blockquote marker
    .replace(/[*_`]/g, '')                 // bold/italic/inline-code markers
    .trim();
}

// Body preview shown under the title in the list row: the second non-empty
// line of the note (the first non-empty line is already used as the title
// above), with raw markdown syntax cleaned up for display (see above).
function getNoteSnippet(content) {
  const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  return cleanSnippetLine(lines[1] || '');
}

// Rich-snippet glyph (redesign Item 2): a cheap, single regex test over the
// raw markdown -- NOT a parse/render pass -- to decide whether this note's
// preview should carry a small checklist or image indicator. Checked once
// per row per render, same cost class as the plain-text truncation it
// augments. Checklist takes priority over image when a note has both
// (matches "starts with or prominently contains a checklist" from spec).
const CHECKLIST_RE = /(?:^|\n)[ \t]*[-*+][ \t]+\[[ xX]\]/;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/;

function getSnippetGlyph(content) {
  if (CHECKLIST_RE.test(content)) return 'checklist';
  if (IMAGE_RE.test(content)) return 'image';
  return null;
}

const GLYPH_SVG = {
  checklist: '<svg class="snippet-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/></svg>',
  image: '<svg class="snippet-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
};

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

// Relative "trashed X ago" label for the Recently Deleted view -- coarse on
// purpose (minutes/hours/days), this is a hint, not a precise timestamp.
function formatRelativeTime(timestampMs) {
  const diffMs = Date.now() - timestampMs;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
  const trashButton = document.getElementById('trash-button');
  const trashBack = document.getElementById('trash-back');
  const trashBanner = document.getElementById('trash-banner');
  const toolbar = document.getElementById('toolbar');
  const filterChips = document.getElementById('filter-chips');

  settingsButton.addEventListener('click', () => { // Add event listener for settings button
    ipcRenderer.send('open-settings-window');
  });

  // Listen for theme changes from the main process
  ipcRenderer.on('theme-changed', (event, theme) => {
    applyTheme(theme);
  });

  function renderCurrentView() {
    if (viewMode === 'trash') {
      loadTrash();
    } else {
      loadNotes();
    }
  }

  function setViewMode(mode) {
    viewMode = mode;
    const inTrash = viewMode === 'trash';
    trashBanner.classList.toggle('hidden', !inTrash);
    toolbar.classList.toggle('hidden', inTrash);
    filterChips.classList.toggle('hidden', inTrash);
    trashButton.classList.toggle('active', inTrash);
    renderCurrentView();
  }

  trashButton.addEventListener('click', () => {
    setViewMode(viewMode === 'trash' ? 'notes' : 'trash');
  });
  trashBack.addEventListener('click', () => setViewMode('notes'));

  // Whether a note's metadata satisfies every currently-active filter chip.
  // AND across categories, OR within the color set (see activeFilters'
  // own comment above for why).
  function matchesActiveFilters(meta) {
    if (activeFilters.pinned && !meta.pinned) return false;
    if (activeFilters.chatgpt && !meta.chatgpt) return false;
    if (activeFilters.colors.size > 0 && !activeFilters.colors.has(meta.color)) return false;
    return true;
  }

  filterChips.querySelectorAll('.chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.filter; // 'pinned' | 'chatgpt'
      activeFilters[key] = !activeFilters[key];
      chip.classList.toggle('active', activeFilters[key]);
      loadNotes();
    });
  });

  filterChips.querySelectorAll('.chip-color[data-filter-color]').forEach(chip => {
    chip.addEventListener('click', () => {
      const color = chip.dataset.filterColor;
      if (activeFilters.colors.has(color)) {
        activeFilters.colors.delete(color);
        chip.classList.remove('active');
      } else {
        activeFilters.colors.add(color);
        chip.classList.add('active');
      }
      loadNotes();
    });
  });

  async function loadNotes() {
    container.innerHTML = '';

    // Bulk per-note metadata (color, pinned, chatgpt) -- one read of the
    // same state-file source of truth get-note-colors already used for just
    // the color dot, now also feeding the filter chips. Deliberately the
    // ONLY per-render IPC call this function makes (see get-note-meta's own
    // comment in main.js) rather than adding a second bulk read alongside it.
    const meta = await ipcRenderer.invoke('get-note-meta').catch(() => ({}));

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
      const noteMeta = meta[note.fullPath] || { color: 'yellow', pinned: true, chatgpt: false };

      if (!matchesActiveFilters(noteMeta)) return;

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

      visibleNotes.push({ note, content, score, color: noteMeta.color, sourceCount: noteMeta.sources || 0 });
    });

    if (currentSearch) {
      // Array.prototype.sort is stable (guaranteed since ES2019), so notes
      // with equal scores keep the mtime-descending order they arrived in.
      visibleNotes.sort((a, b) => b.score - a.score);
    }

    const filtersActive = activeFilters.pinned || activeFilters.chatgpt || activeFilters.colors.size > 0;

    if (visibleNotes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      if (currentSearch || filtersActive) {
        // Search/filter-empty ("no results for this query/filter combo") is
        // a different state than "you have zero notes at all" -- text only,
        // no glyph, same as before.
        empty.textContent = currentSearch
          ? 'No notes match your search.'
          : 'No notes match the selected filters.';
      } else {
        // Zero-notes empty state (Item 3): a small static sticky-note glyph
        // above the existing text, matching the Lucide-style stroke icons
        // used everywhere else in this app (stroke-width 1.75, round caps/
        // joins, currentColor) -- inline SVG, no runtime cost.
        empty.innerHTML = `
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l6-6V5a2 2 0 0 0-2-2Z"/>
            <path d="M15 3v4a2 2 0 0 0 2 2h4"/>
          </svg>
          <div>No notes yet. Click New note to get started.</div>
        `;
      }
      container.appendChild(empty);
      return;
    }

    visibleNotes.forEach(({ note, content, color, sourceCount }) => {
      const titleHtml = currentSearch
        ? highlightMatch(getNoteTitle(content), currentSearch)
        : escapeHtml(getNoteTitle(content));
      const snippetHtml = getSearchSnippet(content, currentSearch);
      const glyph = getSnippetGlyph(content);
      const glyphHtml = glyph ? GLYPH_SVG[glyph] : '';

      // Source badge (Item 9): link glyph + count when a note has one or more
      // attached browser-window sources (count comes from get-note-meta, same
      // single bulk read as color/pinned/chatgpt). Fades on row hover so the
      // delete icon that shares the top-right corner has clean space.
      const sourceLabel = `${sourceCount} source${sourceCount === 1 ? '' : 's'} attached`;
      const sourceBadgeHtml = sourceCount > 0
        ? `<span class="source-badge" title="${sourceLabel}" aria-label="${sourceLabel}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>${sourceCount}</span>`
        : '';

      const div = document.createElement('div');
      div.className = 'note';
      div.dataset.color = color; // drives the left-edge color stripe (Item 1)
      div.innerHTML = `
                <div class="row-top">
                  <span class="color-dot" data-color="${color}" title="${color}"></span>
                  <div class="title">${titleHtml}</div>
                  ${sourceBadgeHtml}
                </div>
                <div class="snippet">${glyphHtml}<span class="snippet-text">${snippetHtml}</span></div>
                <div class="time">${new Date(note.mtime).toLocaleString()}</div>
                <button class="delete-btn" title="Delete note" aria-label="Delete note">
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>
                  </svg>
                </button>
            `;
      div.addEventListener('click', () => {
        ipcRenderer.send('open-note', note.file);
      });
      div.querySelector('.delete-btn').addEventListener('click', async e => {
        e.stopPropagation(); // Don't also trigger the row's open-note click

        // main.js's delete-note handler reads the actual file content.
        // Whitespace-only content deletes for real, immediately, with zero
        // friction and no toast -- exactly as before. Content-bearing notes
        // are soft-deleted (moved into notesDir/.trash, see main.js) --
        // still instant, no blocking confirm dialog -- and this toast's
        // Undo is the fast path back; the note also now sits in the
        // Recently Deleted view (48h retention) even after this toast times
        // out, unlike before.
        const result = await ipcRenderer.invoke('delete-note', note.file).catch(err => {
          console.error('Delete note failed:', err);
          return null;
        });

        if (result?.ok && result.isEmpty === false) {
          window.showToast('Note deleted', {
            actionLabel: 'Undo',
            // Longer than the toast component's ~2.8s default: this toast's
            // action is the fast-path recovery, so it gets more time than a
            // plain "Copied!"-style confirmation would.
            duration: 5000,
            onAction: () => {
              ipcRenderer.invoke('undo-delete-note', note.file).catch(err => {
                console.error('Undo delete failed:', err);
              });
              // No manual re-render here -- main.js's undo-delete-note
              // handler sends 'refresh-list' on success, same as every
              // other mutation this window reacts to.
            },
          });
        }
      });
      container.appendChild(div);
    });
  }

  // Recently Deleted view (redesign Item 4). Reads main.js's get-trash-notes
  // (same readStateFile source of truth as everything else), then reads each
  // trashed note's content directly off disk -- same nodeIntegration
  // direct-fs pattern loadNotes above already uses for the main list, just
  // pointed at notesDir/.trash instead of notesDir.
  async function loadTrash() {
    container.innerHTML = '';

    const trashItems = await ipcRenderer.invoke('get-trash-notes').catch(() => []);
    trashItems.sort((a, b) => b.trashedAt - a.trashedAt);

    if (trashItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Recently Deleted is empty.';
      container.appendChild(empty);
      return;
    }

    trashItems.forEach(item => {
      let content = '';
      try {
        content = fs.readFileSync(item.fullPath, 'utf-8');
      } catch (e) {
        console.error('Failed to read trashed note:', e);
        return;
      }

      const titleHtml = escapeHtml(getNoteTitle(content));
      const snippetHtml = escapeHtml(getNoteSnippet(content));
      const glyph = getSnippetGlyph(content);
      const glyphHtml = glyph ? GLYPH_SVG[glyph] : '';

      const div = document.createElement('div');
      div.className = 'note trash-note';
      div.dataset.color = item.color;
      div.innerHTML = `
                <div class="row-top">
                  <span class="color-dot" data-color="${item.color}" title="${item.color}"></span>
                  <div class="title">${titleHtml}</div>
                </div>
                <div class="snippet">${glyphHtml}<span class="snippet-text">${snippetHtml}</span></div>
                <div class="time">Trashed ${formatRelativeTime(item.trashedAt)}</div>
                <button class="restore-btn" title="Restore note" aria-label="Restore note">Restore</button>
            `;
      div.querySelector('.restore-btn').addEventListener('click', async e => {
        e.stopPropagation();
        const result = await ipcRenderer.invoke('undo-delete-note', item.file).catch(err => {
          console.error('Restore failed:', err);
          return null;
        });
        if (result?.ok) {
          window.showToast('Note restored');
        } else {
          window.showToast('Could not restore note -- it may have expired.');
        }
        // main.js's undo-delete-note sends 'refresh-list' on success, which
        // re-renders this same trash view via renderCurrentView() below.
      });
      container.appendChild(div);
    });
  }

  renderCurrentView();

  addButton.addEventListener('click', () => {
    ipcRenderer.send('create-new-note');
  });

  ipcRenderer.on('refresh-list', () => {
    renderCurrentView();
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
