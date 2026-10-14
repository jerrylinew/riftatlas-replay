/**
 * The marks panel: the steps of a replay someone marked, and their notes.
 *
 * Drawn by content/overlay.js beside replay mode's control bar, the same way
 * the reveals panel is (see shared/reveal-panel.js), in its own closed shadow
 * root. It never decides where it sits and never saves anything itself - the
 * caller places `element` and does the saving through the callbacks.
 *
 * A classic script rather than a module, so it can sit in front of the
 * overlay in the content scripts list.
 */
(() => {
  if (globalThis.riftatlasMarksPanel) return;

  const CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const PEN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const BIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const svg = (markup) => {
    const span = el('span', 'svg');
    span.innerHTML = markup;   // static, ours
    return span;
  };

  const iconButton = (markup, title, fn, cls = 'icon') => {
    const button = el('button', cls);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(svg(markup));
    button.onclick = fn;
    return button;
  };

  /** "Turn 5", or the phase before the first turn - "Mulligan", "Battlefield pick". */
  const whenLabel = (label) => {
    if (!label) return null;
    if (label.turn != null) return `Turn ${label.turn}`;
    if (!label.phase || label.phase === 'in_game') return null;
    const words = String(label.phase).replace(/_/g, ' ');
    return words[0].toUpperCase() + words.slice(1);
  };

  /**
   * A panel.
   *
   *   onClose()            the close button
   *   onJump(sequence)     a mark was picked; take the replay there
   *   onAdd()              "Mark this step"
   *   onSave(seq, text)    a note was written or changed; may return a promise
   *   onDelete(seq)        a mark was removed
   *   onTyping(on)         a note is being typed, or no longer is
   *
   * The library shows the same list in a page of its own, so it can turn off
   * what only makes sense beside a replay - the add button, the key hints, the
   * close button - and have it fill its column (`wide`). `jumpTitle` says what
   * picking a mark does there.
   */
  function create({
    onClose, onJump, onAdd, onSave, onDelete, onTyping,
    wide = false, addButton = true, keysHint = true, closeButton = true,
    title = 'Marks', jumpTitle = 'Go to this step', emptyText = null,
  }) {
    const element = document.createElement('div');
    element.style.cssText = 'all: initial; display: block;';
    if (wide) element.classList.add('wide');
    const root = element.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CSS;
    root.append(style);

    let marks = [];
    let current = null;      // the sequence the replay is showing
    let last = null;
    let labels = {};         // sequence -> { turn, phase, text }
    let error = null;
    let editing = null;      // the sequence whose note is open for writing
    let draft = '';
    let confirming = null;   // the sequence whose delete is waiting for a second press
    let drawn = null;
    let rendering = false;
    let shownCurrent = null;

    const markAt = (seq) => marks.find((m) => m.sequence === seq);

    function render(force) {
      const key = JSON.stringify([marks.map((m) => [m.sequence, m.text]), current, last, labels,
        editing, confirming, error]);
      if (!force && key === drawn) return;
      drawn = key;

      // Keep the reader's place: the scroll, and the caret if they are typing.
      const oldList = root.querySelector('.list');
      const scroll = oldList?.scrollTop ?? 0;
      const typing = isTyping();
      const area = root.querySelector('textarea');
      const caret = area ? [area.selectionStart, area.selectionEnd] : null;

      rendering = true;
      for (const node of [...root.childNodes]) if (node !== style) node.remove();
      const box = el('section', wide ? 'panel wide' : 'panel');
      // A page that titles the list itself, and has no buttons for it, needs no header.
      if (title || addButton || closeButton) box.append(header());
      if (error) box.append(el('p', 'error', error));
      if (!marks.length) {
        box.append(el('p', 'empty', emptyText
          ?? 'No marks yet. Press M, or ☆ on the bar, to mark the step you are on, and N to write a note there.'));
      } else {
        const list = el('ul', 'list');
        for (const mark of marks) list.append(row(mark));
        box.append(list);
      }
      if (keysHint) {
        const keys = el('p', 'keys');
        for (const [k, what] of [['M', 'mark'], ['N', 'note'], [',', 'previous'], ['.', 'next']]) {
          keys.append(el('kbd', null, k), ` ${what}  `);
        }
        box.append(keys);
      }
      root.append(box);

      const list = root.querySelector('.list');
      if (list) list.scrollTop = scroll;
      const fresh = root.querySelector('textarea');
      if (fresh && typing) {
        fresh.focus();
        if (caret) fresh.setSelectionRange(caret[0], caret[1]);
      }
      // Bring the step being shown into view when the replay moves to it.
      if (current !== shownCurrent && !fresh) {
        root.querySelector('.mark.here')?.scrollIntoView({ block: 'nearest' });
      }
      shownCurrent = current;
      rendering = false;
    }

    function header() {
      const head = el('header');
      const heading = el('h2', null, title);
      if (marks.length) heading.append(el('span', 'count', String(marks.length)));
      head.append(heading);
      if (addButton) {
        const here = markAt(current);
        const add = el('button', 'add', here ? 'Note this step' : 'Mark this step');
        add.type = 'button';
        add.title = here ? 'Write a note on the step you are on (N)' : 'Mark the step you are on (M)';
        add.onclick = () => (here ? edit(current) : onAdd?.());
        head.append(add);
      }
      if (closeButton) head.append(iconButton(CLOSE, 'Close', () => { stopEditing(); onClose?.(); }));
      return head;
    }

    function row(mark) {
      const li = el('li', 'mark');
      if (mark.sequence === current) li.classList.add('here');
      const label = labels[mark.sequence];

      const go = el('button', 'go');
      go.type = 'button';
      go.title = jumpTitle;
      const top = el('span', 'top');
      top.append(el('span', 'star', '★'),
        el('span', 'seq', last != null ? `${mark.sequence}/${last}` : String(mark.sequence)));
      const when = whenLabel(label);
      if (when) top.append(el('span', 'when', when));
      if (mark.source === 'live') {
        const live = el('span', 'live', 'live');
        live.title = 'Marked during the match';
        top.append(live);
      }
      go.append(top);
      if (label?.text) go.append(el('span', 'ctx', label.text));
      go.onclick = () => onJump?.(mark.sequence);

      const tools = el('span', 'tools');
      tools.append(iconButton(PEN, mark.text ? 'Edit the note' : 'Add a note', () => edit(mark.sequence)));
      if (confirming === mark.sequence) {
        const sure = el('button', 'sure', 'Delete');
        sure.type = 'button';
        sure.title = 'Press again to delete this mark and its note';
        sure.onclick = () => { confirming = null; onDelete?.(mark.sequence); };
        tools.append(sure);
      } else {
        tools.append(iconButton(BIN, 'Delete this mark', () => {
          // A bare mark goes at once; one with a note asks first.
          if (!mark.text) { onDelete?.(mark.sequence); return; }
          confirming = mark.sequence;
          render();
        }));
      }

      const line = el('div', 'line');
      line.append(go, tools);
      li.append(line);

      if (editing === mark.sequence) li.append(editor(mark));
      else if (mark.text) {
        const note = el('p', 'note', mark.text);
        note.title = 'Click to edit';
        note.onclick = () => edit(mark.sequence);
        li.append(note);
      }
      return li;
    }

    function editor(mark) {
      const wrap = el('div', 'editor');
      const area = el('textarea');
      area.value = draft;
      area.rows = 3;
      area.maxLength = 4000;
      area.placeholder = 'What happened here, and what would you do instead?';
      area.oninput = () => { draft = area.value; };
      area.onfocus = () => onTyping?.(true);
      area.onblur = () => {
        if (rendering) return;   // redrawn, not left
        onTyping?.(false);
        commit();
      };
      area.onkeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();   // close the note, not the panel
          stopEditing();
          render();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        }
      };

      const foot = el('div', 'foot');
      foot.append(el('span', 'hint', 'Ctrl+Enter to save · Esc to cancel'));
      const cancel = el('button', 'plain', 'Cancel');
      cancel.type = 'button';
      const save = el('button', 'save', 'Save');
      save.type = 'button';
      // Pressing these must not blur the note first, or the blur would save it.
      for (const b of [cancel, save]) b.onmousedown = (e) => e.preventDefault();
      cancel.onclick = () => { stopEditing(); render(); };
      save.onclick = () => commit();
      foot.append(cancel, save);
      wrap.append(area, foot);
      return wrap;
    }

    function edit(sequence) {
      const mark = markAt(sequence);
      if (editing === sequence) { root.querySelector('textarea')?.focus(); return; }
      commit();
      editing = sequence;
      draft = mark?.text ?? '';
      confirming = null;
      render(true);
      const area = root.querySelector('textarea');
      if (area) {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      }
    }

    function stopEditing() {
      if (editing != null) onTyping?.(false);
      editing = null;
      draft = '';
    }

    /** Save the open note if it changed, and close it. */
    function commit() {
      if (editing == null) return;
      const sequence = editing;
      const before = markAt(sequence)?.text ?? '';
      const text = draft.trim();
      stopEditing();
      render();
      if (text !== before) onSave?.(sequence, text);
    }

    function isTyping() {
      return root.activeElement instanceof HTMLTextAreaElement;
    }

    return {
      element,
      /** What to show. Any field left out keeps its value. */
      update(next = {}) {
        if ('marks' in next) marks = Array.isArray(next.marks) ? next.marks : [];
        if ('current' in next) current = next.current;
        if ('last' in next) last = next.last;
        if ('labels' in next) labels = next.labels ?? {};
        if ('error' in next) error = next.error ?? null;
        if (editing != null && !markAt(editing)) stopEditing();
        if (confirming != null && !markAt(confirming)) confirming = null;
        render();
      },
      /** Open the note on one step for writing. */
      edit,
      /** Close any open note, saving it, as when the panel is put away. */
      reset() { commit(); confirming = null; render(); },
      /** Save the open note (Ctrl+Enter), for a caller that takes the keys first. */
      save() { commit(); },
      /** Close the open note without saving (Escape). */
      cancel() { stopEditing(); render(); },
      isTyping,
    };
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid #74efff; outline-offset: 2px; }
    .svg { display: grid; place-items: center; }
    .panel { width: min(340px, calc(100vw - 32px)); max-height: min(460px, calc(100vh - 90px));
      display: flex; flex-direction: column; background: #0b1017; border: 1px solid #24313f;
      border-radius: 10px; padding: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.55); color: #dbe7f3;
      font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; text-align: left; }
    .panel.wide { width: 100%; max-height: none; box-shadow: none; background: transparent;
      border: 0; padding: 0; }
    .panel.wide .list { overflow: visible; }
    header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; color: #d8b76e; letter-spacing: .02em;
      display: flex; align-items: center; gap: 6px; }
    .count { padding: 0 6px; border-radius: 8px; background: #74efff; color: #0b1017;
      font-size: 10.5px; font-weight: 700; line-height: 16px; }
    .add { padding: 3px 9px; font-size: 11.5px; border-radius: 5px; border: 1px solid #d8b76e;
      background: rgba(216,183,110,.12); color: #d8b76e; }
    .add:hover { background: rgba(216,183,110,.22); }
    .icon { width: 26px; height: 26px; padding: 0; border-radius: 5px; border: 1px solid transparent;
      background: none; color: #8698ab; display: grid; place-items: center; flex: 0 0 auto; }
    .icon:hover { color: #dbe7f3; border-color: #24313f; }
    .empty { margin: 0 0 4px; color: #8698ab; font-size: 12px; }
    .error { margin: 0 0 8px; padding: 6px 8px; border-radius: 5px; font-size: 12px;
      color: #ffb59a; background: rgba(255,157,107,.1); border: 1px solid rgba(255,157,107,.35); }
    .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; overflow-y: auto;
      min-height: 0; }
    .mark { background: #121a24; border: 1px solid #24313f; border-radius: 6px; padding: 4px 4px 4px 0;
      border-left: 3px solid transparent; }
    .mark.here { border-color: #33465a; border-left-color: #d8b76e; }
    .line { display: flex; align-items: flex-start; gap: 2px; }
    .go { flex: 1; min-width: 0; text-align: left; display: grid; gap: 1px; padding: 3px 8px;
      background: none; border: 0; border-radius: 4px; }
    .go:hover .seq { color: #74efff; }
    .top { display: flex; align-items: baseline; gap: 7px; }
    .star { color: #d8b76e; }
    .seq { font-weight: 600; font-variant-numeric: tabular-nums; }
    .when { color: #8698ab; font-size: 11.5px; }
    .live { padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 700; color: #0b1017;
      background: #74efff; }
    .ctx { color: #7d8fa2; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tools { display: flex; gap: 0; flex: 0 0 auto; }
    .tools .icon { width: 24px; height: 24px; }
    .sure { padding: 2px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid #e5484d;
      background: rgba(229,72,77,.15); color: #ff8b8e; }
    .note { margin: 2px 8px 4px 12px; color: #dbe7f3; font-size: 12.5px; white-space: pre-wrap;
      overflow-wrap: anywhere; cursor: text; border-left: 2px solid #24313f; padding-left: 8px; }
    .note:hover { border-left-color: #d8b76e; }
    .editor { margin: 4px 4px 4px 12px; display: grid; gap: 6px; }
    textarea { width: 100%; resize: vertical; min-height: 64px; max-height: 240px; padding: 6px 8px;
      font: 12.5px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #dbe7f3;
      background: #0b1017; border: 1px solid #33465a; border-radius: 5px; }
    textarea:focus { border-color: #74efff; outline: none; }
    .foot { display: flex; align-items: center; gap: 6px; }
    .hint { flex: 1; color: #7d8fa2; font-size: 11px; }
    .plain, .save { padding: 2px 9px; font-size: 11.5px; border-radius: 4px; border: 1px solid #24313f;
      background: #16202c; color: #9fb0c2; }
    .save { border-color: #74efff; color: #dbe7f3; }
    .plain:hover { color: #dbe7f3; }
    .keys { margin: 8px 0 0; color: #5f7183; font-size: 10.5px; white-space: pre; }
    kbd { display: inline-block; min-width: 15px; padding: 0 4px; border: 1px solid #24313f;
      border-radius: 3px; background: #121a24; color: #9fb0c2; font: 600 10px/14px ui-monospace, monospace;
      text-align: center; }
  `;

  globalThis.riftatlasMarksPanel = { create };
})();
