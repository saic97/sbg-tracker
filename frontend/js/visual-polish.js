/* =============================================================================
 * visual-polish.js -- behavior for the cleaner internal-ops visual layer.
 * =============================================================================
 */
(function () {
  const FOCUS_KEY = 'sbg_visual_focus_mode';
  const DENSITY_KEY = 'sbg_visual_density';
  const COMMAND_KEY = 'sbg_visual_command_mode';
  const COMMAND_NOTES_PREFIX = 'sbg_command_notes_';
  let hooked = false;

  function boot() {
    document.body.classList.add('visual-polish', 'vp-task-drawer');
    applyDensity(localStorage.getItem(DENSITY_KEY) || 'comfortable');
    if (localStorage.getItem(FOCUS_KEY) === '1') {
      document.body.classList.add('vp-focus-mode');
    }
    if (localStorage.getItem(COMMAND_KEY) === '1') {
      document.body.classList.add('vp-command-mode');
    }
    hookRender();
    applyVisualPolish();
  }

  function hookRender() {
    if (hooked || typeof render !== 'function') return;
    const originalRender = render;
    render = function () {
      const result = originalRender.apply(this, arguments);
      setTimeout(applyVisualPolish, 0);
      return result;
    };
    hooked = true;
  }

  function applyVisualPolish() {
    document.body.classList.add('visual-polish', 'vp-task-drawer');
    stripDecorativeText();
    ensureToolbarButtons();
    ensureMeetingExitButton();
    renderCommandCenter();
    renderProjectHealthBar();
    renderWeekStrip();
    renderQuickViews();
    enhanceAssigneeAvatars();
    enhancePriorityHeat();
    enhanceEmptyStates();
    syncToolbarButtons();
  }

  function stripDecorativeText() {
    const selectors = [
      '.view-btn',
      '.group-tab',
      '.btn',
      '.pill-tab',
      '.pv-section-title',
      '#sectionTitle',
      '.home-title',
      '.saved-views-btn .sv-btn-label'
    ];
    document.querySelectorAll(selectors.join(',')).forEach(el => {
      stripDirectTextNodes(el);
    });
  }

  function stripDirectTextNodes(el) {
    el.childNodes.forEach(node => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const cleaned = stripLeadingDecor(node.nodeValue);
      if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
    });
  }

  function stripLeadingDecor(text) {
    return String(text || '').replace(/^[^A-Za-z0-9+]+(?=[A-Za-z0-9])/g, '');
  }

  function ensureToolbarButtons() {
    const row = getToolbarActionRow();
    if (!row) return;
    ensureButton(row, 'vpDensityBtn', 'btn btn-sm vp-density-btn', toggleDensityMode, row.firstChild);
    ensureButton(row, 'vpFocusModeBtn', 'btn btn-sm vp-focus-btn', toggleVisualFocusMode, document.getElementById('vpDensityBtn')?.nextSibling || row.firstChild);
    ensureButton(row, 'vpCommandCenterBtn', 'btn btn-sm vp-command-btn', toggleVisualCommandMode, document.getElementById('vpFocusModeBtn')?.nextSibling || row.firstChild);
    ensureButton(row, 'vpMeetingModeBtn', 'btn btn-sm vp-meeting-btn', toggleVisualMeetingMode, document.getElementById('vpCommandCenterBtn')?.nextSibling || row.firstChild);
  }

  function ensureButton(parent, id, className, onClick, beforeNode) {
    let btn = document.getElementById(id);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = id;
      btn.type = 'button';
      btn.className = className;
      btn.onclick = onClick;
      parent.insertBefore(btn, beforeNode || parent.firstChild);
    }
    return btn;
  }

  function getToolbarActionRow() {
    return document.querySelector('.pv-wc-row > div:last-child');
  }

  function syncToolbarButtons() {
    syncDensityButton();
    syncFocusButton();
    syncCommandButton();
    syncMeetingButton();
  }

  function syncDensityButton() {
    const btn = document.getElementById('vpDensityBtn');
    if (!btn) return;
    const compact = document.body.classList.contains('vp-density-compact');
    btn.textContent = compact ? 'Comfort View' : 'Compact View';
    btn.title = compact ? 'Use roomier task cards and rows' : 'Use denser task cards and rows';
    btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
  }

  function applyDensity(mode) {
    const compact = mode === 'compact';
    document.body.classList.toggle('vp-density-compact', compact);
    document.body.classList.toggle('vp-density-comfortable', !compact);
    localStorage.setItem(DENSITY_KEY, compact ? 'compact' : 'comfortable');
  }

  function toggleDensityMode() {
    applyDensity(document.body.classList.contains('vp-density-compact') ? 'comfortable' : 'compact');
    syncDensityButton();
  }

  function syncFocusButton() {
    const btn = document.getElementById('vpFocusModeBtn');
    if (!btn) return;
    const active = document.body.classList.contains('vp-focus-mode');
    btn.textContent = active ? 'Exit Focus' : 'Focus Mode';
    btn.title = active ? 'Show project dashboard sections again' : 'Hide dashboard sections and keep only the task workspace';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('btn-dark', active);
  }

  function toggleVisualFocusMode() {
    const active = !document.body.classList.contains('vp-focus-mode');
    document.body.classList.toggle('vp-focus-mode', active);
    localStorage.setItem(FOCUS_KEY, active ? '1' : '0');
    syncFocusButton();
  }

  function syncCommandButton() {
    const btn = document.getElementById('vpCommandCenterBtn');
    if (!btn) return;
    const active = document.body.classList.contains('vp-command-mode');
    btn.textContent = active ? 'Exit Command' : 'Command Center';
    btn.title = active ? 'Return to the standard project workspace' : 'Open the project command center';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('btn-dark', active);
  }

  function toggleVisualCommandMode() {
    const active = !document.body.classList.contains('vp-command-mode');
    document.body.classList.toggle('vp-command-mode', active);
    localStorage.setItem(COMMAND_KEY, active ? '1' : '0');
    renderCommandCenter();
    syncCommandButton();
  }

  function syncMeetingButton() {
    const btn = document.getElementById('vpMeetingModeBtn');
    if (!btn) return;
    const active = document.body.classList.contains('vp-meeting-mode');
    btn.textContent = active ? 'Exit Meeting' : 'Meeting Mode';
    btn.title = active ? 'Return to the editable workspace' : 'Hide controls and show a clean meeting view';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('btn-dark', active);
  }

  function ensureMeetingExitButton() {
    let btn = document.getElementById('vpMeetingExitBtn');
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'vpMeetingExitBtn';
    btn.type = 'button';
    btn.className = 'btn btn-dark vp-meeting-exit';
    btn.textContent = 'Exit Meeting Mode';
    btn.onclick = toggleVisualMeetingMode;
    document.body.appendChild(btn);
  }

  function toggleVisualMeetingMode() {
    const active = !document.body.classList.contains('vp-meeting-mode');
    document.body.classList.toggle('vp-meeting-mode', active);
    syncMeetingButton();
  }

  function getActiveProject() {
    if (typeof state === 'undefined' || !state || !Array.isArray(state.projects)) return null;
    const projectView = document.getElementById('projectView');
    if (!projectView || projectView.classList.contains('hidden')) return null;
    return state.projects.find(p => p.id === state.activeProjectId) || null;
  }

  function renderCommandCenter() {
    const project = getActiveProject();
    const controls = document.getElementById('pvWorkspaceControls');
    let panel = document.getElementById('vpCommandCenter');
    if (!project || !controls || !document.body.classList.contains('vp-command-mode')) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'vpCommandCenter';
      panel.className = 'vp-command-center';
      controls.parentNode.insertBefore(panel, controls);
    }

    const data = collectCommandData(project);
    const noteValue = localStorage.getItem(commandNotesKey(project.id)) || '';
    panel.innerHTML = `
      <div class="vp-cmd-hero">
        <div class="vp-cmd-hero-main">
          <div class="vp-cmd-kicker">Bid Day Command Center</div>
          <h2>${escape(project.name || 'Active Project')}</h2>
          <div class="vp-cmd-meta">
            <span>${escape(data.deadlineLabel)}</span>
            <span>${escape(data.readinessLabel)}</span>
            <span>${escape(data.open.length)} open tasks</span>
          </div>
        </div>
        <div class="vp-cmd-readiness ${data.readinessClass}">
          <span>${data.readiness}%</span>
          <label>Ready</label>
        </div>
      </div>
      <div class="vp-cmd-metrics">
        ${commandMetric('Due Today', data.dueToday.length, 'today')}
        ${commandMetric('Overdue', data.overdue.length, 'danger')}
        ${commandMetric('Blocked / RFI', data.blocked.length, 'danger')}
        ${commandMetric('Waiting', data.waiting.length, 'warn')}
        ${commandMetric('Unassigned', data.unassigned.length, 'warn')}
        ${commandMetric('Needs Sign-off', data.signoff.length, 'success')}
      </div>
      <div class="vp-cmd-grid">
        ${commandTaskList('Right Now', data.rightNow, 'danger', 'No immediate fires.')}
        ${commandTaskList('Waiting / Blocked', data.blockers, 'warn', 'No blocked or waiting tasks.')}
        ${commandTaskList('Finish Line', data.finishLine, 'success', 'No final submission tasks open.')}
        <div class="vp-cmd-panel vp-cmd-team-panel">
          <div class="vp-cmd-panel-head">
            <strong>Team Load</strong>
            <span>${data.teamLoads.length} active owners</span>
          </div>
          <div class="vp-cmd-team-list">
            ${data.teamLoads.length ? data.teamLoads.map(renderTeamLoad).join('') : '<div class="vp-cmd-empty">No open team load.</div>'}
          </div>
        </div>
        <div class="vp-cmd-panel vp-cmd-notes-panel">
          <div class="vp-cmd-panel-head">
            <strong>Huddle Notes</strong>
            <span id="vpCommandNotesMeta">Saved locally</span>
          </div>
          <textarea id="vpCommandNotes" placeholder="Bid day calls, owner notes, handoff reminders, final submission details...">${escape(noteValue)}</textarea>
        </div>
      </div>`;

    const notes = document.getElementById('vpCommandNotes');
    if (notes && notes.dataset.bound !== '1') {
      notes.dataset.bound = '1';
      notes.addEventListener('input', () => {
        localStorage.setItem(commandNotesKey(project.id), notes.value);
        const meta = document.getElementById('vpCommandNotesMeta');
        if (meta) meta.textContent = 'Saved ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      });
    }
  }

  function collectCommandData(project) {
    const tasks = Array.isArray(project.tasks) ? project.tasks : [];
    const open = tasks.filter(t => t.status !== 'done');
    const done = tasks.length - open.length;
    const overdue = open.filter(t => daysLeft(t.dueDate) !== null && daysLeft(t.dueDate) < 0).sort(sortByDueThenTitle);
    const dueToday = open.filter(t => daysLeft(t.dueDate) === 0).sort(sortByDueThenTitle);
    const dueSoon = open.filter(t => {
      const d = daysLeft(t.dueDate);
      return d !== null && d >= 0 && d <= 2;
    }).sort(sortByDueThenTitle);
    const blocked = open.filter(t => t.status === 'blocked').sort(sortByDueThenTitle);
    const waiting = open.filter(t => t.status === 'pending').sort(sortByDueThenTitle);
    const unassigned = open.filter(t => taskLeadNames(t).length === 0).sort(sortByDueThenTitle);
    const signoff = tasks.filter(t => t.status === 'done' && !t.completionAcknowledged).sort(sortByDueThenTitle);
    const finishLine = open.filter(t => isFinishLineTask(t)).sort(sortByDueThenTitle);
    const rightNow = uniqueTasks([overdue, dueToday, blocked, dueSoon]).slice(0, 8);
    const blockers = uniqueTasks([blocked, waiting, unassigned]).slice(0, 8);
    const readiness = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    const deadlineSummary = project.dueDate ? dueSummary(project.dueDate) : 'No bid due date set';
    const readinessClass = overdue.length || blocked.length ? 'is-risk' : readiness >= 80 ? 'is-strong' : 'is-watch';

    return {
      open,
      overdue,
      dueToday,
      blocked,
      waiting,
      unassigned,
      signoff,
      finishLine: uniqueTasks([finishLine, signoff]).slice(0, 8),
      rightNow,
      blockers,
      teamLoads: buildTeamLoads(open),
      readiness,
      readinessClass,
      readinessLabel: `${done}/${tasks.length} complete`,
      deadlineLabel: project.dueDate ? `Bid due ${formatDateValue(project.dueDate)} - ${deadlineSummary}` : deadlineSummary
    };
  }

  function commandMetric(label, value, tone) {
    const cls = value > 0 ? ' has-value' : '';
    return `<div class="vp-cmd-metric vp-cmd-${tone}${cls}"><span>${value}</span><label>${escape(label)}</label></div>`;
  }

  function commandTaskList(title, tasks, tone, emptyText) {
    return `
      <div class="vp-cmd-panel vp-cmd-task-panel vp-cmd-${tone}">
        <div class="vp-cmd-panel-head">
          <strong>${escape(title)}</strong>
          <span>${tasks.length}</span>
        </div>
        <div class="vp-cmd-task-list">
          ${tasks.length ? tasks.map(t => renderCommandTask(t, tone)).join('') : `<div class="vp-cmd-empty">${escape(emptyText)}</div>`}
        </div>
      </div>`;
  }

  function renderCommandTask(task, tone) {
    const owner = taskLeadNames(task)[0] || 'Unassigned';
    const due = task.dueDate ? formatDateValue(task.dueDate) : 'No date';
    const dueClass = dueTone(task);
    return `
      <button class="vp-cmd-task vp-cmd-task-${tone}" onclick="event.stopPropagation();openTaskModal(null,'${escapeAttr(task.id)}')" title="${escapeAttr(task.title || '')}">
        <span class="vp-cmd-task-title">${escape(task.title || 'Untitled task')}</span>
        <span class="vp-cmd-task-meta">
          <span>${escape(owner)}</span>
          <span class="${dueClass}">${escape(due)}</span>
          <span>${escape(statusLabel(task.status))}</span>
        </span>
      </button>`;
  }

  function renderTeamLoad(load) {
    const pct = load.open ? Math.min(100, Math.round(((load.dueSoon + load.blocked) / load.open) * 100)) : 0;
    return `
      <div class="vp-cmd-team-row">
        <span class="vp-avatar" style="--vp-avatar-bg:${escapeAttr(colorForName(load.name))}">${escape(initialsFor(load.name))}</span>
        <div class="vp-cmd-team-body">
          <div class="vp-cmd-team-top">
            <strong>${escape(load.name)}</strong>
            <span>${load.open} open</span>
          </div>
          <div class="vp-cmd-team-progress"><span style="width:${pct}%"></span></div>
          <div class="vp-cmd-team-meta">${load.dueSoon} due soon - ${load.blocked} blocked - ${load.waiting} waiting</div>
        </div>
      </div>`;
  }

  function buildTeamLoads(openTasks) {
    const map = new Map();
    openTasks.forEach(task => {
      const names = taskLeadNames(task);
      const owners = names.length ? names : ['Unassigned'];
      owners.forEach(name => {
        if (!map.has(name)) map.set(name, { name, open: 0, dueSoon: 0, blocked: 0, waiting: 0 });
        const load = map.get(name);
        load.open += 1;
        const d = daysLeft(task.dueDate);
        if (d !== null && d <= 2) load.dueSoon += 1;
        if (task.status === 'blocked') load.blocked += 1;
        if (task.status === 'pending') load.waiting += 1;
      });
    });
    return Array.from(map.values())
      .sort((a, b) => (b.blocked - a.blocked) || (b.dueSoon - a.dueSoon) || (b.open - a.open) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }

  function uniqueTasks(groups) {
    const seen = new Set();
    const out = [];
    groups.flat().forEach(task => {
      if (!task || seen.has(task.id)) return;
      seen.add(task.id);
      out.push(task);
    });
    return out;
  }

  function isFinishLineTask(task) {
    const text = `${task.stage || ''} ${task.title || ''} ${task.category || ''}`.toLowerCase();
    return /bid-day|bid-submission|submit|submission|proposal|final|deliver|owner|review/.test(text);
  }

  function taskLeadNames(task) {
    if (Array.isArray(task.leads)) return task.leads.map(cleanName).filter(Boolean);
    return task.assignee ? [cleanName(task.assignee)].filter(Boolean) : [];
  }

  function commandNotesKey(projectId) {
    return COMMAND_NOTES_PREFIX + projectId;
  }

  function dueSummary(dateStr) {
    const d = daysLeft(dateStr);
    if (d === null) return 'No date';
    if (d < 0) return `${Math.abs(d)}d late`;
    if (d === 0) return 'due today';
    if (d === 1) return 'due tomorrow';
    return `${d}d left`;
  }

  function dueTone(task) {
    const d = daysLeft(task.dueDate);
    if (d === null) return 'vp-due-none';
    if (d < 0) return 'vp-due-danger';
    if (d <= 1) return 'vp-due-warn';
    return 'vp-due-ok';
  }

  function statusLabel(status) {
    return ({
      'not-started': 'Not Started',
      'in-progress': 'In Progress',
      blocked: 'Blocked',
      pending: 'Waiting',
      done: 'Complete'
    })[status] || status || 'Unknown';
  }

  function formatDateValue(dateStr) {
    if (!dateStr) return '';
    if (typeof formatDateShort === 'function') return formatDateShort(dateStr);
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function renderProjectHealthBar() {
    const project = getActiveProject();
    const controls = document.getElementById('pvWorkspaceControls');
    let bar = document.getElementById('vpProjectHealthBar');
    if (!project || !controls) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('section');
      bar.id = 'vpProjectHealthBar';
      bar.className = 'vp-health-bar';
      controls.parentNode.insertBefore(bar, controls);
    }

    const tasks = Array.isArray(project.tasks) ? project.tasks : [];
    const total = tasks.length;
    const open = tasks.filter(t => t.status !== 'done');
    const done = total - open.length;
    const overdue = open.filter(t => daysLeft(t.dueDate) !== null && daysLeft(t.dueDate) < 0).length;
    const dueToday = open.filter(t => daysLeft(t.dueDate) === 0).length;
    const blocked = open.filter(t => t.status === 'blocked').length;
    const waiting = open.filter(t => t.status === 'pending').length;
    const doneThisWeek = tasks.filter(t => t.status === 'done' && isThisWeek(t.completedAt || t.completionAcknowledgedAt)).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    bar.innerHTML = [
      '<div class="vp-health-main">',
      '<div class="vp-health-kicker">Project Health</div>',
      `<div class="vp-health-title">${escape(project.name || 'Active Project')}</div>`,
      `<div class="vp-health-progress"><span style="width:${pct}%"></span></div>`,
      `<div class="vp-health-sub">${done}/${total} complete</div>`,
      '</div>',
      '<div class="vp-health-metrics">',
      healthMetric('overdue', overdue, 'Overdue'),
      healthMetric('today', dueToday, 'Due Today'),
      healthMetric('blocked', blocked, 'Blocked'),
      healthMetric('waiting', waiting, 'Waiting'),
      healthMetric('done-week', doneThisWeek, 'Done This Week'),
      '</div>'
    ].join('');
  }

  function healthMetric(kind, value, label) {
    const cls = value > 0 ? ' has-value' : '';
    return `<div class="vp-health-metric vp-health-${kind}${cls}"><span>${value}</span><label>${label}</label></div>`;
  }

  function renderWeekStrip() {
    const project = getActiveProject();
    const controls = document.getElementById('pvWorkspaceControls');
    let strip = document.getElementById('vpWeekStrip');
    if (!project || !controls) {
      if (strip) strip.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement('section');
      strip.id = 'vpWeekStrip';
      strip.className = 'vp-week-strip';
      controls.parentNode.insertBefore(strip, controls);
    }

    const tasks = (project.tasks || []).filter(t => t.status !== 'done' && t.dueDate);
    const days = getWorkWeekDays(new Date());
    const cells = days.map(day => {
      const iso = toIsoDate(day);
      const due = tasks.filter(t => t.dueDate === iso).sort(sortByDueThenTitle);
      const items = due.slice(0, 3).map(t => {
        const assignee = t.assignee ? `<span>${escape(t.assignee)}</span>` : '<span>Unassigned</span>';
        return `<button class="vp-week-task" onclick="event.stopPropagation();openTaskModal(null,'${escapeAttr(t.id)}')" title="${escapeAttr(t.title)}">${escape(t.title)}${assignee}</button>`;
      }).join('');
      const extra = due.length > 3 ? `<div class="vp-week-extra">+${due.length - 3} more</div>` : '';
      const isToday = iso === toIsoDate(new Date());
      return `
        <div class="vp-week-day${isToday ? ' is-today' : ''}">
          <div class="vp-week-day-head">
            <span>${day.toLocaleDateString('en-US', { weekday: 'short' })}</span>
            <strong>${day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</strong>
            <em>${due.length}</em>
          </div>
          <div class="vp-week-day-body">${items || '<div class="vp-week-empty">No tasks due</div>'}${extra}</div>
        </div>`;
    }).join('');

    strip.innerHTML = `
      <div class="vp-week-title">
        <span>This Week</span>
        <small>Open tasks due Monday-Friday</small>
      </div>
      <div class="vp-week-days">${cells}</div>`;
  }

  function renderQuickViews() {
    const controls = document.getElementById('pvWorkspaceControls');
    let quick = document.getElementById('vpQuickViews');
    if (!getActiveProject() || !controls) {
      if (quick) quick.remove();
      return;
    }
    if (!quick) {
      quick = document.createElement('div');
      quick.id = 'vpQuickViews';
      quick.className = 'vp-quick-views';
      const grouping = document.getElementById('groupingSection');
      controls.insertBefore(quick, grouping || null);
    }
    quick.innerHTML = `
      <span class="vp-quick-label">Quick Views</span>
      <button type="button" onclick="window.applyVisualQuickView('mine')">My Tasks</button>
      <button type="button" onclick="window.applyVisualQuickView('today')">Due Today</button>
      <button type="button" onclick="window.applyVisualQuickView('bidday')">Bid Day</button>
      <button type="button" onclick="window.applyVisualQuickView('overdue')">Overdue</button>
      <button type="button" onclick="window.applyVisualQuickView('waiting')">Waiting</button>`;
  }

  function applyVisualQuickView(kind) {
    if (typeof state === 'undefined') return;
    state.viewMode = 'board';
    state.grouping = 'stage';
    state.activeStageId = 'all';
    state.activeAssignee = 'all';
    state.activeStatus = 'all';
    state.activeAlertTier = 'all';
    state.secondaryAssigneeFilter = 'all';
    state.criticalFilterOnly = false;

    if (kind === 'mine') {
      const user = typeof getCurrentUser === 'function' ? getCurrentUser() : '';
      state.secondaryAssigneeFilter = user || 'all';
    } else if (kind === 'today') {
      state.grouping = 'alert';
      state.activeAlertTier = 'imminent';
    } else if (kind === 'bidday') {
      state.activeStageId = 'bid-day';
    } else if (kind === 'overdue') {
      state.grouping = 'alert';
      state.activeAlertTier = 'overdue';
    } else if (kind === 'waiting') {
      state.grouping = 'status';
      state.activeStatus = 'pending';
    }

    if (typeof clearActiveSavedView === 'function') clearActiveSavedView();
    if (typeof saveState === 'function') saveState();
    if (typeof render === 'function') render();
  }

  function enhanceAssigneeAvatars() {
    document.querySelectorAll('.task-card .assignee, .task-table td[data-col="assignee"] .assignee, .ssv-row-assignee, .ai-assignee').forEach(el => {
      if (el.dataset.vpAvatarEnhanced === '1') return;
      const name = cleanName(el.textContent);
      if (!name || /^unassigned$/i.test(name)) {
        el.classList.add('vp-unassigned');
        el.dataset.vpAvatarEnhanced = '1';
        return;
      }
      if (!el.querySelector('.avatar, .ssv-row-avatar, .vp-avatar')) {
        const avatar = document.createElement('span');
        avatar.className = 'vp-avatar';
        avatar.style.setProperty('--vp-avatar-bg', colorForName(name));
        avatar.textContent = initialsFor(name);
        el.insertBefore(avatar, el.firstChild);
      }
      wrapDirectText(el, 'vp-assignee-name');
      el.classList.add('vp-assignee-pill');
      if (!el.title) el.title = name;
      el.dataset.vpAvatarEnhanced = '1';
    });
  }

  function wrapDirectText(el, className) {
    Array.from(el.childNodes).forEach(node => {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) return;
      const span = document.createElement('span');
      span.className = className;
      span.textContent = node.nodeValue.trim();
      node.replaceWith(span);
    });
  }

  function enhancePriorityHeat() {
    document.querySelectorAll('.task-card[data-task-id]').forEach(card => {
      const task = findTask(card.dataset.taskId);
      if (!task) return;
      card.classList.toggle('vp-heat-critical', !!task.critical);
      card.classList.toggle('vp-heat-overdue', task.status !== 'done' && daysLeft(task.dueDate) !== null && daysLeft(task.dueDate) < 0);
      card.classList.toggle('vp-heat-today', task.status !== 'done' && daysLeft(task.dueDate) === 0);
      card.classList.toggle('vp-heat-blocked', task.status === 'blocked');
      card.classList.toggle('vp-heat-waiting', task.status === 'pending');
    });
  }

  function enhanceEmptyStates() {
    document.querySelectorAll('.vp-empty-state, .vp-empty-inline').forEach(el => el.remove());
    const project = getActiveProject();
    if (!project) return;

    document.querySelectorAll('.stage-task-grid').forEach(grid => {
      if (grid.closest('.hidden')) return;
      if (grid.querySelector('.task-card')) return;
      const empty = document.createElement('div');
      empty.className = 'vp-empty-inline';
      empty.innerHTML = '<strong>No tasks here</strong><span>This lane is clear for the current filter.</span>';
      grid.appendChild(empty);
    });

    const activePanel = ['boardView', 'tableView', 'calendarView', 'scheduleView', 'lookaheadView']
      .map(id => document.getElementById(id))
      .find(el => el && !el.classList.contains('hidden'));
    if (!activePanel) return;
    const hasVisibleTasks = !!activePanel.querySelector('.task-card, .task-table tbody tr:not(.stage-group-header), .cal-event, .sched-task-row, .la-task-row');
    if (hasVisibleTasks) return;
    const empty = document.createElement('div');
    empty.className = 'vp-empty-state';
    empty.innerHTML = `
      <div class="vp-empty-title">No tasks match this view</div>
      <div class="vp-empty-sub">Clear a filter, switch grouping, or add a task to this project.</div>
      <button class="btn btn-primary btn-sm" onclick="openTaskModal()">Add Task</button>`;
    activePanel.appendChild(empty);
  }

  function findTask(taskId) {
    if (typeof state === 'undefined' || !state || !Array.isArray(state.projects)) return null;
    for (const project of state.projects) {
      const found = (project.tasks || []).find(t => t.id === taskId);
      if (found) return found;
    }
    return null;
  }

  function daysLeft(dateStr) {
    if (!dateStr) return null;
    if (typeof getDaysLeft === 'function') return getDaysLeft(dateStr);
    const due = new Date(dateStr + 'T00:00:00');
    due.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((due - today) / 86400000);
  }

  function getWorkWeekDays(baseDate) {
    const d = new Date(baseDate);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + mondayOffset);
    return [0, 1, 2, 3, 4].map(offset => {
      const next = new Date(d);
      next.setDate(d.getDate() + offset);
      return next;
    });
  }

  function isThisWeek(value) {
    if (!value) return false;
    const date = typeof value === 'number' ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const week = getWorkWeekDays(new Date());
    const start = week[0];
    const end = new Date(week[4]);
    end.setHours(23, 59, 59, 999);
    return date >= start && date <= end;
  }

  function toIsoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function sortByDueThenTitle(a, b) {
    return String(a.dueDate || '').localeCompare(String(b.dueDate || '')) ||
      String(a.title || '').localeCompare(String(b.title || ''));
  }

  function cleanName(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function initialsFor(name) {
    const initials = cleanName(name).split(' ').map(part => part.charAt(0)).join('').slice(0, 2).toUpperCase();
    return initials || '?';
  }

  function colorForName(name) {
    if (typeof avatarColor === 'function') return avatarColor(name);
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    const colors = ['#c8322b', '#0a2540', '#2563a8', '#2f7d57', '#b7791f', '#7b4397', '#00897b'];
    return colors[Math.abs(hash) % colors.length];
  }

  function escape(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function escapeAttr(value) {
    return escape(value);
  }

  window.toggleVisualFocusMode = toggleVisualFocusMode;
  window.toggleVisualMeetingMode = toggleVisualMeetingMode;
  window.applyVisualQuickView = applyVisualQuickView;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
