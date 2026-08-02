// toast.js
//
// Shared, reusable toast/notification component for both the Note window
// and the Memo List window -- a bottom-of-window slide+fade-in strip that
// auto-dismisses and optionally carries a single action button (e.g.
// "Undo"). Generalized out of note.js's old one-off pattern of flipping a
// button's own textContent to "Copied!" for ~1200ms: that pattern lived
// *inside* the "..." dropdown menu, which the click handler hides
// immediately (moreMenu.classList.add('hidden')) -- so the text flip was
// actually invisible in the real UI, not just brief. A toast rendered at the
// body level, outside any menu/popover, fixes that for free while also
// making the pattern reusable for delete/undo.
//
// Plain classic script (no module system) loaded via a <script> tag before
// list.js / note.js, same as checkbox.js -- exposes a single global,
// window.showToast(message, options).
(function () {
  const DEFAULT_DURATION_MS = 2800;

  function ensureContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      // aria-live region: screen readers announce toast text as it appears,
      // matching the aria-label discipline the rest of this app already
      // follows for pin/ChatGPT/color state.
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
    }
    return container;
  }

  // Shows a toast with `message` and, optionally, a single action button.
  //
  // options:
  //   actionLabel: string   -- e.g. "Undo". Omit for a plain message toast.
  //   onAction: () => void  -- called once if the action button is clicked.
  //   duration: number (ms) -- auto-dismiss delay. Defaults to ~2.8s; the
  //                            caller should pass a longer value (e.g. 5000)
  //                            for a toast whose action carries real
  //                            consequences if missed (delete/undo).
  //
  // Returns { dismiss() } so a caller can dismiss it early if it needs to
  // (not currently used by any caller, but keeps the component honest as a
  // real reusable API rather than a fire-and-forget helper).
  function showToast(message, options) {
    const opts = options || {};
    const duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION_MS;
    const container = ensureContainer();

    const toast = document.createElement('div');
    toast.className = 'toast';

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    toast.appendChild(text);

    let actionBtn = null;
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'toast-action';
      actionBtn.textContent = opts.actionLabel;
      toast.appendChild(actionBtn);
    }

    container.appendChild(toast);

    // Force a reflow before adding the 'visible' class so the slide+fade-in
    // transition actually runs, instead of the toast just appearing already
    // in its end state (same reflow-forcing trick note.js's triggerSavePulse
    // already uses for the same reason).
    void toast.offsetWidth;
    toast.classList.add('visible');

    let settled = false;
    let dismissTimer = null;

    function remove() {
      toast.removeEventListener('transitionend', remove);
      toast.remove();
    }

    function dismiss() {
      if (settled) return;
      settled = true;
      clearTimeout(dismissTimer);
      toast.classList.remove('visible');
      toast.addEventListener('transitionend', remove, { once: true });
      // Fallback in case a transitionend never fires (e.g. the window loses
      // focus/repaints oddly) -- never leave a dead toast node behind.
      setTimeout(remove, 400);
    }

    if (actionBtn) {
      actionBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (settled) return;
        settled = true;
        clearTimeout(dismissTimer);
        opts.onAction();
        toast.classList.remove('visible');
        toast.addEventListener('transitionend', remove, { once: true });
        setTimeout(remove, 400);
      });
    }

    dismissTimer = setTimeout(dismiss, duration);

    return { dismiss };
  }

  window.showToast = showToast;
})();
