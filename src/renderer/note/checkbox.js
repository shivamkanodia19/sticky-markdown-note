// checkbox.js
//
// Single-surface architecture change: checkboxes used to be parsed out of
// raw markdown text and custom-rendered/toggled by rewriting that raw
// source (see the old updateCheckboxState/handleCheckboxChange, now gone).
// Now #preview is the live, directly-editable DOM -- a checkbox is just a
// real <input type="checkbox"> living in that DOM, and toggling it IS the
// state change (nothing to sync back from a separate raw-text buffer).
//
// The only thing this module still owns is the marked renderer override that
// turns a GFM task-list marker ("- [ ] "/"- [x] ") into that real checkbox
// on load. contenteditable="false" on the <input> itself is what makes a
// checkbox inside a contenteditable region behave correctly: a click still
// toggles it (checkboxes handle their own click/keyboard toggling natively,
// independent of contenteditable), but the caret can't be placed *inside*
// it and typing can't merge text into it -- verified live (see note.js's
// checklist Enter-key handling and the worktree's manual test notes).
const marked = require('marked');

class CheckboxManager {
  constructor() {
    this.renderer = new marked.Renderer();
    this.renderer.checkbox = (checked) => {
      return `<input type="checkbox" contenteditable="false"${checked ? ' checked' : ''}>`;
    };
  }

  // Convert markdown to HTML, with GFM task-list items rendered as real,
  // toggleable checkbox inputs instead of marked's default plain-text
  // "[ ]"/"[x]" fallback.
  renderCheckboxes(markdown) {
    return marked.parse(markdown, { renderer: this.renderer });
  }
}

module.exports = CheckboxManager;
