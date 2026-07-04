/* app.js — core engine (v2: editable boards, labels, WIP limits, archive,
   multi-checklists, time tracking, dependencies, table/calendar views). */

const state = {
  boards: [],
  currentBoardId: 'inbox',
  cardsCache: {},
  view: 'board',            // 'board' | 'dashboard'
  viewModeByBoard: {},      // boardId -> 'board' | 'table' | 'calendar'
  filters: { text: '', labelIds: [] },
  editingCardId: null,
  paletteIndex: 0,
  lastUndo: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ===================== INIT ===================== */

async function init() {
  applyStoredTheme();
  const lock = await getLockSettings();
  if (lock.enabled) {
    showLockScreen(() => continueInit());
  } else {
    await continueInit();
  }
}

async function continueInit() {
  await ensureSeedData();
  await runMigrations();
  state.boards = await DB.getAll('boards');
  bindGlobalEvents();
  renderSidebar();
  await switchToBoard('inbox');
  registerServiceWorker();
}

async function ensureSeedData() {
  const existing = await DB.getAll('boards');
  if (existing.length > 0) return;

  await DB.put('boards', {
    id: 'inbox',
    template_key: 'blank',
    name: 'Inbox',
    columns: cloneColumnsForBoard(['Unsorted', 'Triaged']),
    fields: cloneFieldsForBoard(BOARD_TEMPLATES.blank.fields),
    labels: defaultLabelsForBoard(),
    created_at: nowISO(),
  });

  const starters = [
    ['board_bb', 'bug_bounty', 'Bug bounty'],
    ['board_trading', 'trading', 'Trading'],
  ];
  for (const [id, key, name] of starters) {
    const tpl = BOARD_TEMPLATES[key];
    await DB.put('boards', {
      id, template_key: key, name,
      columns: cloneColumnsForBoard(tpl.columns),
      fields: cloneFieldsForBoard(tpl.fields),
      labels: defaultLabelsForBoard(),
      created_at: nowISO(),
    });
  }
}

/* ===================== THEME ===================== */

function applyStoredTheme() {
  const saved = localStorage.getItem('advtasks_theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    $('#theme-toggle-btn') && ($('#theme-toggle-btn').textContent = 'Dark mode');
  }
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('advtasks_theme', 'dark');
    $('#theme-toggle-btn').textContent = 'Light mode';
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('advtasks_theme', 'light');
    $('#theme-toggle-btn').textContent = 'Dark mode';
  }
}

/* ===================== SIDEBAR ===================== */

function renderSidebar() {
  const nav = $('#board-nav');
  nav.innerHTML = '';
  const customBoards = state.boards.filter((b) => b.id !== 'inbox');
  for (const b of customBoards) {
    const tpl = BOARD_TEMPLATES[b.template_key] || BOARD_TEMPLATES.blank;
    const btn = document.createElement('button');
    btn.className = 'side-nav-item' + (state.currentBoardId === b.id && state.view === 'board' ? ' active' : '');
    btn.dataset.board = b.id;
    btn.innerHTML = `<span class="dot" style="background:var(--${tpl.accent})"></span> ${escapeHtml(b.name)}`;
    btn.addEventListener('click', () => switchToBoard(b.id));
    nav.appendChild(btn);
  }
  $('#nav-dashboard').classList.toggle('active', state.view === 'dashboard');
  $('#nav-inbox').classList.toggle('active', state.currentBoardId === 'inbox' && state.view === 'board');
}

/* ===================== BOARD SWITCHING ===================== */

async function switchToBoard(boardId) {
  state.view = 'board';
  state.currentBoardId = boardId;
  state.filters = { text: '', labelIds: [] };
  $('#filter-text').value = '';
  $('#filter-bar').classList.add('hidden');
  $('#dashboard-view').hidden = true;
  closeSidebarMobile();

  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return;

  $('#board-title').textContent = board.name;
  await loadCardsForBoard(boardId);
  setViewToggleUI(state.viewModeByBoard[boardId] || 'board');
  renderFilterLabels(board);
  refreshCurrentBoardView();
  renderSidebar();
}

async function showDashboard() {
  state.view = 'dashboard';
  $('#board-view').hidden = true;
  $('#table-view-container').hidden = true;
  $('#calendar-view-container').hidden = true;
  $('#filter-bar').classList.add('hidden');
  $('#view-toggle').style.display = 'none';
  $('#dashboard-view').hidden = false;
  $('#board-title').textContent = 'dashboard';
  closeSidebarMobile();
  renderSidebar();
  await renderDashboard();
}

async function loadCardsForBoard(boardId) {
  const cards = await DB.getAllByIndex('cards', 'board_id', boardId);
  cards.sort((a, b) => a.position - b.position);
  state.cardsCache[boardId] = cards;
}

function getCurrentBoard() {
  return state.boards.find((b) => b.id === state.currentBoardId);
}

/* ===================== FILTERS ===================== */

function applyFilters(cards) {
  let out = cards.filter((c) => !c.archived);
  const text = state.filters.text.trim().toLowerCase();
  if (text) {
    out = out.filter((c) =>
      (c.title || '').toLowerCase().includes(text) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(text))
    );
  }
  if (state.filters.labelIds.length) {
    out = out.filter((c) => (c.label_ids || []).some((lid) => state.filters.labelIds.includes(lid)));
  }
  return out;
}

function renderFilterLabels(board) {
  const wrap = $('#filter-labels');
  wrap.innerHTML = '';
  (board.labels || []).forEach((lbl) => {
    const chip = el('button', { class: 'filter-label-chip' + (state.filters.labelIds.includes(lbl.id) ? ' active' : '') });
    chip.style.setProperty('--chip-color', lbl.color);
    chip.innerHTML = `<span class="label-dot" style="background:${lbl.color}"></span>${escapeHtml(lbl.name)}`;
    chip.addEventListener('click', () => {
      const idx = state.filters.labelIds.indexOf(lbl.id);
      if (idx >= 0) state.filters.labelIds.splice(idx, 1); else state.filters.labelIds.push(lbl.id);
      chip.classList.toggle('active');
      refreshCurrentBoardView();
    });
    wrap.appendChild(chip);
  });
}

/* ===================== VIEW MODE (board/table/calendar) ===================== */

function setViewToggleUI(mode) {
  $$('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#view-toggle').style.display = '';
}

function refreshCurrentBoardView() {
  const board = getCurrentBoard();
  if (!board || state.view !== 'board') return;
  const cards = applyFilters(state.cardsCache[board.id] || []);
  const mode = state.viewModeByBoard[board.id] || 'board';

  $('#board-view').hidden = mode !== 'board';
  $('#table-view-container').hidden = mode !== 'table';
  $('#calendar-view-container').hidden = mode !== 'calendar';

  if (mode === 'board') renderBoard(board, cards);
  else if (mode === 'table') {
    const c = $('#table-view-container'); c.innerHTML = ''; c.appendChild(renderTableView(board, cards));
  } else if (mode === 'calendar') {
    const c = $('#calendar-view-container'); c.innerHTML = ''; c.appendChild(renderCalendarView(board, cards));
  }
}

/* ===================== BOARD RENDERING ===================== */

function renderBoard(board, cardsOverride) {
  const container = $('#board-view');
  container.innerHTML = '';
  const cards = cardsOverride || applyFilters(state.cardsCache[board.id] || []);

  for (const col of board.columns) {
    const colCards = cards.filter((c) => c.list === col.id);
    const overLimit = col.wip_limit && colCards.length > col.wip_limit;
    const colEl = document.createElement('div');
    colEl.className = 'list-col';
    colEl.dataset.colId = col.id;

    colEl.innerHTML = `
      <div class="list-col-head">
        <span>${escapeHtml(col.name)}</span>
        <span class="list-count${overLimit ? ' over-limit' : ''}">${colCards.length}${col.wip_limit ? ' / ' + col.wip_limit : ''}</span>
      </div>
      <div class="list-col-body" data-col-id="${escapeAttr(col.id)}"></div>
      <div class="list-col-foot">
        <button class="add-card-btn" data-col-id="${escapeAttr(col.id)}">+ add card</button>
      </div>
    `;

    const body = colEl.querySelector('.list-col-body');
    for (const card of colCards) body.appendChild(renderCardEl(card, board));

    bindListDnD(colEl, body, board, col);
    colEl.querySelector('.add-card-btn').addEventListener('click', () => {
      openCardModal(null, { board_id: board.id, list: col.id });
    });

    container.appendChild(colEl);
  }

  const addColBtn = el('button', { class: 'add-column-btn' }, '+ add column');
  addColBtn.addEventListener('click', () => addColumnPrompt(board));
  container.appendChild(addColBtn);
}

function renderCardEl(card, board) {
  const tpl = BOARD_TEMPLATES[board.template_key] || BOARD_TEMPLATES.blank;
  const el2 = document.createElement('div');
  el2.className = 'task-card';
  el2.draggable = true;
  el2.dataset.cardId = card.id;
  el2.style.setProperty('--card-accent', `var(--${tpl.accent})`);

  const labelDots = (card.label_ids || [])
    .map((lid) => (board.labels || []).find((l) => l.id === lid))
    .filter(Boolean)
    .map((l) => `<span class="label-dot" style="background:${l.color}" title="${escapeAttr(l.name)}"></span>`)
    .join('');

  const chips = [];
  if (card.due_date) {
    const lastCol = board.columns[board.columns.length - 1];
    const overdue = new Date(card.due_date) < new Date() && card.list !== (lastCol && lastCol.id);
    chips.push(`<span class="chip ${overdue ? 'chip-overdue' : 'chip-due'}">${formatDateShort(card.due_date)}</span>`);
  }
  (card.tags || []).slice(0, 2).forEach((t) => chips.push(`<span class="chip">${escapeHtml(t)}</span>`));
  const primaryField = board.fields[0];
  if (primaryField && card.custom_fields && card.custom_fields[primaryField.key]) {
    chips.push(`<span class="chip">${escapeHtml(String(card.custom_fields[primaryField.key]))}</span>`);
  }
  if ((card.blocked_by || []).length) chips.push(`<span class="chip chip-blocked">⛔ blocked</span>`);
  if (isTimerRunning(card)) chips.push(`<span class="chip chip-timer">⏱ running</span>`);

  const totalItems = (card.checklists || []).reduce((s, cl) => s + cl.items.length, 0);
  const doneItems = (card.checklists || []).reduce((s, cl) => s + cl.items.filter((i) => i.done).length, 0);
  const checklistHtml = totalItems ? `<div class="task-card-checklist-progress">☑ ${doneItems}/${totalItems}</div>` : '';

  el2.innerHTML = `
    ${labelDots ? `<div class="label-dot-row">${labelDots}</div>` : ''}
    <div class="task-card-title">${escapeHtml(card.title || 'Untitled')}</div>
    <div class="task-card-meta">${chips.join('')}</div>
    ${checklistHtml}
  `;

  el2.addEventListener('click', () => openCardModal(card.id));
  el2.addEventListener('dragstart', (e) => {
    el2.classList.add('dragging');
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  el2.addEventListener('dragend', () => el2.classList.remove('dragging'));

  return el2;
}

function isTimerRunning(card) {
  return (card.time_entries || []).some((t) => t.ended_at === null);
}

/* ===================== DRAG AND DROP (cards) ===================== */

function bindListDnD(colEl, bodyEl, board, col) {
  bodyEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    colEl.classList.add('drag-over');
    const dragging = $('.task-card.dragging');
    if (!dragging) return;
    const after = getDragAfterElement(bodyEl, e.clientY);
    if (after == null) bodyEl.appendChild(dragging);
    else bodyEl.insertBefore(dragging, after);
  });
  bodyEl.addEventListener('dragleave', (e) => {
    if (!bodyEl.contains(e.relatedTarget)) colEl.classList.remove('drag-over');
  });
  bodyEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    colEl.classList.remove('drag-over');
    const cardId = e.dataTransfer.getData('text/plain');
    await moveCard(cardId, col, bodyEl, board);
  });
}

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.task-card:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: -Infinity, element: null }).element;
}

async function moveCard(cardId, targetCol, bodyEl, board) {
  const cards = state.cardsCache[board.id];
  const card = cards.find((c) => c.id === cardId);
  if (!card) return;

  const currentInTarget = cards.filter((c) => c.list === targetCol.id && c.id !== cardId).length;
  if (targetCol.wip_limit && currentInTarget >= targetCol.wip_limit) {
    if (!confirm(`"${targetCol.name}" has a WIP limit of ${targetCol.wip_limit}. Move anyway?`)) {
      renderBoard(board);
      return;
    }
  }

  const oldList = card.list;
  const oldPosition = card.position;
  card.list = targetCol.id;

  const orderedIds = [...bodyEl.querySelectorAll('.task-card')].map((n) => n.dataset.cardId);
  orderedIds.forEach((id, idx) => {
    const c = cards.find((cc) => cc.id === id);
    if (c) c.position = idx;
  });

  card.updated_at = nowISO();
  await DB.put('cards', card);
  for (const id of orderedIds) {
    const c = cards.find((cc) => cc.id === id);
    if (c) await DB.put('cards', c);
  }

  if (oldList !== targetCol.id) {
    await logActivity(card, `moved to "${targetCol.name}"`);
    state.lastUndo = {
      label: `Moved "${card.title || 'card'}" to ${targetCol.name}`,
      revert: async () => {
        card.list = oldList;
        card.position = oldPosition;
        await DB.put('cards', card);
        await loadCardsForBoard(board.id);
        refreshCurrentBoardView();
      },
    };
    showUndoToast(state.lastUndo.label, state.lastUndo.revert);
  }

  refreshCurrentBoardView();
}

/* ===================== COLUMN MANAGEMENT ===================== */

function addColumnPrompt(board) {
  const name = prompt('New column name:');
  if (!name || !name.trim()) return;
  board.columns.push({ id: uid('col'), name: name.trim(), wip_limit: null });
  DB.put('boards', board).then(() => refreshCurrentBoardView());
}

/* ===================== CARD MODAL ===================== */

function openCardModal(cardId, prefill = null) {
  state.editingCardId = cardId;
  const boardId = prefill ? prefill.board_id : state.currentBoardId;
  const board = state.boards.find((b) => b.id === boardId);

  let card;
  if (cardId) {
    card = state.cardsCache[boardId].find((c) => c.id === cardId);
  } else {
    card = {
      id: uid('card'),
      board_id: boardId,
      list: prefill.list,
      position: (state.cardsCache[boardId] || []).filter((c) => c.list === prefill.list).length,
      title: '', description: '',
      tags: [], label_ids: [],
      custom_fields: {},
      checklists: [],
      time_entries: [],
      blocks: [], blocked_by: [],
      linked_cards: [], attachments: [],
      created_at: nowISO(), updated_at: nowISO(),
      due_date: null, archived: false, archived_at: null,
    };
  }
  state._draftCard = card;
  state._draftIsNew = !cardId;
  state._draftBoard = board;

  $('#card-title-input').value = card.title;
  renderCardModalBody(card, board);
  $('#card-archive-btn').style.display = state._draftIsNew ? 'none' : 'inline-block';
  $('#card-modal').classList.remove('hidden');
  $('#card-title-input').focus();
}

function closeCardModal() {
  $('#card-modal').classList.add('hidden');
  state.editingCardId = null;
  state._draftCard = null;
}

function renderCardModalBody(card, board) {
  const body = $('#card-modal-body');
  body.innerHTML = '';

  body.appendChild(el('label', { class: 'field-label' }, 'Description'));
  const descArea = el('textarea', { class: 'textarea-input', placeholder: 'Notes, context, anything…' });
  descArea.value = card.description || '';
  descArea.addEventListener('input', () => { card.description = descArea.value; scheduleSave(); });
  body.appendChild(descArea);

  const row = el('div', { class: 'field-row' });
  const dueWrap = el('div');
  dueWrap.appendChild(el('label', { class: 'field-label' }, 'Due date'));
  const dueInput = el('input', { class: 'text-input', type: 'date' });
  dueInput.value = card.due_date ? card.due_date.slice(0, 10) : '';
  dueInput.addEventListener('change', () => { card.due_date = dueInput.value || null; scheduleSave(); });
  dueWrap.appendChild(dueInput);
  row.appendChild(dueWrap);

  const listWrap = el('div');
  listWrap.appendChild(el('label', { class: 'field-label' }, 'Column'));
  const listSelect = el('select', { class: 'text-input' });
  board.columns.forEach((c) => {
    const opt = el('option', { value: c.id }, c.name);
    if (c.id === card.list) opt.selected = true;
    listSelect.appendChild(opt);
  });
  listSelect.addEventListener('change', async () => {
    const oldList = card.list;
    const newCol = board.columns.find((c) => c.id === listSelect.value);
    card.list = newCol.id;
    card.position = (state.cardsCache[card.board_id] || []).filter((c) => c.list === card.list).length;
    if (oldList !== card.list) await logActivity(card, `moved to "${newCol.name}"`);
    scheduleSave(true);
  });
  listWrap.appendChild(listSelect);
  row.appendChild(listWrap);
  body.appendChild(row);

  body.appendChild(el('label', { class: 'field-label' }, 'Labels'));
  body.appendChild(renderLabelPicker(card, board));

  body.appendChild(el('label', { class: 'field-label' }, 'Tags'));
  body.appendChild(renderTagsInput(card));

  if (board.fields.length) {
    body.appendChild(el('label', { class: 'field-label' }, `${board.name} fields`));
    const fieldsWrap = el('div');
    fieldsWrap.style.display = 'grid';
    fieldsWrap.style.gridTemplateColumns = '1fr 1fr';
    fieldsWrap.style.gap = '4px 12px';
    board.fields.forEach((f) => {
      const w = el('div', { style: 'margin-bottom:10px;' });
      w.appendChild(el('label', { class: 'field-label', style: 'margin-top:0;' }, f.label));
      w.appendChild(renderCustomField(card, f));
      fieldsWrap.appendChild(w);
    });
    body.appendChild(fieldsWrap);
  }

  body.appendChild(el('label', { class: 'field-label' }, 'Checklists'));
  body.appendChild(renderChecklists(card));

  body.appendChild(el('label', { class: 'field-label' }, 'Time tracking'));
  body.appendChild(renderTimeTracking(card));

  body.appendChild(el('label', { class: 'field-label' }, 'Dependencies'));
  body.appendChild(renderDependencies(card, board));

  body.appendChild(el('label', { class: 'field-label' }, 'Attachments'));
  body.appendChild(renderAttachments(card));

  body.appendChild(el('label', { class: 'field-label' }, 'Activity'));
  body.appendChild(renderActivityLog(card));
}

function renderLabelPicker(card, board) {
  const wrap = el('div', { class: 'label-picker' });
  card.label_ids = card.label_ids || [];
  const draw = () => {
    wrap.innerHTML = '';
    (board.labels || []).forEach((lbl) => {
      const active = card.label_ids.includes(lbl.id);
      const chip = el('button', { class: 'label-pick-chip' + (active ? ' active' : '') });
      chip.style.setProperty('--chip-color', lbl.color);
      chip.innerHTML = `<span class="label-dot" style="background:${lbl.color}"></span>${escapeHtml(lbl.name)}`;
      chip.addEventListener('click', () => {
        const idx = card.label_ids.indexOf(lbl.id);
        if (idx >= 0) card.label_ids.splice(idx, 1); else card.label_ids.push(lbl.id);
        draw();
        scheduleSave();
      });
      wrap.appendChild(chip);
    });
    if (!(board.labels || []).length) {
      wrap.appendChild(el('div', { class: 'hint-text' }, 'No labels yet — add some in board settings.'));
    }
  };
  draw();
  return wrap;
}

function renderCustomField(card, f) {
  const val = card.custom_fields[f.key];
  let input;
  if (f.type === 'select') {
    input = el('select', { class: 'text-input' });
    input.appendChild(el('option', { value: '' }, '—'));
    (f.options || []).forEach((o) => {
      const opt = el('option', { value: o }, o);
      if (o === val) opt.selected = true;
      input.appendChild(opt);
    });
    input.addEventListener('change', () => { card.custom_fields[f.key] = input.value; scheduleSave(); });
  } else if (f.type === 'textarea') {
    input = el('textarea', { class: 'textarea-input', style: 'min-height:44px;' });
    input.value = val || '';
    input.addEventListener('input', () => { card.custom_fields[f.key] = input.value; scheduleSave(); });
  } else if (f.type === 'tags') {
    input = el('input', { class: 'text-input', placeholder: 'comma, separated' });
    input.value = Array.isArray(val) ? val.join(', ') : (val || '');
    input.addEventListener('input', () => {
      card.custom_fields[f.key] = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      scheduleSave();
    });
  } else {
    input = el('input', { class: 'text-input', type: f.type === 'number' ? 'number' : (f.type === 'url' ? 'url' : (f.type === 'date' ? 'date' : 'text')) });
    input.value = val ?? '';
    input.addEventListener('input', () => {
      card.custom_fields[f.key] = f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
      scheduleSave();
    });
  }
  return input;
}

function renderTagsInput(card) {
  const wrap = el('div', { class: 'tags-input-wrap' });
  const input = el('input', { placeholder: 'Add tag, press enter' });
  const rerenderPills = () => {
    wrap.querySelectorAll('.tag-pill').forEach((p) => p.remove());
    (card.tags || []).forEach((t, i) => {
      const pill = el('span', { class: 'tag-pill' });
      pill.appendChild(document.createTextNode(t));
      const rm = el('button', {}, '✕');
      rm.addEventListener('click', () => { card.tags.splice(i, 1); rerenderPills(); scheduleSave(); });
      pill.appendChild(rm);
      wrap.insertBefore(pill, input);
    });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      card.tags = card.tags || [];
      card.tags.push(input.value.trim());
      input.value = '';
      rerenderPills();
      scheduleSave();
    }
  });
  wrap.appendChild(input);
  rerenderPills();
  return wrap;
}

function renderChecklists(card) {
  const wrap = el('div', { class: 'checklists-wrap' });
  card.checklists = card.checklists || [];

  const draw = () => {
    wrap.innerHTML = '';
    card.checklists.forEach((cl, clIdx) => {
      const block = el('div', { class: 'checklist-block' });
      const head = el('div', { class: 'checklist-block-head' });
      const nameInput = el('input', { class: 'checklist-name-input', type: 'text' });
      nameInput.value = cl.name;
      nameInput.addEventListener('input', () => { cl.name = nameInput.value; scheduleSave(); });
      head.appendChild(nameInput);
      const done = cl.items.filter((i) => i.done).length;
      head.appendChild(el('span', { class: 'checklist-progress-label' }, `${done}/${cl.items.length}`));
      const rmCl = el('button', { class: 'remove-btn' }, '✕ remove list');
      rmCl.addEventListener('click', () => { card.checklists.splice(clIdx, 1); draw(); scheduleSave(); });
      head.appendChild(rmCl);
      block.appendChild(head);

      const itemsWrap = el('div');
      cl.items.forEach((item, i) => {
        const itemRow = el('div', { class: 'checklist-item' + (item.done ? ' done' : '') });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = item.done;
        cb.addEventListener('change', () => { item.done = cb.checked; itemRow.classList.toggle('done', cb.checked); redrawProgress(); scheduleSave(); });
        const txt = el('input', { type: 'text' });
        txt.value = item.text;
        txt.addEventListener('input', () => { item.text = txt.value; scheduleSave(); });
        const rm = el('button', { class: 'remove-btn' }, '✕');
        rm.addEventListener('click', () => { cl.items.splice(i, 1); draw(); scheduleSave(); });
        itemRow.appendChild(cb); itemRow.appendChild(txt); itemRow.appendChild(rm);
        itemsWrap.appendChild(itemRow);
      });
      block.appendChild(itemsWrap);

      const redrawProgress = () => {
        const d = cl.items.filter((i) => i.done).length;
        head.querySelector('.checklist-progress-label').textContent = `${d}/${cl.items.length}`;
      };

      const addItemBtn = el('button', { class: 'add-checklist-btn' }, '+ add item');
      addItemBtn.addEventListener('click', () => {
        cl.items.push({ id: uid('item'), text: '', done: false });
        draw();
        scheduleSave();
      });
      block.appendChild(addItemBtn);
      wrap.appendChild(block);
    });

    const addClBtn = el('button', { class: 'add-checklist-btn add-checklist-block-btn' }, '+ add checklist');
    addClBtn.addEventListener('click', () => {
      card.checklists.push({ id: uid('cl'), name: 'Checklist', items: [] });
      draw();
      scheduleSave();
    });
    wrap.appendChild(addClBtn);
  };
  draw();
  return wrap;
}

function renderTimeTracking(card) {
  const wrap = el('div', { class: 'time-tracking-wrap' });
  card.time_entries = card.time_entries || [];

  const draw = () => {
    wrap.innerHTML = '';
    const totalMs = totalTrackedMs(card);
    const running = card.time_entries.find((t) => t.ended_at === null);

    const summary = el('div', { class: 'time-summary' });
    summary.appendChild(el('span', { class: 'time-total' }, formatDuration(totalMs)));
    const btn = el('button', { class: running ? 'btn-danger-ghost' : 'btn-primary time-toggle-btn' }, running ? 'stop' : 'start');
    btn.addEventListener('click', async () => {
      if (running) running.ended_at = nowISO();
      else card.time_entries.push({ id: uid('t'), started_at: nowISO(), ended_at: null });
      draw();
      scheduleSave();
    });
    summary.appendChild(btn);
    wrap.appendChild(summary);

    if (card.time_entries.length) {
      const list = el('div', { class: 'time-entry-list' });
      [...card.time_entries].reverse().forEach((t) => {
        const durMs = (t.ended_at ? new Date(t.ended_at) : new Date()) - new Date(t.started_at);
        const row = el('div', { class: 'time-entry-row' },
          `${formatDateTimeShort(t.started_at)} → ${t.ended_at ? formatDateTimeShort(t.ended_at) : 'running'}  (${formatDuration(durMs)})`);
        list.appendChild(row);
      });
      wrap.appendChild(list);
    }
  };
  draw();
  return wrap;
}

function totalTrackedMs(card) {
  return (card.time_entries || []).reduce((sum, t) => {
    const end = t.ended_at ? new Date(t.ended_at) : new Date();
    return sum + (end - new Date(t.started_at));
  }, 0);
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0 && m === 0) return '<1m';
  return h ? `${h}h ${m}m` : `${m}m`;
}

function renderDependencies(card, board) {
  const wrap = el('div', { class: 'deps-wrap' });
  card.blocks = card.blocks || [];
  card.blocked_by = card.blocked_by || [];

  const section = (title, key, otherKey) => {
    const sec = el('div', { class: 'deps-section' });
    sec.appendChild(el('div', { class: 'deps-section-title' }, title));
    const chipRow = el('div', { class: 'deps-chip-row' });
    const draw = () => {
      chipRow.innerHTML = '';
      card[key].forEach((otherId) => {
        const other = (state.cardsCache[board.id] || []).find((c) => c.id === otherId);
        const chip = el('span', { class: 'tag-pill dep-chip' });
        chip.appendChild(document.createTextNode(other ? (other.title || 'Untitled') : '(deleted card)'));
        if (other) chip.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') openCardModal(other.id); });
        const rm = el('button', {}, '✕');
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          card[key] = card[key].filter((id) => id !== otherId);
          if (other) { other[otherKey] = (other[otherKey] || []).filter((id) => id !== card.id); await DB.put('cards', other); }
          draw();
          scheduleSave();
        });
        chip.appendChild(rm);
        chipRow.appendChild(chip);
      });
    };
    draw();
    sec.appendChild(chipRow);

    const searchWrap = el('div', { class: 'deps-search-wrap' });
    const input = el('input', { class: 'text-input', placeholder: 'Search cards on this board…' });
    const results = el('div', { class: 'deps-search-results' });
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      results.innerHTML = '';
      if (!q) return;
      const candidates = (state.cardsCache[board.id] || [])
        .filter((c) => c.id !== card.id && !card[key].includes(c.id) && (c.title || '').toLowerCase().includes(q))
        .slice(0, 6);
      candidates.forEach((c) => {
        const row = el('div', { class: 'deps-search-result' }, c.title || 'Untitled');
        row.addEventListener('click', async () => {
          card[key].push(c.id);
          c[otherKey] = c[otherKey] || [];
          if (!c[otherKey].includes(card.id)) c[otherKey].push(card.id);
          await DB.put('cards', c);
          input.value = ''; results.innerHTML = '';
          draw();
          scheduleSave();
        });
        results.appendChild(row);
      });
    });
    searchWrap.appendChild(input);
    searchWrap.appendChild(results);
    sec.appendChild(searchWrap);
    return sec;
  };

  wrap.appendChild(section('Blocked by', 'blocked_by', 'blocks'));
  wrap.appendChild(section('Blocks', 'blocks', 'blocked_by'));
  return wrap;
}

function renderAttachments(card) {
  const wrap = el('div', { class: 'attachment-list' });
  const draw = () => {
    wrap.innerHTML = '';
    (card.attachments || []).forEach((a, i) => {
      const item = el('div', { class: 'attachment-item' });
      if (a.type && a.type.startsWith('image/')) {
        const img = el('img'); img.src = a.dataUrl;
        item.appendChild(img);
      } else {
        item.appendChild(el('div', { class: 'file-chip' }, a.name));
      }
      const rm = el('button', {}, '✕');
      rm.addEventListener('click', () => { card.attachments.splice(i, 1); draw(); scheduleSave(); });
      item.appendChild(rm);
      wrap.appendChild(item);
    });
    const addBtn = el('label', { class: 'add-attachment-btn' }, '+');
    const fileInput = el('input', { type: 'file', hidden: true, multiple: true });
    fileInput.addEventListener('change', async () => {
      for (const f of fileInput.files) {
        const dataUrl = await fileToDataUrl(f);
        card.attachments = card.attachments || [];
        card.attachments.push({ id: uid('att'), name: f.name, type: f.type, dataUrl });
      }
      draw();
      scheduleSave();
    });
    addBtn.appendChild(fileInput);
    wrap.appendChild(addBtn);
  };
  draw();
  return wrap;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderActivityLog(card) {
  const wrap = el('div', { class: 'activity-log' });
  DB.getAllByIndex('activity', 'card_id', card.id).then((entries) => {
    entries.sort((a, b) => new Date(b.at) - new Date(a.at));
    if (!entries.length) {
      wrap.appendChild(el('div', { class: 'activity-entry' }, 'No activity yet.'));
      return;
    }
    entries.slice(0, 12).forEach((e2) => {
      wrap.appendChild(el('div', { class: 'activity-entry' }, `${formatDateTimeShort(e2.at)} — ${e2.text}`));
    });
  });
  return wrap;
}

async function logActivity(card, text) {
  await DB.put('activity', { id: uid('act'), card_id: card.id, board_id: card.board_id, text, at: nowISO() });
}

let saveTimer = null;
function scheduleSave(immediate = false) {
  const hint = $('#card-save-hint');
  clearTimeout(saveTimer);
  const doSave = async () => {
    const card = state._draftCard;
    if (!card) return;
    card.updated_at = nowISO();
    await DB.put('cards', card);
    const cache = state.cardsCache[card.board_id] || [];
    const idx = cache.findIndex((c) => c.id === card.id);
    if (idx >= 0) cache[idx] = card; else cache.push(card);
    hint.textContent = 'saved';
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 1200);
    if (state.view === 'board' && state.currentBoardId === card.board_id) refreshCurrentBoardView();
  };
  if (immediate) doSave(); else saveTimer = setTimeout(doSave, 400);
}

async function saveCardTitleAndClose() {
  const card = state._draftCard;
  if (!card) { closeCardModal(); return; }
  card.title = $('#card-title-input').value.trim();
  const isEmptyNew = state._draftIsNew && !card.title && !card.description &&
    (!card.checklists || !card.checklists.length);
  if (isEmptyNew) { closeCardModal(); return; }

  card.updated_at = nowISO();
  await DB.put('cards', card);
  const cache = state.cardsCache[card.board_id] || (state.cardsCache[card.board_id] = []);
  const idx = cache.findIndex((c) => c.id === card.id);
  if (idx >= 0) cache[idx] = card; else cache.push(card);

  if (state._draftIsNew) {
    const board = state.boards.find((b) => b.id === card.board_id);
    const col = board.columns.find((c) => c.id === card.list);
    await logActivity(card, `created in "${col ? col.name : card.list}"`);
  }

  closeCardModal();
  if (state.view === 'board' && state.currentBoardId === card.board_id) refreshCurrentBoardView();
  rebuildSearchIndex();
}

async function archiveCurrentCard() {
  const card = state._draftCard;
  if (!card || state._draftIsNew) { closeCardModal(); return; }
  card.archived = true;
  card.archived_at = nowISO();
  await DB.put('cards', card);
  await logActivity(card, 'archived');
  closeCardModal();
  refreshCurrentBoardView();

  state.lastUndo = {
    label: `Archived "${card.title || 'card'}"`,
    revert: async () => {
      card.archived = false;
      card.archived_at = null;
      await DB.put('cards', card);
      refreshCurrentBoardView();
    },
  };
  showUndoToast(state.lastUndo.label, state.lastUndo.revert);
  rebuildSearchIndex();
}

async function restoreCard(cardId, boardId) {
  const card = await DB.get('cards', cardId);
  if (!card) return;
  card.archived = false;
  card.archived_at = null;
  await DB.put('cards', card);
  await loadCardsForBoard(boardId);
  await logActivity(card, 'restored from archive');
  showToast('Card restored');
  refreshCurrentBoardView();
  rebuildSearchIndex();
}

async function deleteCardForever(cardId, boardId) {
  if (!confirm('Permanently delete this card? This cannot be undone.')) return;
  await DB.delete('cards', cardId);
  await loadCardsForBoard(boardId);
  showToast('Card permanently deleted');
  refreshCurrentBoardView();
  rebuildSearchIndex();
}

/* ===================== UNDO TOAST ===================== */

function showUndoToast(label, revertFn) {
  const t = el('div', { class: 'toast toast-undo' });
  t.appendChild(el('span', {}, label));
  const btn = el('button', { class: 'toast-undo-btn' }, 'undo');
  btn.addEventListener('click', async () => { await revertFn(); t.remove(); });
  t.appendChild(btn);
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

/* ===================== NEW BOARD MODAL ===================== */

function openBoardModal() {
  const grid = $('#template-grid');
  grid.innerHTML = '';
  state._selectedTemplate = 'bug_bounty';
  TEMPLATE_ORDER.forEach((key) => {
    const tpl = BOARD_TEMPLATES[key];
    const opt = el('div', { class: 'template-option' + (key === state._selectedTemplate ? ' selected' : '') });
    opt.style.setProperty('--tpl-accent', `var(--${tpl.accent})`);
    opt.appendChild(el('div', { class: 'template-option-label' }, tpl.label));
    opt.appendChild(el('div', { class: 'template-option-cols' }, tpl.columns.join(' · ')));
    opt.addEventListener('click', () => {
      state._selectedTemplate = key;
      grid.querySelectorAll('.template-option').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      if (!$('#new-board-name').value) $('#new-board-name').placeholder = `e.g. My ${tpl.label}`;
    });
    grid.appendChild(opt);
  });
  $('#new-board-name').value = '';
  $('#board-modal').classList.remove('hidden');
  $('#new-board-name').focus();
}

async function createBoardFromModal() {
  const name = $('#new-board-name').value.trim();
  if (!name) { showToast('Give the board a name', true); return; }
  const key = state._selectedTemplate || 'blank';
  const tpl = BOARD_TEMPLATES[key];
  const board = {
    id: uid('board'), template_key: key, name,
    columns: cloneColumnsForBoard(tpl.columns),
    fields: cloneFieldsForBoard(tpl.fields),
    labels: defaultLabelsForBoard(),
    created_at: nowISO(),
  };
  await DB.put('boards', board);
  state.boards.push(board);
  $('#board-modal').classList.add('hidden');
  renderSidebar();
  await switchToBoard(board.id);
  showToast(`Board "${name}" created`);
}

/* ===================== BOARD SETTINGS MODAL ===================== */

const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'date', 'url', 'tags'];

function openBoardSettingsModal() {
  const board = getCurrentBoard();
  if (!board || board.id === 'inbox') { showToast('Inbox settings are minimal — try a custom board', true); }
  if (!board) return;
  renderBoardSettingsBody(board);
  $('#board-settings-modal').classList.remove('hidden');
}

function renderBoardSettingsBody(board) {
  const body = $('#settings-modal-body');
  body.innerHTML = '';

  body.appendChild(el('label', { class: 'field-label' }, 'Board name'));
  const nameInput = el('input', { class: 'text-input' });
  nameInput.value = board.name;
  nameInput.addEventListener('input', async () => { board.name = nameInput.value; await DB.put('boards', board); renderSidebar(); $('#board-title').textContent = board.name; });
  body.appendChild(nameInput);

  // Columns
  body.appendChild(el('label', { class: 'field-label' }, 'Columns'));
  const colsWrap = el('div', { class: 'settings-list' });
  const drawCols = () => {
    colsWrap.innerHTML = '';
    board.columns.forEach((col, i) => {
      const row = el('div', { class: 'settings-row' });
      const nameIn = el('input', { class: 'text-input' });
      nameIn.value = col.name;
      nameIn.addEventListener('input', async () => { col.name = nameIn.value; await DB.put('boards', board); refreshCurrentBoardView(); });
      const wipIn = el('input', { class: 'text-input wip-input', type: 'number', placeholder: 'WIP' });
      wipIn.value = col.wip_limit ?? '';
      wipIn.addEventListener('input', async () => { col.wip_limit = wipIn.value === '' ? null : Number(wipIn.value); await DB.put('boards', board); refreshCurrentBoardView(); });
      const upBtn = el('button', { class: 'icon-btn small' }, '↑');
      upBtn.disabled = i === 0;
      upBtn.addEventListener('click', async () => { [board.columns[i - 1], board.columns[i]] = [board.columns[i], board.columns[i - 1]]; await DB.put('boards', board); drawCols(); refreshCurrentBoardView(); });
      const downBtn = el('button', { class: 'icon-btn small' }, '↓');
      downBtn.disabled = i === board.columns.length - 1;
      downBtn.addEventListener('click', async () => { [board.columns[i + 1], board.columns[i]] = [board.columns[i], board.columns[i + 1]]; await DB.put('boards', board); drawCols(); refreshCurrentBoardView(); });
      const delBtn = el('button', { class: 'remove-btn' }, '✕');
      delBtn.addEventListener('click', async () => {
        const cardsInCol = (state.cardsCache[board.id] || []).filter((c) => c.list === col.id && !c.archived);
        if (cardsInCol.length && board.columns.length > 1) {
          const targetName = prompt(`"${col.name}" has ${cardsInCol.length} card(s). Type the exact name of another column to move them to before deleting:`);
          const targetCol = board.columns.find((c) => c.name === targetName && c.id !== col.id);
          if (!targetCol) { showToast('Column not found — deletion cancelled', true); return; }
          for (const c of cardsInCol) { c.list = targetCol.id; await DB.put('cards', c); }
          await loadCardsForBoard(board.id);
        } else if (board.columns.length <= 1) {
          showToast('A board needs at least one column', true);
          return;
        }
        board.columns.splice(i, 1);
        await DB.put('boards', board);
        drawCols();
        refreshCurrentBoardView();
      });
      row.appendChild(nameIn); row.appendChild(wipIn); row.appendChild(upBtn); row.appendChild(downBtn); row.appendChild(delBtn);
      colsWrap.appendChild(row);
    });
  };
  drawCols();
  body.appendChild(colsWrap);
  const addColBtn = el('button', { class: 'add-checklist-btn' }, '+ add column');
  addColBtn.addEventListener('click', async () => {
    board.columns.push({ id: uid('col'), name: 'New column', wip_limit: null });
    await DB.put('boards', board);
    drawCols();
    refreshCurrentBoardView();
  });
  body.appendChild(addColBtn);

  // Fields
  body.appendChild(el('label', { class: 'field-label' }, 'Custom fields'));
  const fieldsWrap = el('div', { class: 'settings-list' });
  const drawFields = () => {
    fieldsWrap.innerHTML = '';
    board.fields.forEach((f, i) => {
      const row = el('div', { class: 'settings-row settings-row-field' });
      const labelIn = el('input', { class: 'text-input', placeholder: 'Field label' });
      labelIn.value = f.label;
      labelIn.addEventListener('input', async () => { f.label = labelIn.value; await DB.put('boards', board); });
      const typeSel = el('select', { class: 'text-input' });
      FIELD_TYPES.forEach((t) => { const o = el('option', { value: t }, t); if (t === f.type) o.selected = true; typeSel.appendChild(o); });
      typeSel.addEventListener('change', async () => { f.type = typeSel.value; await DB.put('boards', board); drawFields(); });
      const delBtn = el('button', { class: 'remove-btn' }, '✕');
      delBtn.addEventListener('click', async () => { board.fields.splice(i, 1); await DB.put('boards', board); drawFields(); });
      row.appendChild(labelIn); row.appendChild(typeSel); row.appendChild(delBtn);
      fieldsWrap.appendChild(row);
      if (f.type === 'select') {
        const optsIn = el('input', { class: 'text-input', placeholder: 'Options, comma separated' });
        optsIn.value = (f.options || []).join(', ');
        optsIn.addEventListener('input', async () => { f.options = optsIn.value.split(',').map((s) => s.trim()).filter(Boolean); await DB.put('boards', board); });
        fieldsWrap.appendChild(optsIn);
      }
    });
  };
  drawFields();
  body.appendChild(fieldsWrap);
  const addFieldBtn = el('button', { class: 'add-checklist-btn' }, '+ add field');
  addFieldBtn.addEventListener('click', async () => {
    board.fields.push({ id: uid('fld'), key: uid('key'), label: 'New field', type: 'text' });
    await DB.put('boards', board);
    drawFields();
  });
  body.appendChild(addFieldBtn);

  // Labels
  body.appendChild(el('label', { class: 'field-label' }, 'Labels'));
  const labelsWrap = el('div', { class: 'settings-list' });
  const drawLabels = () => {
    labelsWrap.innerHTML = '';
    (board.labels || []).forEach((lbl, i) => {
      const row = el('div', { class: 'settings-row' });
      const swatch = el('button', { class: 'label-swatch-btn', style: `background:${lbl.color}` });
      let paletteIdx = LABEL_PALETTE.findIndex((p) => p.color === lbl.color);
      swatch.addEventListener('click', async () => {
        paletteIdx = (paletteIdx + 1) % LABEL_PALETTE.length;
        lbl.color = LABEL_PALETTE[paletteIdx].color;
        swatch.style.background = lbl.color;
        await DB.put('boards', board);
        refreshCurrentBoardView();
      });
      const nameIn = el('input', { class: 'text-input' });
      nameIn.value = lbl.name;
      nameIn.addEventListener('input', async () => { lbl.name = nameIn.value; await DB.put('boards', board); refreshCurrentBoardView(); });
      const delBtn = el('button', { class: 'remove-btn' }, '✕');
      delBtn.addEventListener('click', async () => {
        board.labels.splice(i, 1);
        await DB.put('boards', board);
        drawLabels();
        refreshCurrentBoardView();
      });
      row.appendChild(swatch); row.appendChild(nameIn); row.appendChild(delBtn);
      labelsWrap.appendChild(row);
    });
  };
  drawLabels();
  body.appendChild(labelsWrap);
  const addLabelBtn = el('button', { class: 'add-checklist-btn' }, '+ add label');
  addLabelBtn.addEventListener('click', async () => {
    const palette = LABEL_PALETTE[(board.labels || []).length % LABEL_PALETTE.length];
    board.labels = board.labels || [];
    board.labels.push({ id: uid('lbl'), name: 'new label', color: palette.color });
    await DB.put('boards', board);
    drawLabels();
  });
  body.appendChild(addLabelBtn);
}

async function deleteCurrentBoard() {
  const board = getCurrentBoard();
  if (!board || board.id === 'inbox') { showToast("Can't delete the inbox", true); return; }
  if (!confirm(`Delete board "${board.name}" and all its cards? This cannot be undone.`)) return;
  const cards = await DB.getAllByIndex('cards', 'board_id', board.id);
  for (const c of cards) {
    await DB.delete('cards', c.id);
    const acts = await DB.getAllByIndex('activity', 'card_id', c.id);
    for (const a of acts) await DB.delete('activity', a.id);
  }
  await DB.delete('boards', board.id);
  state.boards = state.boards.filter((b) => b.id !== board.id);
  $('#board-settings-modal').classList.add('hidden');
  renderSidebar();
  await switchToBoard('inbox');
  showToast('Board deleted');
  rebuildSearchIndex();
}

/* ===================== ARCHIVE MODAL ===================== */

async function openArchiveModal() {
  const board = getCurrentBoard();
  if (!board) return;
  const allCards = await DB.getAllByIndex('cards', 'board_id', board.id);
  const archived = allCards.filter((c) => c.archived);
  const body = $('#archive-modal-body');
  body.innerHTML = '';
  if (!archived.length) {
    body.appendChild(el('div', { class: 'dash-empty' }, 'No archived cards on this board.'));
  } else {
    archived.forEach((c) => {
      const row = el('div', { class: 'archive-row' });
      row.appendChild(el('span', { class: 'archive-row-title' }, c.title || 'Untitled'));
      const restoreBtn = el('button', { class: 'side-action ghost small' }, 'restore');
      restoreBtn.addEventListener('click', async () => { await restoreCard(c.id, board.id); openArchiveModal(); });
      const delBtn = el('button', { class: 'btn-danger-ghost small' }, 'delete forever');
      delBtn.addEventListener('click', async () => { await deleteCardForever(c.id, board.id); openArchiveModal(); });
      row.appendChild(restoreBtn); row.appendChild(delBtn);
      body.appendChild(row);
    });
  }
  $('#archive-modal').classList.remove('hidden');
}

/* ===================== CSV EXPORT ===================== */

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function exportBoardCSV() {
  const board = getCurrentBoard();
  if (!board) return;
  const cards = (state.cardsCache[board.id] || []).filter((c) => !c.archived);
  const headers = ['Title', 'Column', 'Due date', 'Labels', 'Tags', ...board.fields.map((f) => f.label), 'Checklist done/total', 'Created', 'Updated'];
  const rows = [headers];
  cards.forEach((c) => {
    const col = board.columns.find((cc) => cc.id === c.list);
    const labels = (c.label_ids || []).map((lid) => { const l = board.labels.find((x) => x.id === lid); return l ? l.name : ''; }).filter(Boolean).join('; ');
    const totalItems = (c.checklists || []).reduce((s, cl) => s + cl.items.length, 0);
    const doneItems = (c.checklists || []).reduce((s, cl) => s + cl.items.filter((i) => i.done).length, 0);
    const row = [
      c.title || '', col ? col.name : '', c.due_date || '', labels, (c.tags || []).join('; '),
      ...board.fields.map((f) => {
        const v = c.custom_fields[f.key];
        return Array.isArray(v) ? v.join('; ') : (v ?? '');
      }),
      `${doneItems}/${totalItems}`, c.created_at, c.updated_at,
    ];
    rows.push(row);
  });
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${board.name.replace(/\s+/g, '_')}-export.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('CSV exported');
}

/* ===================== APP LOCK MODAL ===================== */

async function openLockSetupModal() {
  const body = $('#lock-setup-body');
  body.innerHTML = '';
  const settings = await getLockSettings();

  if (settings.enabled) {
    body.appendChild(el('div', { class: 'hint-text' }, 'App lock is currently ON.'));
    const disableBtn = el('button', { class: 'btn-danger-ghost', style: 'margin-top:10px;' }, 'disable app lock');
    disableBtn.addEventListener('click', async () => { await disablePasscode(); openLockSetupModal(); showToast('App lock disabled'); });
    body.appendChild(disableBtn);
  } else {
    body.appendChild(el('div', { class: 'hint-text' }, 'Sets a local passcode required to open the app. There is no recovery — if forgotten, the only fix is clearing this app\'s local data, which deletes everything.'));
    const input = el('input', { class: 'text-input', type: 'password', placeholder: 'Choose a passcode', style: 'margin-top:10px;' });
    const confirmInput = el('input', { class: 'text-input', type: 'password', placeholder: 'Confirm passcode', style: 'margin-top:8px;' });
    const setBtn = el('button', { class: 'btn-primary', style: 'margin-top:10px;' }, 'enable app lock');
    setBtn.addEventListener('click', async () => {
      if (!input.value || input.value.length < 4) { showToast('Use at least 4 characters', true); return; }
      if (input.value !== confirmInput.value) { showToast('Passcodes do not match', true); return; }
      await setPasscode(input.value);
      showToast('App lock enabled');
      $('#lock-setup-modal').classList.add('hidden');
    });
    body.appendChild(input); body.appendChild(confirmInput); body.appendChild(setBtn);
  }
}

/* ===================== SEARCH / COMMAND PALETTE ===================== */

let searchIndex = [];

async function rebuildSearchIndex() {
  const allCards = await DB.getAll('cards');
  searchIndex = allCards.filter((c) => !c.archived).map((c) => ({
    id: c.id, board_id: c.board_id,
    text: `${c.title} ${c.description || ''} ${(c.tags || []).join(' ')}`.toLowerCase(),
    title: c.title, list: c.list,
  }));
}

function openPalette() {
  $('#command-palette').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  renderPaletteResults('');
  input.focus();
}
function closePalette() { $('#command-palette').classList.add('hidden'); }

function renderPaletteResults(query) {
  const results = $('#palette-results');
  results.innerHTML = '';
  state.paletteIndex = 0;
  const q = query.trim().toLowerCase();
  const items = [];

  if (!q || 'new board'.includes(q) || 'board'.includes(q)) items.push({ label: '+ create new board', run: () => { closePalette(); openBoardModal(); } });
  if (!q || 'dashboard'.includes(q) || 'stats'.includes(q)) items.push({ label: '→ go to dashboard', run: () => { closePalette(); showDashboard(); } });
  if (!q || 'export'.includes(q)) items.push({ label: '↓ export all data', run: () => { closePalette(); exportData(); } });
  if (!q || 'settings'.includes(q)) items.push({ label: '⚙ board settings', run: () => { closePalette(); openBoardSettingsModal(); } });

  if (q) {
    state.boards.forEach((b) => {
      if (b.name.toLowerCase().includes(q)) items.push({ label: `→ ${b.name}`, meta: 'board', run: () => { closePalette(); switchToBoard(b.id); } });
    });
    searchIndex.filter((c) => c.text.includes(q)).slice(0, 20).forEach((c) => {
      const board = state.boards.find((b) => b.id === c.board_id);
      items.push({
        label: c.title || 'Untitled', meta: board ? board.name : '',
        run: async () => { closePalette(); await switchToBoard(c.board_id); openCardModal(c.id); },
      });
    });
  }

  if (!items.length) { results.appendChild(el('div', { class: 'palette-empty' }, 'No matches.')); return; }

  items.forEach((item, i) => {
    const row = el('div', { class: 'palette-item' + (i === 0 ? ' hover' : '') });
    row.appendChild(el('span', { class: 'p-label' }, item.label));
    if (item.meta) row.appendChild(el('span', { class: 'p-meta' }, item.meta));
    row.addEventListener('click', item.run);
    row.addEventListener('mouseenter', () => { results.querySelectorAll('.palette-item').forEach((r) => r.classList.remove('hover')); row.classList.add('hover'); state.paletteIndex = i; });
    results.appendChild(row);
  });
  state._paletteItems = items;
}

function palettePressEnter() { const items = state._paletteItems || []; const item = items[state.paletteIndex]; if (item) item.run(); }
function paletteMove(delta) {
  const items = state._paletteItems || [];
  if (!items.length) return;
  state.paletteIndex = (state.paletteIndex + delta + items.length) % items.length;
  $$('.palette-item').forEach((r, i) => r.classList.toggle('hover', i === state.paletteIndex));
  const activeEl = $$('.palette-item')[state.paletteIndex];
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

/* ===================== QUICK ADD ===================== */

function quickAddCard() {
  if (state.view === 'dashboard') { switchToBoard('inbox').then(() => quickAddCard()); return; }
  const board = getCurrentBoard();
  openCardModal(null, { board_id: board.id, list: board.columns[0].id });
}

/* ===================== EXPORT / IMPORT (full data) ===================== */

async function exportData() {
  const data = await DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url; a.download = `advtasks-export-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('Data exported');
}

async function importDataFromFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const wipe = confirm('Import data:\n\nOK = merge with existing data\nCancel = wipe existing data first, then import');
    await DB.importAll(data, { wipe: !wipe });
    await runMigrations();
    state.boards = await DB.getAll('boards');
    await rebuildSearchIndex();
    renderSidebar();
    await switchToBoard(state.boards[0] ? state.boards[0].id : 'inbox');
    showToast('Data imported');
  } catch (err) {
    console.error(err);
    showToast('Import failed — invalid file', true);
  }
}

/* ===================== TOAST ===================== */

function showToast(msg, isErr = false) {
  const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ===================== UTIL ===================== */

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'string') node.style.cssText = v;
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function formatDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatDateTimeShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function closeSidebarMobile() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-scrim').classList.remove('show');
}

/* ===================== SERVICE WORKER ===================== */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ===================== EVENT BINDING ===================== */

function bindGlobalEvents() {
  $('#nav-dashboard').addEventListener('click', showDashboard);
  $('#nav-inbox').addEventListener('click', () => switchToBoard('inbox'));
  $('#new-board-btn').addEventListener('click', openBoardModal);
  $('#board-modal-close-btn').addEventListener('click', () => $('#board-modal').classList.add('hidden'));
  $('#create-board-btn').addEventListener('click', createBoardFromModal);

  $('#quick-add-btn').addEventListener('click', quickAddCard);
  $('#search-btn').addEventListener('click', openPalette);

  $('#card-close-btn').addEventListener('click', saveCardTitleAndClose);
  $('#card-archive-btn').addEventListener('click', archiveCurrentCard);
  $('#card-title-input').addEventListener('input', () => { if (state._draftCard) { state._draftCard.title = $('#card-title-input').value; scheduleSave(); } });
  $('#card-modal').addEventListener('click', (e) => { if (e.target.id === 'card-modal') saveCardTitleAndClose(); });
  $('#board-modal').addEventListener('click', (e) => { if (e.target.id === 'board-modal') $('#board-modal').classList.add('hidden'); });

  $('#export-btn').addEventListener('click', exportData);
  $('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importDataFromFile(e.target.files[0]); e.target.value = ''; });
  $('#theme-toggle-btn').addEventListener('click', toggleTheme);

  $('#menu-btn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#sidebar-scrim').classList.add('show'); });
  $('#sidebar-collapse-btn').addEventListener('click', closeSidebarMobile);
  $('#sidebar-scrim').addEventListener('click', closeSidebarMobile);

  $('#board-title').addEventListener('click', () => {
    if (state.view !== 'board' || state.currentBoardId === 'inbox') return;
    $('#board-title').setAttribute('contenteditable', 'true');
    $('#board-title').focus();
  });
  $('#board-title').addEventListener('blur', async () => {
    const titleEl = $('#board-title');
    if (titleEl.getAttribute('contenteditable') !== 'true') return;
    titleEl.setAttribute('contenteditable', 'false');
    const board = getCurrentBoard();
    if (board && titleEl.textContent.trim() && titleEl.textContent.trim() !== board.name) {
      board.name = titleEl.textContent.trim();
      await DB.put('boards', board);
      renderSidebar();
    }
  });

  $$('.view-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewModeByBoard[state.currentBoardId] = btn.dataset.mode;
      setViewToggleUI(btn.dataset.mode);
      refreshCurrentBoardView();
    });
  });

  $('#filter-btn').addEventListener('click', () => $('#filter-bar').classList.toggle('hidden'));
  $('#filter-text').addEventListener('input', (e) => { state.filters.text = e.target.value; refreshCurrentBoardView(); });
  $('#filter-clear-btn').addEventListener('click', () => {
    state.filters = { text: '', labelIds: [] };
    $('#filter-text').value = '';
    const board = getCurrentBoard();
    if (board) renderFilterLabels(board);
    refreshCurrentBoardView();
  });

  $('#board-settings-btn').addEventListener('click', openBoardSettingsModal);
  $('#settings-close-btn').addEventListener('click', () => $('#board-settings-modal').classList.add('hidden'));
  $('#board-settings-modal').addEventListener('click', (e) => { if (e.target.id === 'board-settings-modal') $('#board-settings-modal').classList.add('hidden'); });
  $('#delete-board-btn').addEventListener('click', deleteCurrentBoard);
  $('#export-csv-btn').addEventListener('click', exportBoardCSV);
  $('#view-archive-btn').addEventListener('click', () => { $('#board-settings-modal').classList.add('hidden'); openArchiveModal(); });
  $('#archive-close-btn').addEventListener('click', () => $('#archive-modal').classList.add('hidden'));
  $('#archive-modal').addEventListener('click', (e) => { if (e.target.id === 'archive-modal') $('#archive-modal').classList.add('hidden'); });

  $('#app-lock-btn').addEventListener('click', () => { openLockSetupModal(); $('#lock-setup-modal').classList.remove('hidden'); });
  $('#lock-setup-close-btn').addEventListener('click', () => $('#lock-setup-modal').classList.add('hidden'));
  $('#lock-setup-modal').addEventListener('click', (e) => { if (e.target.id === 'lock-setup-modal') $('#lock-setup-modal').classList.add('hidden'); });

  $('#palette-input').addEventListener('input', (e) => renderPaletteResults(e.target.value));
  $('#command-palette').addEventListener('click', (e) => { if (e.target.id === 'command-palette') closePalette(); });

  document.addEventListener('keydown', (e) => {
    const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
    if (cmdK) { e.preventDefault(); openPalette(); return; }

    if (!$('#command-palette').classList.contains('hidden')) {
      if (e.key === 'Escape') closePalette();
      else if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); palettePressEnter(); }
      return;
    }
    if (!$('#card-modal').classList.contains('hidden')) {
      if (e.key === 'Escape') saveCardTitleAndClose();
      return;
    }
    if (e.key === 'Escape') {
      $('#board-modal').classList.add('hidden');
      $('#board-settings-modal').classList.add('hidden');
      $('#archive-modal').classList.add('hidden');
      $('#lock-setup-modal').classList.add('hidden');
    }
  });

  rebuildSearchIndex();
}

document.addEventListener('DOMContentLoaded', init);
