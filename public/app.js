import { SPRITES } from './sprites.js';

/* =========================================================
   Helpers
   ========================================================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const app = $('#app');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.needsLogin && path !== '/status') confirmSignedOut();
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

// One request said "sign in again". Double-check with the server before showing the sign-in page,
// so a single refused call can't strand anyone on it.
let checkingSignIn = null;
function confirmSignedOut() {
  checkingSignIn ||= fetch('/api/status')
    .then((r) => r.json())
    .then((st) => {
      if (st.auth === 'oauth' && !st.signedIn) {
        state.status = st;
        if (!/^#\/(settings|signin)/.test(location.hash)) location.hash = '#/signin';
      }
    })
    .catch(() => {})
    .finally(() => (checkingSignIn = null));
}

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

/* =========================================================
   State
   ========================================================= */
const state = {
  status: null,
  projects: null,
  boards: {}, // "projectKey/teamId" -> board
  teams: {}, // projectKey -> { project, teams }
  kanbanFocus: {}, // "projectKey/teamId" -> feature key highlighted on the Kanban ('_none' = no feature)
  heroX: {}, // featureKey -> last hero x (so the hero walks from where he was)
  lastPct: {}, // featureKey -> last progress %
  justCreated: null,
  busy: false,
};

const UNSORTED = '_bonus';
const ALL_TEAM = '_all';

/* =========================================================
   Sound (tiny WebAudio blips, off by default)
   ========================================================= */
const Sound = {
  on: store.get('bq.sound', false),
  ctx: null,
  tone(freq, start, dur, type = 'square', vol = 0.06, slideTo) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime + start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + start + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + start);
    o.stop(ctx.currentTime + start + dur + 0.02);
  },
  play(kind) {
    if (!this.on) return;
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (kind === 'coin') {
        this.tone(988, 0, 0.08);
        this.tone(1319, 0.08, 0.25);
      } else if (kind === 'squash') {
        this.tone(300, 0, 0.18, 'square', 0.07, 80);
      } else if (kind === 'spawn') {
        [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.06, 0.1, 'triangle', 0.08));
      } else if (kind === 'clear') {
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, i * 0.11, 0.16, 'square', 0.05));
      } else if (kind === 'engine') {
        this.tone(70, 0, 0.5, 'sawtooth', 0.035, 160);
      } else if (kind === 'undo') {
        this.tone(440, 0, 0.12, 'triangle', 0.07, 220);
      }
    } catch {
      /* audio not available */
    }
  },
};

function renderSoundBtn() {
  const b = $('#sound-btn');
  b.textContent = Sound.on ? '🔊' : '🔇';
  b.setAttribute('aria-pressed', String(Sound.on));
  b.title = Sound.on ? 'Sound on' : 'Sound off';
}
$('#sound-btn').addEventListener('click', () => {
  Sound.on = !Sound.on;
  store.set('bq.sound', Sound.on);
  renderSoundBtn();
  Sound.play('coin');
});

/* =========================================================
   Toasts, popover, modal
   ========================================================= */
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 3000);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

/* ---------- Detail drawer (slides in from the right) ---------- */
const drawer = $('#drawer');
let drawerKey = null;
function closeDrawer() {
  dz = null;
  drawer.classList.remove('open', 'dragging');
  drawer.setAttribute('aria-hidden', 'true');
  drawerKey = null;
  $$('.ent.selected, .questlog li.selected').forEach((e) => e.classList.remove('selected'));
}
drawer.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').open && $('#lightbox').hidden) closeDrawer();
});

const fmtDate = (s, withTime = false) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
};

// Jira returns rendered HTML for descriptions and comments. Strip anything active before showing it.
function sanitize(html, site) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root
    .querySelectorAll('script,style,iframe,frame,object,embed,form,input,button,textarea,select,link,meta,base,svg,math')
    .forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'style' || n === 'srcset' || n === 'formaction') {
        el.removeAttribute(a.name);
      } else if (n === 'href' || n === 'src') {
        const v = a.value.trim();
        // Jira attachment links need a Jira login, so route them through this server.
        const att =
          v.match(/\/rest\/api\/[23]\/attachment\/(content|thumbnail)\/(\d+)/) ||
          v.match(/\/secure\/(attachment|thumbnail)\/(\d+)\//);
        if (att) {
          const kind = att[1] === 'thumbnail' ? 'thumbnail' : 'content';
          el.setAttribute(a.name, `/api/attachments/${att[2]}/${kind}`);
          continue;
        }
        if (/^(javascript|vbscript|data):/i.test(v) && !(n === 'src' && /^data:image\//i.test(v))) el.removeAttribute(a.name);
        else if (site && v.startsWith('/') && !v.startsWith('//')) el.setAttribute(a.name, site + v);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return root.innerHTML;
}

function openForm({ title, intro = '', fields, submit, onSubmit, onInput }) {
  const dlg = $('#modal');
  const form = $('#modal-form');
  closeDrawer();
  form.innerHTML = `
    <h2 class="pixel">${esc(title)}</h2>
    ${intro ? `<p class="muted">${intro}</p>` : ''}
    ${fields
      .map((f) => {
        const id = `f-${f.name}`;
        const control =
          f.type === 'select'
            ? `<select id="${id}" name="${f.name}">${f.options
                .map((o) => `<option value="${o.value}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`)
                .join('')}</select>`
            : `<input id="${id}" name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(
                f.placeholder || '',
              )}" ${f.required ? 'required' : ''} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} autocomplete="off" />`;
        return `<label class="field" for="${id}"><span>${esc(f.label)}</span>${control}${
          f.help ? `<small class="muted">${esc(f.help)}</small>` : ''
        }</label>`;
      })
      .join('')}
    <p class="form-error" hidden></p>
    <div class="form-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">${esc(submit)}</button>
    </div>`;
  const errEl = $('.form-error', form);
  const submitBtn = $('button[type=submit]', form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    submitBtn.disabled = true;
    submitBtn.textContent = 'Working…';
    errEl.hidden = true;
    try {
      await onSubmit(data);
      dlg.close();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = submit;
    }
  };
  form.oninput = onInput ? (e) => onInput(e, form) : null;
  $('[data-cancel]', form).onclick = () => dlg.close();
  dlg.showModal();
  $('input,select', form)?.focus();
}

// Search Jira for existing issues/features and act on them one by one.
function openSearch({ title, intro, kind, pkey, isAdded = () => false, pickLabel = 'Add', onPick, onClose }) {
  const dlg = $('#modal');
  const form = $('#modal-form');
  closeDrawer();
  form.onsubmit = (e) => e.preventDefault();
  form.oninput = null;
  form.innerHTML = `
    <h2 class="pixel">${esc(title)}</h2>
    <p class="muted">${intro}</p>
    <input id="search-q" class="input search-input" type="search" placeholder="Search by summary, or type a key like ${esc(pkey)}-12" autocomplete="off" aria-label="Search" />
    <label class="check-label"><input type="checkbox" id="search-only" ${kind === 'issue' ? 'checked' : ''} /> Only project ${esc(pkey)}</label>
    <ul class="results" id="search-results" aria-live="polite"></ul>
    <div class="form-actions"><button type="button" class="btn" data-cancel>Done</button></div>`;
  const q = $('#search-q', form);
  const only = $('#search-only', form);
  const list = $('#search-results', form);
  let seq = 0;
  let timer;

  const row = (it) => {
    const added = isAdded(it);
    const where =
      kind === 'feature'
        ? `${esc(it.projectKey || '')} · ${esc(it.statusName)}`
        : `${esc(it.statusName)} · ${it.parentKey ? `in ${esc(it.parentKey)}` : 'no feature'}`;
    return `<li>
      <span class="q-icon">${it.type === 'bug' ? SPRITES.coneIcon : it.type === 'story' ? SPRITES.storyIcon : it.type === 'epic' ? SPRITES.checkeredSmall : SPRITES.taskIcon}</span>
      <span class="r-main"><b>${esc(it.key)}</b> ${esc(it.summary)}<small class="muted">${where}</small></span>
      <button type="button" class="btn small ${added ? '' : 'primary'}" data-pick="${esc(it.key)}" ${added ? 'disabled' : ''}>${added ? '✓ Added' : esc(pickLabel)}</button>
    </li>`;
  };

  let results = [];
  const run = async () => {
    const my = ++seq;
    list.innerHTML = '<li class="muted">Searching…</li>';
    try {
      const params = new URLSearchParams({ q: q.value, kind, project: pkey, only: only.checked ? '1' : '0' });
      const res = await api(`/search?${params}`);
      if (my !== seq) return;
      results = res;
      list.innerHTML = res.length ? res.map(row).join('') : '<li class="muted">Nothing found.</li>';
    } catch (e) {
      if (my === seq) list.innerHTML = `<li class="form-error">${esc(e.message)}</li>`;
    }
  };
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  only.addEventListener('change', run);
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    const it = results.find((r) => r.key === btn.dataset.pick);
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await onPick(it);
      btn.textContent = '✓ Added';
      btn.classList.remove('primary');
      Sound.play('spawn');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = pickLabel;
      toast(err.message, 'error');
    }
  });
  $('[data-cancel]', form).onclick = () => dlg.close();
  dlg.addEventListener('close', () => onClose?.(), { once: true });
  dlg.showModal();
  q.focus();
  run();
}

/* =========================================================
   Data
   ========================================================= */
async function loadStatus() {
  const badge = $('#mode-badge');
  try {
    state.status = await api('/status');
    const personal = state.status.auth === 'oauth' && state.status.signedIn;
    $('#signout-btn').hidden = !personal;
    $('#user-chip').hidden = !personal;
    if (personal) $('#user-chip').textContent = state.status.user;
    if (state.status.auth === 'oauth' && !state.status.signedIn) {
      badge.textContent = 'SIGN IN';
      badge.className = 'badge demo';
      badge.href = '#/signin';
      badge.title = 'Sign in with your Atlassian account';
      return;
    }
    badge.href = '#/settings';
    if (state.status.mode === 'demo') {
      badge.textContent = 'DEMO MODE';
      badge.className = 'badge demo';
      badge.title = 'Using local demo data. Click to connect Jira.';
    } else {
      const host = new URL(state.status.site).host;
      badge.textContent = `JIRA · ${host}`;
      badge.className = 'badge live';
      badge.title =
        state.status.auth === 'oauth'
          ? `You're signed in with your own Atlassian account (${state.status.user}).`
          : `Everyone uses the shared account ${state.status.user}. Click for connection settings.`;
    }
  } catch (e) {
    state.status = { mode: 'error', error: e.message };
    badge.textContent = 'JIRA ERROR';
    badge.className = 'badge error';
    badge.title = `${e.message} Click to fix the connection.`;
    toast(`Could not reach Jira: ${e.message}`, 'error');
  }
}

async function loadProjects(force = false) {
  if (!state.projects || force) state.projects = await api('/projects');
  return state.projects;
}

const enc = encodeURIComponent;
const teamHref = (pkey, tid, rest = '') => `#/p/${enc(pkey)}/t/${enc(tid)}${rest}`;

async function loadBoard(pkey, tid, force = false) {
  const k = `${pkey}/${tid}`;
  if (force) {
    // Issues are shared between a project's team pages, so drop their cached boards too.
    for (const other of Object.keys(state.boards)) if (other.startsWith(`${pkey}/`)) delete state.boards[other];
  }
  if (!state.boards[k]) state.boards[k] = await api(`/projects/${enc(pkey)}/teams/${enc(tid)}/board`);
  return state.boards[k];
}

async function loadTeams(pkey, force = false) {
  if (!state.teams[pkey] || force) state.teams[pkey] = await api(`/projects/${enc(pkey)}/teams`);
  return state.teams[pkey];
}

function stats(items, featureDone = false) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const bugs = items.filter((i) => i.type === 'bug');
  const tasks = items.filter((i) => i.type !== 'bug');
  return {
    total,
    done,
    pct: total ? Math.round((done / total) * 100) : featureDone ? 100 : 0,
    bugsTotal: bugs.length,
    bugsDone: bugs.filter((i) => i.done).length,
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((i) => i.done).length,
  };
}

function resetCaches() {
  state.projects = null;
  state.boards = {};
  state.teams = {};
  state.heroX = {};
  state.lastPct = {};
}

function findFeature(board, fkey) {
  if (fkey === UNSORTED) {
    return {
      key: UNSORTED,
      summary: 'Not in any feature',
      type: 'epic',
      done: false,
      pseudo: true,
      items: board.unsorted,
    };
  }
  return board.features.find((f) => f.key === fkey);
}

/* =========================================================
   Router
   ========================================================= */
function setCrumbs(parts) {
  $('#crumbs').innerHTML = parts
    .map((p, i) =>
      i === parts.length - 1
        ? `<span aria-current="page">${esc(p.label)}</span>`
        : `<a href="${p.href}">${esc(p.label)}</a>`,
    )
    .join('<span class="sep">›</span>');
}

async function route() {
  closeDrawer();
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (state.status?.auth === 'oauth' && !state.status.signedIn && parts[0] !== 'settings') {
    return renderSignIn();
  }
  try {
    if (parts[0] === 'settings') await renderSettings();
    else if (parts[0] === 'signin') await renderSignIn();
    else if (parts[0] === 'p' && parts[2] === 't' && parts[3] && parts[4] === 'settings') await renderTeamSettings(parts[1], parts[3]);
    else if (parts[0] === 'p' && parts[2] === 't' && parts[3] && parts[4] === 'kanban') await renderKanban(parts[1], parts[3]);
    else if (parts[0] === 'p' && parts[2] === 't' && parts[3] && parts[4] === 'f' && parts[5]) await renderLevel(parts[1], parts[3], parts[5]);
    else if (parts[0] === 'p' && parts[2] === 't' && parts[3]) await renderTeam(parts[1], parts[3]);
    else if (parts[0] === 'p' && parts[2] === 'f' && parts[3]) location.replace(teamHref(parts[1], ALL_TEAM, `/f/${enc(parts[3])}`));
    else if (parts[0] === 'p' && parts[1]) await renderProject(parts[1]);
    else await renderProjects();
  } catch (e) {
    app.innerHTML = `<section class="screen"><div class="empty pixel-box"><h1 class="pixel">PIT STOP</h1><p>${esc(
      e.message,
    )}</p><div class="actions center-actions"><button class="btn primary" type="button" id="retry-btn">↻ Try again</button><a class="btn" href="#/">Back to circuits</a><a class="btn" href="#/settings">Jira connection settings</a></div></div></section>`;
    $('#retry-btn')?.addEventListener('click', () => {
      resetCaches();
      route();
    });
  }
}
window.addEventListener('hashchange', route);

let slowTimer;
function loadingScreen(label = 'LOADING') {
  app.innerHTML = `<section class="screen"><div class="loading"><span class="loading-hero">${SPRITES.carA}${SPRITES.carB}</span><p class="pixel">${label}…</p>
    <p class="muted small-text slow-hint" hidden>Jira is taking its time. Still waiting…</p></div></section>`;
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    const hint = $('.slow-hint');
    if (hint) hint.hidden = false;
  }, 5000);
}

/* =========================================================
   Screen 1: world select (projects)
   ========================================================= */
async function renderProjects() {
  setCrumbs([{ label: 'Circuits' }]);
  if (!state.projects) loadingScreen();
  const projects = await loadProjects();
  const filter = store.get('bq.filter', '');

  app.innerHTML = `
    <section class="screen">
      <div class="screen-head">
        <div>
          <h1 class="pixel">SELECT CIRCUIT</h1>
          <p class="muted">Pick a Jira project (circuit), then your team page. Each team sees its own features as race stages.</p>
        </div>
        <div class="actions">
          <input id="proj-filter" class="input" type="search" placeholder="Filter circuits…" value="${esc(filter)}" aria-label="Filter projects" />
          <button class="btn primary" id="new-proj" type="button">+ New project</button>
        </div>
      </div>
      ${
        state.status?.mode === 'demo'
          ? `<div class="notice pixel-box"><span>You're playing with <b>demo data</b>. Connect your Jira site to see your real projects.</span><a class="btn primary" href="#/settings">Connect Jira</a></div>`
          : ''
      }
      <div class="grid worlds" id="proj-grid"></div>
    </section>`;

  const grid = $('#proj-grid');
  const draw = (q) => {
    const list = projects.filter((p) => !q || `${p.key} ${p.name}`.toLowerCase().includes(q.toLowerCase()));
    grid.innerHTML =
      list
        .map(
          (p) => `
        <a class="card world-card" href="#/p/${encodeURIComponent(p.key)}">
          <span class="pixel tag">CIRCUIT ${projects.indexOf(p) + 1}</span>
          <h2>${esc(p.name)}</h2>
          <span class="key">${esc(p.key)} · ${p.teams ? `${p.teams} team page${p.teams > 1 ? 's' : ''}` : 'no team pages yet'}</span>
          <span class="world-deco" aria-hidden="true">${SPRITES.bush}</span>
        </a>`,
        )
        .join('') || `<p class="muted">No projects match “${esc(q)}”.</p>`;
  };
  draw(filter);
  $('#proj-filter').addEventListener('input', (e) => {
    store.set('bq.filter', e.target.value);
    draw(e.target.value);
  });
  $('#new-proj').addEventListener('click', createProjectForm);
}

function createProjectForm() {
  let keyTouched = false;
  openForm({
    title: 'NEW CIRCUIT',
    intro:
      state.status?.mode === 'jira'
        ? 'Creates a Jira software project with you as lead. You need Jira admin rights for this.'
        : 'Creates a project in the local demo data.',
    fields: [
      { name: 'name', label: 'Project name', required: true, placeholder: 'Mobile app', maxlength: 80 },
      { name: 'key', label: 'Key', required: true, placeholder: 'MOB', maxlength: 10, help: '2–10 capital letters or digits, starting with a letter.' },
    ],
    submit: 'Create project',
    onInput(e, form) {
      if (e.target.name === 'key') {
        keyTouched = true;
        e.target.value = e.target.value.toUpperCase();
      }
      if (e.target.name === 'name' && !keyTouched) {
        const words = e.target.value.trim().split(/\s+/).filter(Boolean);
        let key = words.length > 1 ? words.map((w) => w[0]).join('') : words[0]?.slice(0, 4) || '';
        key = key.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 10);
        form.elements.key.value = key;
      }
    },
    async onSubmit({ name, key }) {
      const p = await api('/projects', { method: 'POST', body: { name, key } });
      await loadProjects(true);
      Sound.play('spawn');
      toast(`Circuit ${p.key} created!`, 'success');
      location.hash = `#/p/${encodeURIComponent(p.key)}`;
    },
  });
}

/* =========================================================
   Screen 1b: team pages of a project (only in Bug Rally)
   ========================================================= */
async function renderProject(pkey) {
  if (!state.teams[pkey]) loadingScreen('LOADING CIRCUIT');
  const { project, teams } = await loadTeams(pkey);
  setCrumbs([{ label: 'Circuits', href: '#/' }, { label: project.name }]);

  const teamCard = (t) => `
    <a class="card team-card" href="${teamHref(pkey, t.id)}">
      <span class="pixel tag">TEAM</span>
      <h2>${esc(t.name)}</h2>
      <span class="key filter-line" title="${esc(filterSummary(t, pkey))}">⛃ ${esc(filterSummary(t, pkey))}</span>
      ${teamDefaultsChips(t) || '<span class="muted small-text">Nothing filled in automatically</span>'}
      <div class="team-stats muted small-text" data-team="${esc(t.id)}">Loading stages…</div>
      <span class="team-car" aria-hidden="true">${SPRITES.carSmall}</span>
    </a>`;

  app.innerHTML = `
    <section class="screen">
      <div class="screen-head">
        <div>
          <span class="pixel tag">CIRCUIT · ${esc(pkey)}</span>
          <h1>${esc(project.name)}</h1>
          <p class="muted">Pick your team. A team page shows its own part of this Jira project (its filter),
          and fills in the team's work group, components and labels on everything the team creates.
          ${project.url ? `<a class="ext" href="${esc(project.url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : ''}</p>
        </div>
        <div class="actions">
          <button class="btn primary" id="new-team" type="button">+ New team page</button>
        </div>
      </div>
      <div class="grid teams">
        ${teams.map(teamCard).join('')}
        <button class="card team-card add-card" id="new-team-2" type="button">
          <span class="plus pixel">+</span><span>New team page</span>
        </button>
        <a class="card team-card all-card" href="${teamHref(pkey, ALL_TEAM)}">
          <span class="pixel tag">WHOLE PROJECT</span>
          <h2>All of ${esc(project.name)}</h2>
          <span class="muted small-text">Every feature in ${esc(pkey)}, with no team filter and nothing filled in automatically.</span>
        </a>
      </div>
      ${teams.length === 0 ? '<p class="muted center">No team pages yet. Create one to set up a filter and the team’s work group, components and labels.</p>' : ''}
    </section>`;

  const newTeam = () =>
    openForm({
      title: 'NEW TEAM PAGE',
      intro: `A team page lives only in Bug Rally. Next you'll choose its filter and what gets filled in on new issues.`,
      fields: [{ name: 'name', label: 'Team name', required: true, placeholder: 'Team Rocket', maxlength: 80 }],
      submit: 'Create team page',
      async onSubmit({ name }) {
        const t = await api(`/projects/${enc(pkey)}/teams`, { method: 'POST', body: { name } });
        delete state.teams[pkey];
        Sound.play('spawn');
        toast(`Team page ${t.name} created. Now set its filter and defaults.`, 'success');
        location.hash = teamHref(pkey, t.id, '/settings');
      },
    });
  $('#new-team').addEventListener('click', newTeam);
  $('#new-team-2').addEventListener('click', newTeam);

  // Fill in each team's progress in the background.
  for (const t of teams) {
    loadBoard(pkey, t.id)
      .then((b) => {
        const el = document.querySelector(`.team-stats[data-team="${CSS.escape(t.id)}"]`);
        if (!el) return;
        const all = [...b.features.flatMap((f) => f.items), ...b.unsorted];
        const s = stats(all);
        const finished = b.features.filter((f) => f.done).length;
        el.innerHTML = `${b.features.length} stage${b.features.length === 1 ? '' : 's'} · ${finished} finished · ${s.bugsTotal - s.bugsDone} open bug${s.bugsTotal - s.bugsDone === 1 ? '' : 's'}
          <div class="minibar"><div class="fill" style="width:${s.pct}%"></div></div>`;
      })
      .catch((e) => {
        const el = document.querySelector(`.team-stats[data-team="${CSS.escape(t.id)}"]`);
        if (el) el.textContent = `Couldn't load: ${e.message}`;
      });
  }
}

/* =========================================================
   Screen 2: world map (features of a project)
   ========================================================= */
async function renderTeam(pkey, tid) {
  if (!state.boards[`${pkey}/${tid}`]) loadingScreen('LOADING TEAM');
  const board = await loadBoard(pkey, tid);
  const team = board.team;
  const project = board.project;
  setCrumbs([{ label: 'Circuits', href: '#/' }, { label: project.name, href: `#/p/${enc(pkey)}` }, { label: team.name }]);

  const levels = board.features.map((f) => ({ f, s: stats(f.items, f.done) }));
  const cleared = levels.filter(({ f }) => f.done).length;
  // Counters cover everything on the board, including issues that aren't in any feature.
  const everything = stats([...board.features.flatMap((f) => f.items), ...board.unsorted]);
  const bugsLeft = everything.bugsTotal - everything.bugsDone;
  const coins = everything.tasksDone;

  const card = ({ f, s }, i) => {
    // Finished only when the feature itself is marked done in Jira, not just because its items are.
    const clear = f.done;
    const ready = !f.done && !f.pseudo && s.total > 0 && s.pct === 100;
    const tag = f.pseudo
      ? 'FREE PRACTICE · NO FEATURE'
      : clear
        ? `FINISHED${f.doneAt ? ` · ${esc(fmtDate(f.doneAt).toUpperCase())}` : ''}`
        : `STAGE ${i + 1}`;
    return `
      <a class="card level-card ${clear ? 'clear' : ''}" href="${teamHref(pkey, tid, `/f/${enc(f.key)}`)}">
        <div class="level-top">
          <span class="pixel tag">${tag}</span>
          ${clear ? '<span class="pixel stamp">🏁</span>' : ready ? '<span class="ready-tag">Ready to mark done</span>' : ''}
        </div>
        <h2>${esc(f.summary)}</h2>
        <span class="key">${f.pseudo ? 'No feature' : esc(f.key)}${f.done ? ' · feature done' : ''}${
          f.linked ? ` <span class="link-tag" title="Linked from another project">🔗 ${esc(f.projectKey)}</span>` : ''
        }</span>
        <div class="minibar" role="img" aria-label="${s.pct}% complete">
          <div class="fill" style="width:${s.pct}%"></div>
          <span class="minihero" style="left:${s.pct}%">${SPRITES.carSmall}</span>
        </div>
        <div class="counts">
          <span title="Tasks and stories done">${SPRITES.checkeredSmall}<b>${s.tasksDone}/${s.tasksTotal}</b></span>
          <span title="Bugs cleared">${SPRITES.coneIcon}<b>${s.bugsDone}/${s.bugsTotal}</b></span>
          <span class="pct pixel">${s.pct}%</span>
        </div>
      </a>`;
  };

  // Tasks, stories and bugs that aren't in any feature. Always shown so it's easy to find.
  const bonus = card({ f: findFeature(board, UNSORTED), s: stats(board.unsorted) }, -1);

  // Unfinished stages first; finished ones in their own section that can be collapsed.
  const order = stageOrder(board.features);
  const statsOf = (f) => levels.find((l) => l.f === f);
  const openCards = order.open.map((f, i) => card(statsOf(f), i)).join('');
  const finishedCards = order.finished.map((f, i) => card(statsOf(f), i)).join('');
  const foldKey = `bq.finishedOpen.${pkey}/${tid}`;
  const finishedOpen = store.get(foldKey, true);

  app.innerHTML = `
    <section class="screen">
      <div class="screen-head">
        <div>
          <span class="pixel tag">${tid === ALL_TEAM ? 'WHOLE PROJECT' : 'TEAM'} · ${esc(project.name)}</span>
          <h1>${esc(tid === ALL_TEAM ? project.name : team.name)}</h1>
          <span class="key filter-line" title="${esc(filterSummary(team, pkey))}">⛃ ${esc(filterSummary(team, pkey))}</span>
          ${project.url ? ` · <a class="ext" href="${esc(project.url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : ''}
          ${teamDefaultsChips(team)}
        </div>
        <div class="actions">
          <button class="btn primary" id="new-feature" type="button">+ New feature</button>
          ${tid === ALL_TEAM ? '' : '<button class="btn" id="link-feature" type="button">🔗 Link existing feature</button>'}
          ${tid === ALL_TEAM ? '' : `<a class="btn" href="${teamHref(pkey, tid, '/settings')}">⚙ Team settings</a>`}
          <button class="btn" id="refresh" type="button" title="Reload from Jira">↻</button>
        </div>
      </div>
      ${viewTabs(pkey, tid, 'stages')}
      <div class="hud pixel world-hud">
        <div><label>STAGES</label><b>${cleared}/${levels.length} FINISHED</b></div>
        <div><label>CHECKPOINTS</label><b>${SPRITES.checkeredSmall} ×${coins}</b></div>
        <div><label>HAZARDS LEFT</label><b>${SPRITES.coneIcon} ×${bugsLeft}</b></div>
      </div>
      <div class="grid levels">
        ${openCards}
        ${bonus}
        <button class="card level-card add-card" id="new-feature-2" type="button">
          <span class="plus pixel">+</span><span>New feature</span>
        </button>
      </div>
      ${levels.length === 0 ? '<p class="muted center">No features (epics) yet. Create one, or link an existing one from Jira.</p>' : ''}
      ${
        order.finished.length
          ? `<details class="finished-section" id="finished-section" ${finishedOpen ? 'open' : ''}>
               <summary><span class="pixel">FINISHED STAGES</span> <span class="count">${order.finished.length}</span>
                 <span class="muted small-text">Newest first · click to ${finishedOpen ? 'collapse' : 'expand'}</span></summary>
               <div class="grid levels">${finishedCards}</div>
             </details>`
          : ''
      }
      ${
        board.hiddenFeatures?.length
          ? `<p class="muted center">${board.hiddenFeatures.length} hidden feature${board.hiddenFeatures.length > 1 ? 's' : ''}. <a href="${teamHref(pkey, tid, '/settings')}">Manage in Team settings</a></p>`
          : ''
      }
    </section>`;

  const newFeature = () =>
    openForm({
      title: 'NEW STAGE',
      intro: `A feature becomes an Epic in Jira and a new stage for this team.${defaultsSummary(team)}`,
      fields: [{ name: 'summary', label: 'Feature name', required: true, placeholder: 'Dark mode', maxlength: 250 }],
      submit: 'Create feature',
      async onSubmit({ summary }) {
        const res = await api('/issues', {
          method: 'POST',
          body: { projectKey: pkey, worldKey: pkey, teamId: tid, kind: 'epic', summary },
        });
        const { key } = res;
        reportDefaults(res);
        const fresh = await loadBoard(pkey, tid, true);
        Sound.play('spawn');
        if (!fresh.features.some((f) => f.key === key)) {
          toast(`${key} was created, but it doesn't match this team's filter, so it isn't shown here.`, 'warn');
          return renderTeam(pkey, tid);
        }
        toast(`Stage ${key} added for ${team.name}!`, 'success');
        location.hash = teamHref(pkey, tid, `/f/${enc(key)}`);
      },
    });
  $('#new-feature').addEventListener('click', newFeature);
  $('#new-feature-2').addEventListener('click', newFeature);
  $('#finished-section')?.addEventListener('toggle', (e) => {
    store.set(foldKey, e.target.open);
    const hint = e.target.querySelector('summary .small-text');
    if (hint) hint.textContent = `Newest first · click to ${e.target.open ? 'collapse' : 'expand'}`;
  });
  $('#link-feature')?.addEventListener('click', () => linkFeatureSearch(pkey, tid, board, () => renderTeam(pkey, tid)));
  $('#refresh').addEventListener('click', async () => {
    await loadBoard(pkey, tid, true);
    renderTeam(pkey, tid);
  });
}

// Tell the user when world defaults (labels, components, work group) couldn't all be set.
function reportDefaults(res) {
  if (res?.warning) toast(res.warning, 'warn');
  if (res?.skipped?.length) toast(`Not set on ${res.key}: ${res.skipped.join(', ')} (not available for that issue type or project).`, 'warn');
}

function defaultsSummary(world) {
  const d = world?.defaults;
  if (!d) return '';
  const parts = [];
  if (d.labels.length) parts.push(`labels ${d.labels.join(', ')}`);
  if (d.components.length) parts.push(`component ${d.components.join(', ')}`);
  if (d.workGroup) parts.push(`${d.workGroup.fieldName} ${d.workGroup.valueLabel}`);
  return parts.length ? `<br><small>Team defaults: ${esc(parts.join(' · '))}</small>` : '';
}

// Small chips under a team's title: what gets set automatically on new issues.
function teamDefaultsChips(team) {
  const d = team?.defaults;
  if (!d) return '';
  const chips = [
    ...(d.workGroup ? [`👥 ${d.workGroup.fieldName}: ${d.workGroup.valueLabel}`] : []),
    ...d.components.map((c) => `🧩 ${c}`),
    ...d.labels.map((l) => `🏷 ${l}`),
  ];
  return chips.length
    ? `<div class="team-chips" title="Set automatically on new issues">${chips.map((c) => `<span class="label-chip">${esc(c)}</span>`).join('')}</div>`
    : '';
}

// Unfinished stages in Jira order; finished ones (feature marked done) newest first, oldest last.
function stageOrder(features) {
  const open = features.filter((f) => !f.done);
  const finished = features
    .filter((f) => f.done)
    .sort((a, b) => (b.doneAt || b.created || '').localeCompare(a.doneAt || a.created || ''));
  return { open, finished };
}

function filterSummary(world, pkey) {
  const f = world?.filter;
  if (!f || f.mode === 'project') return `Whole project ${pkey}`;
  if (f.mode === 'saved') return `Saved filter: ${f.filterName || f.filterId}`;
  return `JQL: ${f.jql}`;
}

async function saveTeam(pkey, tid, patch) {
  const saved = await api(`/projects/${enc(pkey)}/teams/${enc(tid)}`, { method: 'PUT', body: patch });
  if (state.boards[`${pkey}/${tid}`]) state.boards[`${pkey}/${tid}`].team = saved;
  delete state.teams[pkey];
  return saved;
}

// Search Jira epics and add them to this world. Hidden native features get un-hidden instead.
function linkFeatureSearch(pkey, tid, board, rerender) {
  const world = { linked: [...(board.team?.linked || [])], hidden: [...(board.team?.hidden || [])] };
  const inWorld = new Set(board.features.map((f) => f.key));
  let changed = false;
  openSearch({
    title: 'LINK A FEATURE',
    intro: `Pick existing features (epics) from Jira to show as stages in <b>${esc(board.project.name)}</b>. This only changes Bug Rally; nothing is changed in Jira.`,
    kind: 'feature',
    pkey,
    isAdded: (it) => inWorld.has(it.key),
    onPick: async (it) => {
      if (world.hidden.includes(it.key)) world.hidden = world.hidden.filter((k) => k !== it.key);
      else if (!inWorld.has(it.key)) world.linked.push(it.key);
      await saveTeam(pkey, tid, world);
      inWorld.add(it.key);
      changed = true;
    },
    onClose: async () => {
      if (!changed) return;
      await loadBoard(pkey, tid, true);
      toast('Team page updated', 'success');
      rerender();
    },
  });
}

// Switch between the race view (stages) and the Kanban view of a team page.
function viewTabs(pkey, tid, active) {
  const tab = (id, label, href) =>
    `<a class="view-tab ${active === id ? 'active' : ''}" href="${href}" ${active === id ? 'aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="view-tabs" aria-label="View">
    ${tab('stages', '🏁 Stages', teamHref(pkey, tid))}
    ${tab('kanban', '🚦 Kanban', teamHref(pkey, tid, '/kanban'))}
  </nav>`;
}

// Dialog to name Kanban columns and choose which Jira status goes where.
function editColumns(kb, saveLayout) {
  const dlg = $('#modal');
  const form = $('#modal-form');
  closeDrawer();
  const statuses = kb.allStatuses?.length
    ? kb.allStatuses
    : kb.columns.flatMap((c) => c.statuses.map((st) => ({ ...st, category: c.category })));
  // Start from what's on screen.
  const real = kb.columns.filter((c) => c.id !== 'other');
  let cols = real.map((c) => ({ name: c.name }));
  if (!cols.length) cols = [{ name: 'To Do' }, { name: 'In Progress' }];
  const assign = new Map(statuses.map((st) => [st.id, -1]));
  real.forEach((c, i) => c.statuses.forEach((st) => assign.set(st.id, i)));

  const readNames = () =>
    $$('[data-col]', form).forEach((inp) => {
      cols[Number(inp.dataset.col)].name = inp.value;
    });
  const readAssign = () =>
    $$('[data-st]', form).forEach((sel) => {
      assign.set(sel.dataset.st, Number(sel.value));
    });

  const draw = () => {
    form.innerHTML = `
      <h2 class="pixel">KANBAN COLUMNS</h2>
      <p class="muted">Name the columns and pick which Jira status goes in which column.
      A column with Done statuses (like Done or Closed) shows what was finished in the last 14 days, and dropping a card there finishes it.
      Done statuses left under “Other statuses” aren't shown; then a separate Done drop zone appears.</p>
      <div class="col-editor">
        <h3>Columns <small class="muted">left to right</small></h3>
        <ol class="col-list">
          ${cols
            .map(
              (c, i) => `<li>
                <input data-col="${i}" value="${esc(c.name)}" maxlength="40" required aria-label="Column ${i + 1} name" />
                <button type="button" class="tb" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move left">←</button>
                <button type="button" class="tb" data-down="${i}" ${i === cols.length - 1 ? 'disabled' : ''} title="Move right">→</button>
                <button type="button" class="tb" data-del="${i}" ${cols.length === 1 ? 'disabled' : ''} title="Remove column">✕</button>
              </li>`,
            )
            .join('')}
        </ol>
        <button type="button" class="btn small" data-add ${cols.length >= 12 ? 'disabled' : ''}>+ Add column</button>
        <h3>Statuses</h3>
        <div class="status-map">
          ${statuses
            .map(
              (st) => `<label class="status-row">
                <span><span class="kc-status ${st.category === 'done' ? 'done' : ''}">${esc(st.name)}</span> <small class="muted">${st.category === 'new' ? 'to do' : st.category === 'done' ? 'done' : 'in progress'}</small></span>
                <select data-st="${esc(st.id)}" aria-label="Column for ${esc(st.name)}">
                  ${cols.map((c, i) => `<option value="${i}" ${assign.get(st.id) === i ? 'selected' : ''}>${esc(c.name || `Column ${i + 1}`)}</option>`).join('')}
                  <option value="-1" ${assign.get(st.id) === -1 ? 'selected' : ''}>Other statuses</option>
                </select>
              </label>`,
            )
            .join('')}
        </div>
      </div>
      <p class="form-error" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Save columns</button>
      </div>`;
    $('[data-cancel]', form).onclick = () => dlg.close();
  };

  form.oninput = (e) => {
    // Keep the status dropdowns' column names in step with the name fields.
    if (e.target.dataset.col !== undefined) {
      const i = e.target.dataset.col;
      $$(`[data-st] option[value="${i}"]`, form).forEach((o) => (o.textContent = e.target.value || `Column ${Number(i) + 1}`));
    }
  };
  form.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const shift = (fn) => {
      readNames();
      readAssign();
      fn();
      draw();
    };
    if (b.dataset.add !== undefined) shift(() => cols.push({ name: '' }));
    if (b.dataset.del !== undefined) {
      const i = Number(b.dataset.del);
      shift(() => {
        cols.splice(i, 1);
        for (const [id, c] of assign) assign.set(id, c === i ? -1 : c > i ? c - 1 : c);
      });
    }
    const swap = (i, j) => {
      [cols[i], cols[j]] = [cols[j], cols[i]];
      for (const [id, c] of assign) assign.set(id, c === i ? j : c === j ? i : c);
    };
    if (b.dataset.up !== undefined) shift(() => swap(Number(b.dataset.up), Number(b.dataset.up) - 1));
    if (b.dataset.down !== undefined) shift(() => swap(Number(b.dataset.down), Number(b.dataset.down) + 1));
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    readNames();
    readAssign();
    const err = $('.form-error', form);
    if (cols.some((c) => !c.name.trim())) {
      err.textContent = 'Give every column a name.';
      err.hidden = false;
      return;
    }
    const columns = cols.map((c, i) => ({
      name: c.name.trim(),
      statusIds: statuses.filter((st) => assign.get(st.id) === i).map((st) => st.id),
    }));
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await saveLayout({ mode: 'custom', columns });
      dlg.close();
      toast('Kanban columns saved', 'success');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Save columns';
    }
  };
  draw();
  dlg.showModal();
}

/* =========================================================
   Screen 2a: Kanban for a team page (ranked by Jira Rank)
   ========================================================= */
async function renderKanban(pkey, tid) {
  const first = !$('.kanban');
  if (first) loadingScreen('LOADING KANBAN');
  const [board, kb, boards] = await Promise.all([
    loadBoard(pkey, tid),
    api(`/projects/${enc(pkey)}/teams/${enc(tid)}/kanban`),
    api(`/projects/${enc(pkey)}/boards`).catch((e) => ({ error: e.message })),
  ]);
  const boardsError = Array.isArray(boards) ? null : boards.error;
  const boardList = Array.isArray(boards) ? boards : [];
  const colOf = (it) => kb.columns.find((c) => c.statuses.some((st) => st.id === it.statusId));
  const team = board.team;
  const project = board.project;
  setCrumbs([
    { label: 'Circuits', href: '#/' },
    { label: project.name, href: `#/p/${enc(pkey)}` },
    { label: team.name, href: teamHref(pkey, tid) },
    { label: 'Kanban' },
  ]);
  const bugName = board.bugTypeName || 'Bug';
  const byKey = new Map(kb.issues.map((i) => [i.key, i]));
  const initials = (name) =>
    String(name || '')
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

  const cardHtml = (it) => {
    const grouped = (colOf(it)?.statuses.length || 0) > 1;
    return `
    <article class="kcard ${esc(it.type)} ${it.done ? 'is-done' : ''}" draggable="true" tabindex="0" data-key="${esc(it.key)}"
      aria-label="${esc(`${it.typeName} ${it.key}: ${it.summary}. Status ${it.statusName}. Alt+Up or Alt+Down to change rank.`)}">
      <div class="kc-top">
        <span class="q-icon" title="${esc(it.typeName)}">${it.type === 'bug' ? SPRITES.coneIcon : it.type === 'story' ? SPRITES.storyIcon : SPRITES.taskIcon}</span>
        <span class="kc-key">${esc(it.key)}</span>
        ${it.priority ? `<span class="kc-prio prio-${esc(String(it.priority).toLowerCase())}" title="Priority">${esc(it.priority)}</span>` : ''}
        ${it.assignee ? `<span class="kc-avatar" title="${esc(it.assignee)}">${esc(initials(it.assignee))}</span>` : ''}
      </div>
      <div class="kc-sum">${esc(it.summary)}</div>
      <div class="kc-meta">
        ${grouped ? `<span class="kc-status">${esc(it.statusName)}</span>` : ''}
        ${
          it.parentKey
            ? `<span class="kc-feature" title="Feature ${esc(it.parentKey)}">🏁 ${esc(it.parentSummary || it.parentKey)}</span>`
            : '<span class="kc-feature none">No feature</span>'
        }
      </div>
    </article>`;
  };

  const colHtml = (c) => {
    const items = kb.issues.filter((i) => colOf(i) === c);
    return `
      <section class="kcol cat-${esc(c.category)}" data-status="${esc(c.id)}">
        <header>
          <span class="kcol-name">${esc(c.name)}</span><span class="count">${items.length}</span>
          ${c.statuses.length > 1 ? `<small class="kcol-statuses" title="Jira statuses in this column">${c.statuses.map((st) => esc(st.name)).join(' · ')}</small>` : ''}
          ${c.category === 'done' ? `<small class="kcol-statuses">Finished in the last ${kb.doneWindowDays || 14} days</small>` : ''}
        </header>
        <div class="klist" data-status="${esc(c.id)}">${items.map(cardHtml).join('')}</div>
      </section>`;
  };
  const layoutValue = kb.layout?.mode === 'board' ? `board:${kb.layout.boardId}` : kb.layout?.mode || 'category';
  const boardOptions = [...boardList];
  if (kb.layout?.mode === 'board' && !boardList.some((b) => b.id === kb.layout.boardId)) {
    boardOptions.push({ id: kb.layout.boardId, name: kb.layout.boardName || `Board ${kb.layout.boardId}` });
  }

  // Left rail: the team's unfinished features with progress. Not part of the board (no dropping here);
  // clicking one highlights its cards.
  const focusKey = `${pkey}/${tid}`;
  const onBoard = (fk) => kb.issues.filter((i) => !i.done && (fk === '_none' ? !i.parentKey : i.parentKey === fk)).length;
  const hasDoneColumn = kb.columns.some((c) => c.category === 'done');
  const unfinished = kb.issues.filter((i) => !i.done);
  const featureRail = () => {
    const open = stageOrder(board.features).open;
    const item = (f, i) => {
      const s = stats(f.items);
      const bugsLeft = s.bugsTotal - s.bugsDone;
      return `
        <div class="kfeat" data-feature="${esc(f.key)}">
          <button type="button" class="kf-select" data-focus="${esc(f.key)}" aria-pressed="false" title="Highlight this feature's cards">
            <span class="kf-top"><span class="pixel kf-stage">STAGE ${i + 1}</span><span class="kf-count">${onBoard(f.key)} on board</span></span>
            <span class="kf-name">${esc(f.summary)}</span>
            <span class="kf-key">${esc(f.key)}${s.total && s.pct === 100 ? ' · <span class="ready-tag">Ready to mark done</span>' : ''}</span>
            <span class="minibar" role="img" aria-label="${s.pct}% complete"><span class="fill" style="width:${s.pct}%"></span><span class="minihero" style="left:${s.pct}%">${SPRITES.carSmall}</span></span>
            <span class="kf-stats">${SPRITES.checkeredSmall} ${s.tasksDone}/${s.tasksTotal} · ${SPRITES.coneIcon} ${bugsLeft} open · <b>${s.pct}%</b></span>
          </button>
          <a class="kf-open" href="${teamHref(pkey, tid, `/f/${enc(f.key)}`)}" title="Open the stage">🏁</a>
        </div>`;
    };
    return `
      <aside class="kfeatures" aria-label="Unfinished features">
        <header><span class="kcol-name">🏁 Features</span><span class="count">${open.length}</span></header>
        <p class="kf-sub">Not part of the board. Click one to highlight its cards.</p>
        <button type="button" class="linklike kf-clear" id="kf-clear" hidden>✕ Show all cards</button>
        <div class="kf-list">
          ${open.map(item).join('') || '<p class="muted small-text">No unfinished features.</p>'}
          <div class="kfeat none" data-feature="_none">
            <button type="button" class="kf-select" data-focus="_none" aria-pressed="false" title="Highlight cards that aren't in any feature">
              <span class="kf-top"><span class="pixel kf-stage">NO FEATURE</span><span class="kf-count">${onBoard('_none')} on board</span></span>
              <span class="kf-name">Not in any feature</span>
            </button>
          </div>
        </div>
      </aside>`;
  };

  const bugsOpen = unfinished.filter((i) => i.type === 'bug').length;
  app.innerHTML = `
    <section class="screen kanban">
      <div class="screen-head">
        <div>
          <span class="pixel tag">${tid === ALL_TEAM ? 'WHOLE PROJECT' : 'TEAM'} · ${esc(project.name)}</span>
          <h1>${esc(tid === ALL_TEAM ? project.name : team.name)}</h1>
          <span class="key filter-line" title="${esc(filterSummary(team, pkey))}">⛃ ${esc(filterSummary(team, pkey))}</span>
          ${teamDefaultsChips(team)}
        </div>
        <div class="actions">
          <button class="btn" data-new="task" type="button">${SPRITES.taskIcon} + Task</button>
          <button class="btn" data-new="story" type="button">${SPRITES.storyIcon} + Story</button>
          <button class="btn danger" data-new="bug" type="button">${SPRITES.coneIcon} + ${esc(bugName)}</button>
          <button class="btn" id="refresh" type="button" title="Reload from Jira">↻</button>
        </div>
      </div>
      ${viewTabs(pkey, tid, 'kanban')}
      <div class="kanban-bar">
        <label class="layout-pick">Columns
          <select id="kb-layout" aria-label="Kanban columns">
            ${boardOptions.map((b) => `<option value="board:${esc(b.id)}" ${layoutValue === `board:${b.id}` ? 'selected' : ''}>Like Jira board: ${esc(b.name)}</option>`).join('')}
            <option value="custom" ${layoutValue === 'custom' ? 'selected' : ''}>My own columns…</option>
            <option value="category" ${layoutValue === 'category' ? 'selected' : ''}>To Do / In Progress</option>
            <option value="status" ${layoutValue === 'status' ? 'selected' : ''}>One column per status</option>
          </select>
        </label>
        <button class="btn small" id="edit-cols" type="button">✎ Edit columns</button>
        ${kb.layoutError ? `<span class="form-error small-text">${esc(kb.layoutError)}</span>` : ''}
        ${
          boardsError
            ? `<span class="muted small-text" title="${esc(boardsError)}">Jira boards couldn't be listed (${esc(boardsError)}), so “Like Jira board” isn't available. Use “My own columns” instead.</span>`
            : !boardList.length
              ? '<span class="muted small-text">No Jira boards found for this project.</span>'
              : ''
        }
      </div>
      <p class="muted small-text kanban-help">
        ${unfinished.length} unfinished, ${bugsOpen} of them ${/^bugs?$/i.test(bugName) ? 'bugs' : `${esc(bugName.toLowerCase())}s or bugs`}. Sorted by Jira Rank, top = highest.
        Drag a card above another to change its rank, or to another column to change its status. Drop on <b>Done</b> to finish it.
        Keyboard: focus a card and press Alt+↑ / Alt+↓.
      </p>
      <div class="kanban-wrap">
        ${featureRail()}
        <div class="kboard" id="kboard">
          ${kb.columns.map(colHtml).join('')}
          ${
            hasDoneColumn
              ? ''
              : `<section class="kcol done-col" data-done="1">
            <header><span class="kcol-name">Done ✓</span></header>
            <div class="klist" data-done="1"><p class="done-hint">Drop here to mark done</p></div>
          </section>`
          }
        </div>
      </div>
      ${unfinished.length === 0 ? '<p class="muted center">Nothing unfinished for this team. Clear road ahead!</p>' : ''}
    </section>`;

  const ctx = {
    pkey,
    tid,
    board,
    feature: findFeature(board, UNSORTED),
    onChange: () => renderKanban(pkey, tid),
  };
  $$('[data-new]').forEach((b) => b.addEventListener('click', () => createItemForm(b.dataset.new, ctx)));
  $('#refresh').addEventListener('click', async () => {
    await loadBoard(pkey, tid, true);
    renderKanban(pkey, tid);
  });
  const saveLayout = async (layout) => {
    await api(`/projects/${enc(pkey)}/teams/${enc(tid)}/kanban-layout`, { method: 'PUT', body: layout });
    renderKanban(pkey, tid);
  };
  $('#edit-cols').addEventListener('click', () => editColumns(kb, saveLayout));
  $('#kb-layout').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === 'custom') {
      e.target.value = layoutValue; // stays until the editor is saved
      editColumns(kb, saveLayout);
      return;
    }
    const layout = v.startsWith('board:')
      ? { mode: 'board', boardId: v.slice(6), boardName: boardOptions.find((b) => `board:${b.id}` === v)?.name || '' }
      : { mode: v };
    try {
      await api(`/projects/${enc(pkey)}/teams/${enc(tid)}/kanban-layout`, { method: 'PUT', body: layout });
      renderKanban(pkey, tid);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const kboard = $('#kboard');

  // Highlight the cards of the chosen feature; everything else fades.
  const applyFocus = () => {
    const fk = state.kanbanFocus[focusKey] || null;
    kboard.classList.toggle('focus-mode', Boolean(fk));
    $$('.kcard', kboard).forEach((c) => {
      const it = byKey.get(c.dataset.key);
      const hit = fk && (fk === '_none' ? !it?.parentKey : it?.parentKey === fk);
      c.classList.toggle('hl', Boolean(hit));
    });
    $$('[data-focus]').forEach((b) => {
      const on = b.dataset.focus === fk;
      b.setAttribute('aria-pressed', String(on));
      b.closest('.kfeat').classList.toggle('active', on);
    });
    $('#kf-clear').hidden = !fk;
  };
  $$('[data-focus]').forEach((b) =>
    b.addEventListener('click', () => {
      state.kanbanFocus[focusKey] = state.kanbanFocus[focusKey] === b.dataset.focus ? null : b.dataset.focus;
      applyFocus();
      const first = $('.kcard.hl', kboard);
      if (first) first.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      else if (state.kanbanFocus[focusKey]) toast('None of its unfinished cards are on the board.');
    }),
  );
  $('#kf-clear').addEventListener('click', () => {
    state.kanbanFocus[focusKey] = null;
    applyFocus();
  });
  if (state.kanbanFocus[focusKey] && !$(`[data-focus="${CSS.escape(state.kanbanFocus[focusKey])}"]`)) state.kanbanFocus[focusKey] = null;
  applyFocus();
  const counts = () =>
    $$('.kcol[data-status]', kboard).forEach((col) => {
      col.querySelector('.count').textContent = col.querySelectorAll('.kcard').length;
    });

  // Open details on click (but not at the end of a drag).
  let justDragged = false;
  kboard.addEventListener('click', (e) => {
    const card = e.target.closest('.kcard');
    if (!card || justDragged) return;
    openDrawer(byKey.get(card.dataset.key), ctx);
  });
  kboard.addEventListener('keydown', (e) => {
    const card = e.target.closest('.kcard');
    if (!card) return;
    if (e.key === 'Enter') openDrawer(byKey.get(card.dataset.key), ctx);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const sib = e.key === 'ArrowUp' ? card.previousElementSibling : card.nextElementSibling;
      if (!sib?.classList.contains('kcard')) return;
      if (e.key === 'ArrowUp') sib.before(card);
      else sib.after(card);
      card.focus();
      commitMove(card, e.key === 'ArrowUp' ? { before: sib.dataset.key } : { after: sib.dataset.key });
    }
  });

  // Drag and drop
  let dragged = null;
  const placeholder = document.createElement('div');
  placeholder.className = 'kplaceholder';

  kboard.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kcard');
    if (!card) return;
    dragged = card;
    justDragged = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.key);
    placeholder.style.height = `${card.offsetHeight}px`;
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  kboard.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    placeholder.remove();
    $$('.klist.over', kboard).forEach((l) => l.classList.remove('over'));
    dragged = null;
    setTimeout(() => (justDragged = false), 50);
  });
  kboard.addEventListener('dragover', (e) => {
    const list = e.target.closest('.klist');
    if (!dragged || !list) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.klist.over', kboard).forEach((l) => l !== list && l.classList.remove('over'));
    list.classList.add('over');
    if (list.dataset.done) {
      placeholder.remove();
      return;
    }
    const cards = [...list.querySelectorAll('.kcard:not(.dragging)')];
    const next = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (next) {
      if (placeholder.nextElementSibling !== next) next.before(placeholder);
    } else if (list.lastElementChild !== placeholder) list.append(placeholder);
  });
  kboard.addEventListener('drop', (e) => {
    const list = e.target.closest('.klist');
    if (!dragged || !list) return;
    e.preventDefault();
    list.classList.remove('over');
    const card = dragged;
    const fromStatus = card.closest('.klist').dataset.status;

    if (list.dataset.done) {
      placeholder.remove();
      card.classList.add('finishing');
      commitMove(card, { done: true });
      return;
    }
    const toStatus = list.dataset.status;
    let sib = card.nextElementSibling;
    while (sib && !sib.classList.contains('kcard')) sib = sib.nextElementSibling;
    const oldNext = sib ? sib.dataset.key : null;
    // Where did it land? Rank it above the card now below it, or after the last card.
    let nextCard = placeholder.nextElementSibling;
    while (nextCard && (!nextCard.classList.contains('kcard') || nextCard === card)) nextCard = nextCard.nextElementSibling;
    placeholder.replaceWith(card);
    const move = {};
    if (toStatus !== fromStatus) move.statusIds = kb.columns.find((c) => c.id === toStatus).statuses.map((st) => st.id);
    if (nextCard) {
      if (toStatus !== fromStatus || nextCard.dataset.key !== oldNext) move.before = nextCard.dataset.key;
    } else {
      const others = [...list.querySelectorAll('.kcard')].filter((c) => c !== card);
      const last = others[others.length - 1];
      if (last && (toStatus !== fromStatus || oldNext !== null)) move.after = last.dataset.key;
    }
    if (!Object.keys(move).length) return; // dropped where it already was
    commitMove(card, move);
  });

  async function commitMove(card, move) {
    const key = card.dataset.key;
    card.classList.add('saving');
    counts();
    try {
      await api(`/issues/${enc(key)}/move`, { method: 'POST', body: move });
      // Other views of this project are now out of date.
      for (const k of Object.keys(state.boards)) if (k.startsWith(`${pkey}/`)) delete state.boards[k];
      if (move.done) {
        Sound.play('coin');
        toast(`${key} done 🏁`, 'success');
        setTimeout(() => renderKanban(pkey, tid), 350); // also updates the features' progress
      } else {
        card.classList.remove('saving');
        card.classList.add('moved');
        setTimeout(() => card.classList.remove('moved'), 900);
        if (move.statusIds) {
          const col = kb.columns.find((c) => c.id === card.closest('.klist')?.dataset.status);
          toast(`${key} → ${col?.name || 'moved'}`, 'success');
          // Show the exact Jira status it landed in.
          renderKanban(pkey, tid);
        }
      }
    } catch (err) {
      toast(err.message, 'error');
      renderKanban(pkey, tid); // put everything back the way Jira has it
    }
  }
}

/* =========================================================
   Screen 2b: world settings
   ========================================================= */
async function renderTeamSettings(pkey, tid) {
  if (tid === ALL_TEAM) {
    location.replace(teamHref(pkey, tid));
    return;
  }
  if (!state.boards[`${pkey}/${tid}`]) loadingScreen('LOADING TEAM');
  const [board, options] = await Promise.all([
    loadBoard(pkey, tid),
    api(`/projects/${enc(pkey)}/options`).catch((e) => ({ error: e.message, components: [], fields: [] })),
  ]);
  const world = board.team;
  const f = world.filter;
  const d = world.defaults;
  const jiraName = board.project.jiraName || board.project.name;
  const filtersOk = options.filtersAvailable !== false && !options.error;
  setCrumbs([
    { label: 'Circuits', href: '#/' },
    { label: board.project.name, href: `#/p/${enc(pkey)}` },
    { label: world.name, href: teamHref(pkey, tid) },
    { label: 'Settings' },
  ]);
  const missing = world.linked.filter((k) => !board.features.some((x) => x.key === k));
  const components = [...new Set([...(options.components || []), ...d.components])];
  const fields = [...(options.fields || [])];
  if (d.workGroup && !fields.some((x) => x.id === d.workGroup.fieldId)) {
    fields.push({ id: d.workGroup.fieldId, name: d.workGroup.fieldName, type: d.workGroup.fieldType, allowedValues: [] });
  }

  const row = (x, action, label) => `
    <li>
      <span class="q-key">${esc(x.key)}</span>
      <span class="q-sum">${esc(x.summary)}</span>
      <span class="q-status">${x.linked ? `🔗 from ${esc(x.projectKey)}` : 'matches filter'}</span>
      <button type="button" class="btn small" data-${action}="${esc(x.key)}">${label}</button>
    </li>`;
  const radio = (mode, label, extra = '') =>
    `<label class="radio"><input type="radio" name="mode" value="${mode}" ${f.mode === mode ? 'checked' : ''} ${
      mode !== 'project' && !filtersOk ? 'disabled' : ''
    } /> <span>${label}</span>${extra}</label>`;

  app.innerHTML = `
    <section class="screen">
      <div class="screen-head">
        <div>
          <span class="pixel tag">TEAM SETTINGS · ${esc(board.project.name)}</span>
          <h1>${esc(world.name)}</h1>
          <p class="muted">Decide what this team sees from Jira project ${esc(pkey)}, and what gets filled in automatically when the team creates issues here.
          Team pages only exist in Bug Rally; nothing here changes Jira.</p>
        </div>
        <div class="actions">
          <a class="btn" href="${teamHref(pkey, tid)}">← Back to team</a>
          <button class="btn danger" id="delete-team" type="button">Delete team page</button>
        </div>
      </div>

      <form id="world-form" class="settings-grid" autocomplete="off">
        <div class="stack">
          <div class="pixel-box">
            <h2 class="pixel box-title">GENERAL</h2>
            <label class="field"><span>Team name</span>
              <input name="name" maxlength="80" required placeholder="Team Rocket" value="${esc(world.name)}" />
              <small class="muted">Shown in Bug Rally only. New issues are created in Jira project <b>${esc(pkey)}</b> (${esc(jiraName)}).</small>
            </label>
          </div>

          <div class="pixel-box">
            <h2 class="pixel box-title">FILTER</h2>
            <p class="muted small-text">Which Jira issues belong to this world. Features (epics) that match become levels.</p>
            ${!filtersOk ? `<p class="form-error small-text">${esc(options.error || 'Filters need a Jira connection. In demo mode every team page shows the whole project.')}</p>` : ''}
            <div class="radios">
              ${radio('project', `Whole project <code>project = ${esc(pkey)}</code>`)}
              ${radio('jql', 'JQL query')}
              <div class="mode-panel" data-panel="jql">
                <textarea name="jql" rows="3" class="code-input" placeholder='project = ${esc(pkey)} AND component = "Web"'>${esc(f.jql)}</textarea>
                <small class="muted">Any JQL works, also across projects. ORDER BY is ignored.</small>
              </div>
              ${radio('saved', 'Saved Jira filter')}
              <div class="mode-panel" data-panel="saved">
                <input type="hidden" name="filterId" value="${esc(f.filterId)}" />
                <input type="hidden" name="filterName" value="${esc(f.filterName)}" />
                <div class="picked" id="picked-filter">${f.filterId ? `Selected: <b>${esc(f.filterName || f.filterId)}</b>` : '<span class="muted">No filter picked yet.</span>'}</div>
                <input type="search" id="filter-q" class="input wide" placeholder="Search your saved filters…" aria-label="Search saved filters" />
                <ul class="results compact" id="filter-results"></ul>
              </div>
            </div>
            <label class="check-label"><input type="checkbox" name="applyToItems" ${f.applyToItems ? 'checked' : ''} ${!filtersOk ? 'disabled' : ''} />
              Also filter the tasks and bugs inside each feature</label>
            <div class="test-row">
              <button type="button" class="btn" id="test-filter" ${!filtersOk ? 'disabled' : ''}>Test filter</button>
              <span id="test-result" class="small-text"></span>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="pixel-box">
            <h2 class="pixel box-title">DEFAULTS FOR NEW ISSUES</h2>
            <p class="muted small-text">Set automatically on every task, story, bug and feature you create in this world.</p>
            ${options.error ? `<p class="form-error small-text">Couldn't load the project's fields: ${esc(options.error)}</p>` : ''}
            <label class="field"><span>Labels</span>
              <input name="labels" placeholder="frontend team-rocket" value="${esc(d.labels.join(' '))}" />
              <small class="muted">Separate with spaces or commas. Jira labels can't contain spaces.</small>
            </label>
            <div class="field"><span>Components</span>
              ${
                components.length
                  ? `<div class="chip-checks">${components
                      .map(
                        (c) =>
                          `<label class="chip-check"><input type="checkbox" name="components" value="${esc(c)}" ${d.components.includes(c) ? 'checked' : ''} /><span>${esc(c)}</span></label>`,
                      )
                      .join('')}</div>`
                  : `<small class="muted">Project ${esc(pkey)} has no components.</small>`
              }
            </div>
            <div class="field"><span>Work group</span>
              <select name="wgField" id="wg-field" aria-label="Work group field">
                <option value="">Don't set a work group</option>
                ${fields.map((x) => `<option value="${esc(x.id)}" ${d.workGroup?.fieldId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
              </select>
              <div id="wg-value"></div>
              <small class="muted">Pick the Jira field your teams use (for example “Team” or a “Work group” select field)${
                options.fieldsFrom ? `. Fields are read from the ${esc(options.fieldsFrom)} create screen in ${esc(pkey)}` : ''
              }.</small>
            </div>
            <label class="field"><span>Issue type for bugs</span>
              <select name="bugType">
                <option value="">Automatic (Fault Report if ${esc(pkey)} has it, otherwise Bug)</option>
                ${[...new Set([...(options.issueTypes || []), ...(d.bugType ? [d.bugType] : [])])]
                  .map((t) => `<option value="${esc(t)}" ${t === d.bugType ? 'selected' : ''}>${esc(t)}</option>`)
                  .join('')}
              </select>
              <small class="muted">What “+ Bug” creates. Bugs, Defects and Fault Reports all show as traffic cones.</small>
            </label>
            <label class="check-label"><input type="checkbox" name="applyOnLink" ${d.applyOnLink ? 'checked' : ''} />
              Also add these when linking existing issues into a feature here</label>
          </div>
          <div class="save-bar">
            <p class="form-error" id="world-error" hidden></p>
            <button type="submit" class="btn primary" id="save-world">Save team settings</button>
          </div>
        </div>
      </form>

      <div class="settings-grid levels-settings">
        <div class="pixel-box">
          <h2 class="pixel box-title">LEVELS IN THIS WORLD <small>${board.features.length}</small></h2>
          <ul class="plain-list">
            ${board.features.map((x) => (x.linked ? row(x, 'unlink', 'Unlink') : row(x, 'hide', 'Hide'))).join('') || '<li class="muted">No features match yet.</li>'}
          </ul>
          <button class="btn" id="link-feature" type="button">🔗 Link existing feature</button>
        </div>
        <div class="pixel-box">
          <h2 class="pixel box-title">HIDDEN <small>${board.hiddenFeatures?.length || 0}</small></h2>
          <ul class="plain-list">
            ${(board.hiddenFeatures || []).map((x) => row(x, 'show', 'Show')).join('') || '<li class="muted">Nothing hidden.</li>'}
            ${missing.map((k) => `<li><span class="q-key">${esc(k)}</span><span class="q-sum muted">Linked, but Jira no longer returns it</span><span></span><button type="button" class="btn small" data-unlink="${esc(k)}">Remove</button></li>`).join('')}
          </ul>
          <p class="muted small-text">Linked features show up whatever the filter says. Hidden ones stay hidden even if they match.</p>
        </div>
      </div>
    </section>`;

  const form = $('#world-form');

  // Filter mode panels
  const syncMode = () => {
    const mode = form.elements.mode.value;
    $$('.mode-panel', form).forEach((p) => (p.hidden = p.dataset.panel !== mode));
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'mode') syncMode();
  });
  syncMode();

  // Saved filter picker
  const fq = $('#filter-q');
  const fr = $('#filter-results');
  let ft;
  let fseq = 0;
  const loadFilters = async () => {
    const my = ++fseq;
    fr.innerHTML = '<li class="muted">Searching…</li>';
    try {
      const list = await api(`/filters?q=${encodeURIComponent(fq.value)}`);
      if (my !== fseq) return;
      fr.innerHTML =
        list
          .map(
            (x) => `<li><span class="r-main"><b>${esc(x.name)}</b><small class="muted">${esc(x.jql)}${x.owner ? ` · by ${esc(x.owner)}` : ''}</small></span>
            <button type="button" class="btn small" data-filter="${esc(x.id)}" data-name="${esc(x.name)}" data-jql="${esc(x.jql)}">Use</button></li>`,
          )
          .join('') || '<li class="muted">No saved filters found.</li>';
    } catch (e) {
      if (my === fseq) fr.innerHTML = `<li class="form-error">${esc(e.message)}</li>`;
    }
  };
  fq.addEventListener('input', () => {
    clearTimeout(ft);
    ft = setTimeout(loadFilters, 300);
  });
  fq.addEventListener('focus', () => !fr.children.length && filtersOk && loadFilters(), { once: true });
  fr.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    form.elements.filterId.value = b.dataset.filter;
    form.elements.filterName.value = b.dataset.name;
    $('#picked-filter').innerHTML = `Selected: <b>${esc(b.dataset.name)}</b> <code>${esc(b.dataset.jql)}</code>`;
    fr.innerHTML = '';
    fq.value = '';
  });

  // Work group value control depends on the chosen field
  const wgField = $('#wg-field');
  const drawWgValue = () => {
    const field = fields.find((x) => x.id === wgField.value);
    const holder = $('#wg-value');
    if (!field) {
      holder.innerHTML = '';
      return;
    }
    const current = d.workGroup?.fieldId === field.id ? d.workGroup.value : '';
    if (field.allowedValues?.length) {
      holder.innerHTML = `<select name="wgValue" aria-label="Work group value">${field.allowedValues
        .map((v) => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`)
        .join('')}</select>`;
    } else {
      const hint =
        field.type === 'team'
          ? 'Team ID (open the team in Jira; it is the last part of the URL)'
          : field.type.includes('group')
            ? 'Jira group name'
            : 'Value';
      holder.innerHTML = `<input name="wgValue" placeholder="${esc(hint)}" value="${esc(current)}" aria-label="Work group value" />`;
    }
  };
  wgField.addEventListener('change', drawWgValue);
  drawWgValue();

  const readFilter = () => ({
    mode: form.elements.mode.value,
    jql: form.elements.jql.value,
    filterId: form.elements.filterId.value,
    filterName: form.elements.filterName.value,
    applyToItems: form.elements.applyToItems.checked,
  });

  $('#test-filter').addEventListener('click', async (e) => {
    const out = $('#test-result');
    e.target.disabled = true;
    out.className = 'small-text muted';
    out.textContent = 'Asking Jira…';
    try {
      const r = await api(`/projects/${enc(pkey)}/teams/${enc(tid)}/test-filter`, { method: 'POST', body: { filter: readFilter() } });
      out.className = 'small-text ok-text';
      out.textContent = `✓ Matches about ${r.issues} issues, ${r.features} of them features.`;
    } catch (err) {
      out.className = 'small-text form-error';
      out.textContent = err.message;
    } finally {
      e.target.disabled = !filtersOk;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#save-world');
    const errEl = $('#world-error');
    const field = fields.find((x) => x.id === wgField.value);
    const wgValueEl = form.elements.wgValue;
    const body = {
      name: form.elements.name.value,
      filter: readFilter(),
      defaults: {
        labels: form.elements.labels.value.split(/[\s,]+/).filter(Boolean),
        components: $$('input[name=components]:checked', form).map((c) => c.value),
        workGroup:
          field && wgValueEl?.value.trim()
            ? { fieldId: field.id, fieldName: field.name, fieldType: field.type, value: wgValueEl.value.trim(), valueLabel: wgValueEl.value.trim() }
            : null,
        applyOnLink: form.elements.applyOnLink.checked,
        bugType: form.elements.bugType.value,
      },
    };
    if (field && !body.defaults.workGroup) {
      errEl.textContent = `Enter a value for ${field.name}, or choose “Don't set a work group”.`;
      errEl.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    errEl.hidden = true;
    try {
      await saveTeam(pkey, tid, body);
      await loadBoard(pkey, tid, true);
      Sound.play('coin');
      toast('Team settings saved', 'success');
      renderTeamSettings(pkey, tid);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Save team settings';
    }
  });

  // Level list actions save immediately
  const lists = { linked: [...world.linked], hidden: [...world.hidden] };
  const update = async (fn) => {
    fn();
    try {
      await saveTeam(pkey, tid, lists);
      await loadBoard(pkey, tid, true);
      renderTeamSettings(pkey, tid);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $$('[data-hide]').forEach((b) => b.addEventListener('click', () => update(() => lists.hidden.push(b.dataset.hide))));
  $$('[data-show]').forEach((b) =>
    b.addEventListener('click', () => update(() => (lists.hidden = lists.hidden.filter((k) => k !== b.dataset.show)))),
  );
  $$('[data-unlink]').forEach((b) =>
    b.addEventListener('click', () => update(() => (lists.linked = lists.linked.filter((k) => k !== b.dataset.unlink)))),
  );
  $('#link-feature').addEventListener('click', () => linkFeatureSearch(pkey, tid, board, () => renderTeamSettings(pkey, tid)));
  $('#delete-team').addEventListener('click', () =>
    openForm({
      title: 'DELETE TEAM PAGE',
      intro: `Delete the team page <b>${esc(world.name)}</b> and its settings? Nothing in Jira is changed or deleted.`,
      fields: [],
      submit: 'Delete team page',
      async onSubmit() {
        await api(`/projects/${enc(pkey)}/teams/${enc(tid)}`, { method: 'DELETE' });
        delete state.teams[pkey];
        delete state.boards[`${pkey}/${tid}`];
        toast(`Team page ${world.name} deleted`);
        location.hash = `#/p/${enc(pkey)}`;
      },
    }),
  );
}

/* =========================================================
   Screen 3: the level (one feature)
   ========================================================= */
const GROUND = 30; // where cars and objects stand on the road
const CAR_HALF = 56;
const FIRST_X = 280;
const GAP = 150;

function orderItems(items) {
  const done = items.filter((i) => i.done).sort((a, b) => (a.doneAt || a.created).localeCompare(b.doneAt || b.created));
  const open = items.filter((i) => !i.done).sort((a, b) => a.created.localeCompare(b.created));
  return [...done, ...open];
}

// Deterministic pseudo-random so scenery doesn't jump around between renders.
function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function scenery(width, seed) {
  const r = rng(seed);
  let html = '';
  for (let x = 40 + r() * 120; x < width; x += 280 + r() * 240) {
    html += `<div class="cloud" style="left:${x}px;top:${14 + r() * 60}px;animation-delay:-${(r() * 20).toFixed(1)}s">${SPRITES.cloud}</div>`;
  }
  // Distant hills, then a city skyline
  for (let x = r() * 200; x < width; x += 420 + r() * 260) {
    const w = 260 + r() * 200;
    html += `<div class="hill far" style="left:${x}px;width:${w}px;height:${w * (0.35 + r() * 0.15)}px"></div>`;
  }
  for (let x = r() * 60; x < width; ) {
    const w = 34 + Math.floor(r() * 5) * 10;
    const h = 60 + Math.floor(r() * 9) * 14;
    const tone = r() > 0.5 ? 'b' : 'a';
    html += `<div class="building ${tone}" style="left:${x}px;width:${w}px;height:${h}px"></div>`;
    x += w + (r() > 0.7 ? 30 + r() * 80 : 4);
  }
  for (let x = 160 + r() * 160; x < width - 120; x += 260 + r() * 200) {
    html += r() > 0.45
      ? `<div class="bush" style="left:${x}px">${SPRITES.bush}</div>`
      : `<div class="lamp" style="left:${x}px"></div>`;
  }
  return html;
}

function entityHtml(it, i, x) {
  const label = `<span class="ent-label">${esc(it.key)}</span>`;
  const isNew = state.justCreated === it.key ? 'spawn' : '';
  const aria = `${it.typeName} ${it.key}: ${it.summary}. ${it.done ? 'Done' : 'Open'}.`;
  if (it.type === 'bug') {
    return `<button type="button" class="ent bug ${it.done ? 'done' : ''} ${isNew}" data-key="${esc(it.key)}"
      style="left:${x}px;bottom:${GROUND}px;--d:${(i * 0.37) % 1.5}s" aria-label="${esc(aria)}">
      ${
        it.done
          ? `<span class="sprite knocked">${SPRITES.coneB}</span>`
          : `<span class="sprite blink"><span class="f a">${SPRITES.coneA}</span><span class="f b">${SPRITES.coneB}</span></span>`
      }
      ${label}</button>`;
  }
  const sprite = it.done ? SPRITES.flag : it.type === 'story' ? SPRITES.storyCan : SPRITES.taskCan;
  return `<button type="button" class="ent can ${it.type} ${it.done ? 'done' : ''} ${isNew}" data-key="${esc(it.key)}"
      style="left:${x}px;bottom:${GROUND}px;--d:${(i * 0.29) % 1.2}s" aria-label="${esc(aria)}">
      <span class="sprite">${sprite}</span>${label}</button>`;
}

async function renderLevel(pkey, tid, fkey) {
  if (!state.boards[`${pkey}/${tid}`]) loadingScreen('LOADING STAGE');
  const board = await loadBoard(pkey, tid);
  const feature = findFeature(board, fkey);
  if (!feature) throw new Error(`Feature ${fkey} was not found in ${pkey}.`);
  setCrumbs([
    { label: 'Circuits', href: '#/' },
    { label: board.project.name, href: `#/p/${enc(pkey)}` },
    { label: board.team.name, href: teamHref(pkey, tid) },
    { label: feature.pseudo ? 'Not in any feature' : feature.key },
  ]);

  const items = orderItems(feature.items);
  const s = stats(items, feature.done);
  // "Finished" means the feature is marked done in Jira. All items done is only the last step before that.
  const finished = feature.done && !feature.pseudo;
  const allItemsDone = items.length > 0 && s.pct === 100;
  const levelNo = stageOrder(board.features).open.indexOf(feature) + 1;
  const xs = items.map((_, i) => FIRST_X + i * GAP);
  const finishX = FIRST_X + Math.max(0, items.length - 1) * GAP + (items.length ? 200 : 140);
  const width = finishX + 300;
  const firstOpen = items.findIndex((i) => !i.done);
  // The car waits before the finish line until the feature is marked done, then crosses it.
  const heroTarget = finished
    ? finishX + 60
    : items.length === 0
      ? 130
      : firstOpen >= 0
        ? xs[firstOpen] - 105
        : finishX - 110;
  const prevX = state.heroX[fkey] ?? 40;
  const prevPct = state.lastPct[fkey];

  const bugName = board.bugTypeName || 'Bug';
  const plural = (n) => (/s$/i.test(n) ? n : `${n}s`);
  const moveTargets = board.features.filter((f) => !f.pseudo);
  const questRow = (it) => `
    <li class="${it.done ? 'done' : ''} ${feature.pseudo ? 'with-move' : ''}">
      <button type="button" class="check" data-toggle="${esc(it.key)}" aria-pressed="${it.done}" title="${it.done ? 'Reopen' : 'Mark done'}">${it.done ? '✓' : ''}</button>
      <span class="q-icon" title="${esc(it.typeName)}">${it.type === 'bug' ? SPRITES.coneIcon : it.type === 'story' ? SPRITES.storyIcon : SPRITES.taskIcon}</span>
      <span class="q-key">${esc(it.key)}</span>
      <button type="button" class="q-sum linklike" data-open="${esc(it.key)}" title="Show details">${esc(it.summary)}<small class="q-type">${esc(it.typeName)}</small></button>
      ${
        feature.pseudo && moveTargets.length
          ? `<select class="row-move" data-move="${esc(it.key)}" aria-label="Move ${esc(it.key)} to a feature">
               <option value="">Move to feature…</option>
               ${moveTargets.map((f) => `<option value="${esc(f.key)}">${esc(f.key)} · ${esc(f.summary)}</option>`).join('')}
             </select>`
          : ''
      }
      <span class="q-status">${esc(it.statusName)}</span>
      ${it.url ? `<a class="q-link" href="${esc(it.url)}" target="_blank" rel="noopener" title="Open in Jira">↗</a>` : ''}
    </li>`;
  const tasks = feature.items.filter((i) => i.type !== 'bug');
  const bugs = feature.items.filter((i) => i.type === 'bug');
  const byOpenFirst = (a, b) => a.done - b.done || a.created.localeCompare(b.created);

  app.innerHTML = `
    <section class="screen level">
      <div class="screen-head">
        <div class="level-title">
          <span class="pixel tag">${feature.pseudo ? 'FREE PRACTICE · NO FEATURE' : feature.done ? 'FINISHED STAGE' : `STAGE ${levelNo}`}</span>
          <h1>${esc(feature.summary)}</h1>
          <span class="key">${feature.pseudo ? 'Issues in this project with no feature' : esc(feature.key)}
            ${feature.pseudo ? '' : ` · ${esc(feature.statusName)}`}
            ${feature.linked ? ` · <span class="link-tag">🔗 linked from ${esc(feature.projectKey)}</span>` : ''}
            ${feature.pseudo ? '' : ` · <button type="button" class="linklike ext" id="feature-details">Feature details</button>`}
            ${feature.url ? ` · <a class="ext" href="${esc(feature.url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : ''}</span>
        </div>
        <div class="actions">
          ${feature.pseudo ? '' : `<button class="btn" id="link-issues" type="button">🔗 Link existing</button>`}
          <button class="btn" data-new="task" type="button">${SPRITES.taskIcon} + Task</button>
          <button class="btn" data-new="story" type="button">${SPRITES.storyIcon} + Story</button>
          <button class="btn danger" data-new="bug" type="button">${SPRITES.coneIcon} + ${esc(bugName)}</button>
          ${
            feature.pseudo
              ? ''
              : `<button class="btn ${allItemsDone && !feature.done ? 'primary glow' : ''}" id="feature-toggle" type="button">${
                  feature.done ? 'Reopen feature' : '🏁 Mark feature done'
                }</button>`
          }
        </div>
      </div>

      <div class="hud pixel">
        <div><label>CHECKPOINTS</label><b>${SPRITES.checkeredSmall} ×${s.tasksDone}<small>/${s.tasksTotal}</small></b></div>
        <div><label>HAZARDS CLEARED</label><b>${SPRITES.coneIcon} ×${s.bugsDone}<small>/${s.bugsTotal}</small></b></div>
        <div><label>SCORE</label><b>${String(s.tasksDone * 50 + s.bugsDone * 100).padStart(6, '0')}</b></div>
        <div><label>PROGRESS</label><b>${s.pct}%</b></div>
      </div>
      <div class="track" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Feature progress">
        <div class="fill" style="width:${s.pct}%"></div>
      </div>

      <div class="viewport" id="viewport">
        <div class="world" id="world" style="width:${width}px">
          <div class="sky-layer">${scenery(width, feature.key)}</div>
          <div class="road"><div class="curb"></div><div class="lane"></div></div>
          <div class="gantry start" style="left:70px">
            <span class="pixel gantry-label">START</span>
            <span class="lights ${s.done > 0 || feature.done ? 'go' : ''}"><i></i><i></i><i></i></span>
          </div>
          ${items.map((it, i) => entityHtml(it, i, xs[i])).join('')}
          <div class="gantry finish ${finished ? 'won' : ''}" style="left:${finishX}px"><span class="pixel gantry-label">FINISH</span></div>
          <div class="podium ${finished ? 'won' : ''}" style="left:${finishX + 150}px">
            <span class="trophy">${SPRITES.trophy}</span><span class="step pixel">1</span>
          </div>
          <div class="hero car" id="hero" style="transform:translateX(${prevX - CAR_HALF}px)"><span class="hero-inner"><span class="f a">${SPRITES.carA}</span><span class="f b">${SPRITES.carB}</span></span><span class="exhaust"><i></i><i></i><i></i></span></div>
          ${
            items.length === 0
              ? `<div class="banner pixel">EMPTY STAGE<small>Add a task or a bug to build the track</small></div>`
              : finished
                ? `<div class="banner win pixel">FINISHED 🏁<small>This feature is marked done in Jira</small></div>`
                : allItemsDone && !feature.pseudo
                  ? `<div class="banner pixel">LAST LAP<small>Every item is done. Mark the feature done to cross the finish line.</small></div>`
                : ''
          }
        </div>
      </div>
      <p class="hint muted">Click a fuel can, a cone or a row below to see all its details. Fuel cans are tasks (red) and stories (blue), traffic cones are bugs. Clear the track to reach the finish.</p>

      <div class="questlog">
        <div class="pixel-box">
          <h2 class="pixel">TASKS &amp; STORIES <small>${s.tasksDone}/${s.tasksTotal}</small></h2>
          <ul>${tasks.sort(byOpenFirst).map(questRow).join('') || '<li class="muted empty-row">No tasks yet</li>'}</ul>
        </div>
        <div class="pixel-box">
          <h2 class="pixel">${/^bugs?$/i.test(bugName) ? 'BUGS' : `${esc(plural(bugName).toUpperCase())} &amp; BUGS`} <small>${s.bugsDone}/${s.bugsTotal}</small></h2>
          <ul>${bugs.sort(byOpenFirst).map(questRow).join('') || `<li class="muted empty-row">No ${esc(plural(bugName).toLowerCase())}. Clear road ahead.</li>`}</ul>
        </div>
      </div>
    </section>`;

  // Wire up
  const viewport = $('#viewport');
  const findItem = (key) => feature.items.find((i) => i.key === key);
  const ctx = { pkey, tid, fkey, board, feature };
  $$('.ent', viewport).forEach((el) => el.addEventListener('click', () => openDrawer(findItem(el.dataset.key), ctx)));
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openDrawer(findItem(b.dataset.open), ctx)));
  $('#feature-details')?.addEventListener('click', () => openDrawer(feature, ctx));
  $('#link-issues')?.addEventListener('click', () => linkIssueSearch(ctx));
  $$('[data-move]').forEach((sel) =>
    sel.addEventListener('change', () => {
      if (sel.value) moveIssue(findItem(sel.dataset.move), sel.value, ctx);
    }),
  );
  $$('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => toggleIssue(findItem(b.dataset.toggle), ctx)),
  );
  $$('[data-new]').forEach((b) => b.addEventListener('click', () => createItemForm(b.dataset.new, ctx)));
  $('#feature-toggle')?.addEventListener('click', () => toggleFeature(feature, ctx));

  state.justCreated = null;
  state.heroX[fkey] = heroTarget;
  state.lastPct[fkey] = s.pct;
  walkHero(viewport, prevX, heroTarget);

  if (prevPct !== undefined && prevPct < 100 && allItemsDone && !finished && !feature.pseudo) {
    toast('Every item is done. Mark the feature done to finish the stage.', 'success');
  }
}

function walkHero(viewport, from, to) {
  const hero = $('#hero');
  const vw = viewport.clientWidth;
  const cam = (x) => Math.max(0, x - vw * 0.35);
  viewport.scrollLeft = cam(from);
  if (Math.abs(to - from) < 2) {
    hero.style.transform = `translateX(${to - CAR_HALF}px)`;
    return;
  }
  const dur = Math.min(3500, Math.max(400, Math.abs(to - from) / 0.35));
  const s0 = viewport.scrollLeft;
  const s1 = Math.min(cam(to), viewport.scrollWidth - vw);
  hero.classList.add('walking');
  hero.classList.toggle('left', to < from);
  if (Math.abs(to - from) > 60) Sound.play('engine');
  const t0 = performance.now();
  const step = (now) => {
    if (!hero.isConnected) return;
    const t = Math.min(1, (now - t0) / dur);
    hero.style.transform = `translateX(${from + (to - from) * t - CAR_HALF}px)`;
    viewport.scrollLeft = s0 + (s1 - s0) * t;
    if (t < 1) requestAnimationFrame(step);
    else hero.classList.remove('walking', 'left');
  };
  requestAnimationFrame(step);
}

/* ---------- Issue details ---------- */
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const extOf = (name) => (String(name).match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'FILE').toUpperCase();

// Everything the drawer shows, so it can repaint without losing half-written text.
let dz = null;

const EDIT_HELP =
  'Jira formatting: <code>*bold*</code> <code>_italic_</code> <code>h3. Heading</code> <code>* bullet</code> <code># numbered</code> <code>[text|https://…]</code> <code>{{code}}</code>. Drop files in to attach them.';

function toolbar(target) {
  const b = (cmd, label, title) => `<button type="button" class="tb" data-tb="${cmd}" data-target="${target}" title="${title}">${label}</button>`;
  return `<div class="toolbar" role="toolbar" aria-label="Formatting">
    ${b('bold', '<b>B</b>', 'Bold')}${b('italic', '<i>I</i>', 'Italic')}${b('h3', 'H', 'Heading')}
    ${b('bullet', '•', 'Bullet list')}${b('number', '1.', 'Numbered list')}${b('code', '{ }', 'Code')}
    ${b('link', '🔗', 'Link')}${b('quote', '❝', 'Quote')}
  </div>`;
}

function applyTool(ta, cmd) {
  const { selectionStart: s0, selectionEnd: s1, value } = ta;
  const sel = value.slice(s0, s1);
  const wrap = (l, r, ph) => {
    const text = sel || ph;
    ta.setRangeText(`${l}${text}${r}`, s0, s1, 'end');
    if (!sel) ta.setSelectionRange(s0 + l.length, s0 + l.length + ph.length);
  };
  const prefix = (pre) => {
    const start = value.lastIndexOf('\n', s0 - 1) + 1;
    const block = value.slice(start, s1) || 'text';
    ta.setRangeText(block.split('\n').map((l) => `${pre}${l}`).join('\n'), start, Math.max(s1, start), 'end');
  };
  ({
    bold: () => wrap('*', '*', 'bold text'),
    italic: () => wrap('_', '_', 'italic text'),
    code: () => wrap('{{', '}}', 'code'),
    link: () => wrap('[', '|https://]', 'link text'),
    h3: () => prefix('h3. '),
    bullet: () => prefix('* '),
    number: () => prefix('# '),
    quote: () => prefix('bq. '),
  })[cmd]?.();
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function attachmentsHtml(d) {
  const list = d?.attachments || [];
  const tiles = list
    .map((a) =>
      a.isImage
        ? `<button type="button" class="att img" data-view="${esc(a.id)}" title="${esc(a.filename)}">
             <img src="/api/attachments/${esc(a.id)}/thumbnail" loading="lazy" alt="${esc(a.filename)}" />
             <span class="att-name">${esc(a.filename)}</span></button>`
        : `<a class="att file" href="/api/attachments/${esc(a.id)}/content?download=1" title="Download ${esc(a.filename)}">
             <span class="att-ext">${esc(extOf(a.filename))}</span>
             <span class="att-name">${esc(a.filename)}</span><small class="muted">${fmtSize(a.size)}</small></a>`,
    )
    .join('');
  return `
    ${list.length ? `<div class="att-grid">${tiles}</div>` : d ? '<p class="muted">No attachments yet.</p>' : '<p class="muted">Loading from Jira…</p>'}
    <label class="dropzone" tabindex="0">
      <input type="file" multiple hidden id="file-input" />
      <span>⬆ Drop files here or <u>choose files</u></span>
      <small class="muted">They're uploaded to the issue in Jira.</small>
    </label>
    <ul class="uploads" id="uploads"></ul>`;
}

function detailHtml() {
  const { it, d, ctx } = dz;
  const isFeature = it.type === 'epic';
  const action = it.done ? 'Reopen' : isFeature ? '🏁 Mark stage finished' : it.type === 'bug' ? 'Clear hazard' : 'Mark done';
  const loading = '<p class="muted">Loading from Jira…</p>';
  const meta = (label, value) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : '');
  const chips = (list) => list.map((l) => `<span class="label-chip">${esc(l)}</span>`).join(' ');
  const features = ctx.board.features.filter((f) => !f.pseudo);
  const currentParent = d ? d.parent?.key || null : it.parentKey;
  const parentKnown = !currentParent || features.some((f) => f.key === currentParent);
  const site = state.status?.site;

  const description = dz.editingDesc
    ? `<div class="editor">
         ${toolbar('desc')}
         <textarea id="desc-editor" class="md-input" rows="12" data-drop="desc" placeholder="Describe the issue…">${esc(dz.descDraft ?? '')}</textarea>
         <p class="muted small-text">${EDIT_HELP}</p>
         <div class="editor-actions">
           <button type="button" class="btn" data-act="desc-cancel">Cancel</button>
           <button type="button" class="btn primary" data-act="desc-save">Save description</button>
         </div>
       </div>`
    : d
      ? d.descriptionHtml
        ? `<div class="rich">${sanitize(d.descriptionHtml, site)}</div>`
        : '<p class="muted">No description.</p>'
      : loading;

  return `
    <div class="drawer-head">
      <span class="chip ${esc(it.type)}">${esc(it.typeName)}</span>
      <span class="key">${esc(it.key)}</span>
      <button type="button" class="icon-btn" data-close aria-label="Close details">✕</button>
    </div>
    <div class="drawer-scroll">
      <h2 class="drawer-title">${esc(d?.summary || it.summary)}</h2>
      <div class="drawer-actions">
        <button type="button" class="btn ${it.done ? '' : 'primary'}" data-act="toggle">${action}</button>
        ${it.url ? `<a class="btn" href="${esc(it.url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : ''}
      </div>

      <dl class="meta">
        ${meta('Status', `<span class="status-pill ${it.done ? 'done' : ''}">${esc(d?.statusName || it.statusName)}</span>`)}
        ${meta('Priority', esc(d?.priority || ''))}
        ${meta('Assignee', esc((d ? d.assignee : it.assignee) || 'Unassigned'))}
        ${meta('Reporter', esc(d?.reporter || ''))}
        ${meta('Created', esc(fmtDate(d?.created || it.created)))}
        ${meta('Updated', esc(fmtDate(d?.updated)))}
        ${meta('Due', esc(fmtDate(d?.duedate)))}
        ${d?.labels?.length ? meta('Labels', chips(d.labels)) : ''}
        ${d?.components?.length ? meta('Components', chips(d.components)) : ''}
        ${d?.workGroup ? meta(esc(d.workGroup.name), esc(d.workGroup.value || 'Not set')) : ''}
      </dl>

      ${
        isFeature
          ? ''
          : `<section class="drawer-section">
        <h3 class="pixel">STAGE (FEATURE)</h3>
        <div class="move-row">
          <select id="move-select" aria-label="Feature">
            <option value="">No feature</option>
            ${features.map((f) => `<option value="${esc(f.key)}" ${f.key === currentParent ? 'selected' : ''}>${esc(f.key)} · ${esc(f.summary)}</option>`).join('')}
            ${!parentKnown ? `<option value="${esc(currentParent)}" selected>${esc(currentParent)} · ${esc(d?.parent?.summary || 'other feature')}</option>` : ''}
          </select>
          <button type="button" class="btn" data-act="move" disabled>Move</button>
        </div>
        <small class="muted">Moving sets the issue's parent in Jira.</small>
      </section>`
      }

      <section class="drawer-section">
        <h3 class="pixel">DESCRIPTION ${d && !dz.editingDesc ? '<button type="button" class="linklike edit-link" data-act="desc-edit">✎ Edit</button>' : ''}</h3>
        ${description}
      </section>

      <section class="drawer-section" id="att-section">
        <h3 class="pixel">ATTACHMENTS ${d ? `<small>${d.attachments?.length || 0}</small>` : ''}</h3>
        ${attachmentsHtml(d)}
      </section>

      ${
        d?.subtasks?.length
          ? `<section class="drawer-section">
        <h3 class="pixel">SUB-TASKS <small>${d.subtasks.filter((x) => x.done).length}/${d.subtasks.length}</small></h3>
        <ul class="subtasks">${d.subtasks
          .map((x) => `<li class="${x.done ? 'done' : ''}"><span class="q-key">${esc(x.key)}</span> <span class="q-sum">${esc(x.summary)}</span> <span class="q-status">${esc(x.statusName)}</span></li>`)
          .join('')}</ul>
      </section>`
          : ''
      }

      <section class="drawer-section">
        <h3 class="pixel">COMMENTS ${d ? `<small>${d.commentsTotal}</small>` : ''}</h3>
        ${
          d
            ? d.comments.length
              ? `${d.commentsTotal > d.comments.length ? `<p class="muted small-text">Showing the latest ${d.comments.length}.</p>` : ''}
                 <ul class="comments">${d.comments
                   .map(
                     (c) => `<li><div class="c-head"><b>${esc(c.author)}</b><span class="muted">${esc(fmtDate(c.created, true))}</span></div>
                   <div class="rich">${sanitize(c.bodyHtml, site)}</div></li>`,
                   )
                   .join('')}</ul>`
              : '<p class="muted">No comments yet.</p>'
            : loading
        }
        ${
          d
            ? `<div class="editor comment-editor">
          ${toolbar('comment')}
          <textarea id="comment-editor" class="md-input" rows="4" data-drop="comment" placeholder="Add a comment…">${esc(dz.commentDraft || '')}</textarea>
          <div class="editor-actions">
            <small class="muted">Formatting like <code>*bold*</code>, <code>_italic_</code>, <code>* list</code>. Drop files to attach.</small>
            <button type="button" class="btn primary" data-act="comment" ${dz.commentDraft?.trim() ? '' : 'disabled'}>Comment</button>
          </div>
        </div>`
            : ''
        }
      </section>
      <div class="drop-overlay pixel" aria-hidden="true">DROP TO ATTACH TO ${esc(it.key)}</div>
    </div>`;
}

function paintDrawer() {
  if (!dz) return;
  // Keep what's being typed across repaints.
  const descTa = $('#desc-editor', drawer);
  if (descTa) dz.descDraft = descTa.value;
  const comTa = $('#comment-editor', drawer);
  if (comTa) dz.commentDraft = comTa.value;
  const scroll = $('.drawer-scroll', drawer)?.scrollTop || 0;

  drawer.innerHTML = detailHtml();
  $('.drawer-scroll', drawer).scrollTop = scroll;
  const { it, ctx } = dz;

  $('[data-act="toggle"]', drawer).addEventListener('click', () =>
    it.type === 'epic' ? toggleFeature(it, ctx) : toggleIssue(it, ctx),
  );
  const sel = $('#move-select', drawer);
  const moveBtn = $('[data-act="move"]', drawer);
  if (sel) {
    const original = sel.value;
    sel.addEventListener('change', () => {
      moveBtn.disabled = sel.value === original;
      moveBtn.classList.toggle('primary', sel.value !== original);
    });
    moveBtn.addEventListener('click', () => moveIssue(it, sel.value || null, ctx));
  }

  // Description editing
  $('[data-act="desc-edit"]', drawer)?.addEventListener('click', async (e) => {
    e.target.textContent = 'Loading…';
    try {
      const { text } = await api(`/issues/${encodeURIComponent(it.key)}/description`);
      dz.editingDesc = true;
      dz.descDraft = text;
      paintDrawer();
      $('#desc-editor', drawer)?.focus();
    } catch (err) {
      toast(err.message, 'error');
      e.target.textContent = '✎ Edit';
    }
  });
  $('[data-act="desc-cancel"]', drawer)?.addEventListener('click', () => {
    dz.editingDesc = false;
    dz.descDraft = null;
    drawer.querySelector('#desc-editor').value = '';
    paintDrawer();
  });
  $('[data-act="desc-save"]', drawer)?.addEventListener('click', async (e) => {
    const text = $('#desc-editor', drawer).value;
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      await api(`/issues/${encodeURIComponent(it.key)}/description`, { method: 'PUT', body: { text } });
      dz.editingDesc = false;
      dz.descDraft = null;
      $('#desc-editor', drawer).value = '';
      toast('Description saved', 'success');
      await refreshDrawer();
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
      e.target.textContent = 'Save description';
    }
  });

  // Comments
  const comTa2 = $('#comment-editor', drawer);
  const comBtn = $('[data-act="comment"]', drawer);
  comTa2?.addEventListener('input', () => (comBtn.disabled = !comTa2.value.trim()));
  comTa2?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comTa2.value.trim()) comBtn.click();
  });
  comBtn?.addEventListener('click', async () => {
    comBtn.disabled = true;
    comBtn.textContent = 'Posting…';
    try {
      await api(`/issues/${encodeURIComponent(it.key)}/comments`, { method: 'POST', body: { text: comTa2.value } });
      comTa2.value = '';
      dz.commentDraft = '';
      Sound.play('coin');
      await refreshDrawer();
    } catch (err) {
      toast(err.message, 'error');
      comBtn.disabled = false;
      comBtn.textContent = 'Comment';
    }
  });

  // Formatting toolbars
  $$('[data-tb]', drawer).forEach((b) =>
    b.addEventListener('click', () => {
      const ta = $(b.dataset.target === 'desc' ? '#desc-editor' : '#comment-editor', drawer);
      if (ta) applyTool(ta, b.dataset.tb);
    }),
  );

  // Attachments
  $$('[data-view]', drawer).forEach((b) => b.addEventListener('click', () => openLightbox(b.dataset.view)));
  const input = $('#file-input', drawer);
  input.addEventListener('change', () => uploadFiles([...input.files]));
  $('.dropzone', drawer).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  $$('textarea[data-drop]', drawer).forEach((ta) => {
    ta.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    });
    ta.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      drawer.classList.remove('dragging');
      uploadFiles([...e.dataTransfer.files], ta);
    });
  });
}

// Drag files anywhere onto the drawer to attach them.
let dragDepth = 0;
drawer.addEventListener('dragenter', (e) => {
  if (!dz || !e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  drawer.classList.add('dragging');
});
drawer.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drawer.classList.remove('dragging');
  }
});
drawer.addEventListener('dragover', (e) => {
  if (dz && e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});
drawer.addEventListener('drop', (e) => {
  dragDepth = 0;
  drawer.classList.remove('dragging');
  if (!dz || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  uploadFiles([...e.dataTransfer.files]);
});
// Don't let a missed drop navigate the page away to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function uploadOne(key, file, row) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/issues/${encodeURIComponent(key)}/attachments`);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) row.querySelector('.bar i').style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (data.needsLogin) location.hash = '#/signin';
        reject(new Error(data.error || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(file);
  });
}

async function uploadFiles(files, insertInto = null) {
  if (!dz || !files.length) return;
  const key = dz.it.key;
  const list = $('#uploads', drawer);
  const inserted = [];
  for (const file of files) {
    const row = document.createElement('li');
    row.innerHTML = `<span class="up-name">${esc(file.name)}</span><span class="bar"><i></i></span>`;
    list?.append(row);
    try {
      await uploadOne(key, file, row);
      row.classList.add('ok');
      const image = /^image\//.test(file.type);
      inserted.push(image ? `!${file.name}|thumbnail!` : `[^${file.name}]`);
    } catch (e) {
      row.classList.add('err');
      row.querySelector('.bar').textContent = e.message;
      toast(`${file.name}: ${e.message}`, 'error');
    }
  }
  if (!inserted.length) return;
  Sound.play('coin');
  toast(`${inserted.length} file${inserted.length > 1 ? 's' : ''} attached to ${key}`, 'success');
  if (insertInto && dz?.it.key === key) {
    const ta = insertInto;
    const glue = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
    ta.setRangeText(`${glue}${inserted.join('\n')}\n`, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
  if (dz?.it.key === key) await refreshDrawer();
}

async function refreshDrawer() {
  if (!dz) return;
  const key = dz.it.key;
  try {
    const d = await api(`/issues/${encodeURIComponent(key)}?world=${enc(dz.ctx.pkey)}&team=${enc(dz.ctx.tid)}`);
    if (dz?.it.key === key) {
      dz.d = d;
      paintDrawer();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openDrawer(it, ctx) {
  if (!it) return;
  drawerKey = it.key;
  dz = { it, ctx, d: null, editingDesc: false, descDraft: null, commentDraft: '' };
  $$('.ent.selected, .questlog li.selected').forEach((e) => e.classList.remove('selected'));
  document.querySelector(`.ent[data-key="${CSS.escape(it.key)}"]`)?.classList.add('selected');
  document.querySelector(`[data-open="${CSS.escape(it.key)}"]`)?.closest('li')?.classList.add('selected');
  drawer.innerHTML = '';
  paintDrawer();
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('[data-close]', drawer).focus();
  try {
    const d = await api(`/issues/${encodeURIComponent(it.key)}?world=${enc(ctx.pkey)}&team=${enc(ctx.tid)}`);
    if (drawerKey === it.key && dz) {
      dz.d = d;
      paintDrawer();
    }
  } catch (e) {
    if (drawerKey !== it.key) return;
    $$('.drawer-section p.muted', drawer).forEach((p) => {
      if (p.textContent.startsWith('Loading')) {
        p.textContent = `Couldn't load details: ${e.message}`;
        p.classList.add('form-error');
      }
    });
  }
}

/* ---------- Lightbox for image attachments ---------- */
const lightbox = $('#lightbox');
function openLightbox(id) {
  const images = (dz?.d?.attachments || []).filter((a) => a.isImage);
  let i = Math.max(0, images.findIndex((a) => a.id === id));
  const show = () => {
    const a = images[i];
    lightbox.innerHTML = `
      <div class="lb-bar">
        <span class="lb-name">${esc(a.filename)} <small class="muted">${fmtSize(a.size)}${a.author ? ` · ${esc(a.author)}` : ''}</small></span>
        <a class="btn small" href="/api/attachments/${esc(a.id)}/content?download=1">Download</a>
        <button type="button" class="icon-btn" data-lb="close" aria-label="Close">✕</button>
      </div>
      ${images.length > 1 ? '<button type="button" class="lb-nav prev" data-lb="prev" aria-label="Previous">‹</button><button type="button" class="lb-nav next" data-lb="next" aria-label="Next">›</button>' : ''}
      <img src="/api/attachments/${esc(a.id)}/content" alt="${esc(a.filename)}" />`;
  };
  if (!images.length) return;
  show();
  lightbox.hidden = false;
  lightbox.onclick = (e) => {
    const act = e.target.closest('[data-lb]')?.dataset.lb;
    if (act === 'prev') i = (i - 1 + images.length) % images.length;
    else if (act === 'next') i = (i + 1) % images.length;
    else if (act === 'close' || e.target === lightbox) return closeLightbox();
    else return;
    show();
  };
}
function closeLightbox() {
  lightbox.hidden = true;
  lightbox.innerHTML = '';
}
document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') $('[data-lb="prev"]', lightbox)?.click();
  if (e.key === 'ArrowRight') $('[data-lb="next"]', lightbox)?.click();
});

async function moveIssue(it, parentKey, ctx) {
  try {
    const res = await api(`/issues/${encodeURIComponent(it.key)}/parent`, {
      method: 'PUT',
      body: { parentKey, worldKey: ctx.pkey, teamId: ctx.tid },
    });
    reportDefaults(res);
    await loadBoard(ctx.pkey, ctx.tid, true);
    closeDrawer();
    toast(parentKey ? `${it.key} moved to ${parentKey}` : `${it.key} removed from its feature`, 'success');
    Sound.play('spawn');
    if (ctx.onChange) await ctx.onChange();
    else await renderLevel(ctx.pkey, ctx.tid, ctx.fkey);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Find existing tasks/stories/bugs in Jira and make them part of this feature.
function linkIssueSearch(ctx) {
  const { pkey, tid, fkey, feature } = ctx;
  const here = new Set(feature.items.map((i) => i.key));
  let added = null;
  openSearch({
    title: 'LINK EXISTING ISSUES',
    intro: `Pick tasks, stories or bugs to move into <b>${esc(feature.key)}</b>, ${esc(feature.summary)}. This sets their parent in Jira; issues already under another feature move here.`,
    kind: 'issue',
    pkey: feature.projectKey || pkey,
    isAdded: (it) => here.has(it.key),
    onPick: async (it) => {
      const res = await api(`/issues/${encodeURIComponent(it.key)}/parent`, {
        method: 'PUT',
        body: { parentKey: feature.key, worldKey: pkey, teamId: tid },
      });
      reportDefaults(res);
      here.add(it.key);
      added = it.key;
    },
    onClose: async () => {
      if (!added) return;
      await loadBoard(pkey, tid, true);
      state.justCreated = added;
      toast('Issues linked to this feature', 'success');
      renderLevel(pkey, tid, fkey);
    },
  });
}

async function playDoneAnim(it) {
  const el = document.querySelector(`.ent[data-key="${CSS.escape(it.key)}"]`);
  if (!el) return;
  const world = $('#world');
  const x = parseFloat(el.style.left);
  const y = parseFloat(el.style.bottom) + el.offsetHeight;
  if (it.type === 'bug') {
    el.classList.add('squash');
    Sound.play('squash');
    floatText(world, x, y, '+100');
  } else {
    el.classList.add('bump');
    Sound.play('coin');
    const c = document.createElement('div');
    c.className = 'coin-pop';
    c.style.left = `${x}px`;
    c.style.bottom = `${y}px`;
    c.innerHTML = SPRITES.checkered;
    world.append(c);
    floatText(world, x, y + 40, '+50');
  }
  await delay(550);
}

function floatText(world, x, y, text) {
  const t = document.createElement('div');
  t.className = 'float-text pixel';
  t.style.left = `${x}px`;
  t.style.bottom = `${y}px`;
  t.textContent = text;
  world.append(t);
}

async function toggleIssue(it, ctx) {
  const { pkey, tid, fkey } = ctx;
  if (!it || state.busy) return;
  state.busy = true;
  closeDrawer();
  const willBeDone = !it.done;
  try {
    await Promise.all([
      api(`/issues/${encodeURIComponent(it.key)}/status`, { method: 'POST', body: { done: willBeDone } }),
      willBeDone ? playDoneAnim(it) : Promise.resolve(Sound.play('undo')),
    ]);
    await loadBoard(pkey, tid, true);
    if (!willBeDone) toast(`${it.key} reopened`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy = false;
  }
  if (ctx.onChange) await ctx.onChange();
  else if (location.hash.includes(`/f/${enc(fkey)}`)) await renderLevel(pkey, tid, fkey);
}

async function toggleFeature(feature, ctx) {
  const { pkey, tid } = ctx;
  if (state.busy) return;
  state.busy = true;
  const done = !feature.done;
  try {
    await api(`/issues/${encodeURIComponent(feature.key)}/status`, { method: 'POST', body: { done } });
    await loadBoard(pkey, tid, true);
    if (done) {
      Sound.play('clear');
      confetti($('#viewport'));
      toast(`${feature.key} finished! 🏁`, 'success');
    } else {
      toast(`${feature.key} reopened`);
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy = false;
  }
  await renderLevel(pkey, tid, feature.key);
}

function createItemForm(kind, ctx) {
  const { pkey, tid, feature } = ctx;
  const bugName = ctx.board.bugTypeName || 'Bug';
  const names = { task: 'task', story: 'story', bug: bugName.toLowerCase() };
  openForm({
    title: kind === 'bug' ? `NEW ${bugName.toUpperCase()}` : kind === 'story' ? 'NEW STORY' : 'NEW TASK',
    intro: feature.pseudo
      ? 'This issue will not belong to any feature.'
      : `Adds it to <b>${esc(feature.key)}</b>, ${esc(feature.summary)}.${defaultsSummary(ctx.board.team)}`,
    fields: [
      {
        name: 'kind',
        label: 'Type',
        type: 'select',
        value: kind,
        options: [
          { value: 'task', label: 'Task (red fuel can)' },
          { value: 'story', label: 'Story (blue fuel can)' },
          { value: 'bug', label: `${bugName} (traffic cone)` },
        ],
      },
      { name: 'summary', label: 'Summary', required: true, placeholder: `What is the ${names[kind]}?`, maxlength: 250 },
    ],
    submit: 'Create',
    async onSubmit({ kind: k, summary }) {
      const res = await api('/issues', {
        method: 'POST',
        body: {
          projectKey: feature.projectKey || pkey,
          worldKey: pkey,
          teamId: tid,
          kind: k,
          summary,
          parentKey: feature.pseudo ? null : feature.key,
        },
      });
      reportDefaults(res);
      const { key } = res;
      const fresh = await loadBoard(pkey, tid, true);
      state.justCreated = key;
      Sound.play('spawn');
      const shown = feature.pseudo ? fresh.unsorted : findFeature(fresh, feature.key)?.items || [];
      if (!shown.some((i) => i.key === key)) {
        toast(`${key} was created, but it doesn't match this world's filter, so it isn't shown here.`, 'warn');
      }
      toast(k === 'bug' ? `Cone on the track: ${key}` : `New fuel can: ${key}`, k === 'bug' ? 'warn' : 'success');
      if (ctx.onChange) ctx.onChange();
      else renderLevel(pkey, tid, feature.key);
    },
  });
}

function confetti(container) {
  if (!container) return;
  const colors = ['#ffcd75', '#a7f070', '#41a6f6', '#ef7d57', '#b13e53', '#f4f4f4'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.6}s`;
    p.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3500);
}

/* =========================================================
   Sign in with Atlassian
   ========================================================= */
async function renderSignIn() {
  setCrumbs([{ label: 'Sign in' }]);
  await loadStatus(); // maybe we're signed in after all
  if (state.status?.auth === 'oauth' && state.status.signedIn) {
    location.hash = '#/';
    return;
  }
  const error = new URLSearchParams(location.hash.split('?')[1] || '').get('error');
  const site = state.status?.site ? new URL(state.status.site).host : 'Jira';
  if (state.status?.auth !== 'oauth') {
    location.hash = '#/';
    return;
  }
  if (state.status.signedIn) {
    location.hash = '#/';
    return;
  }
  app.innerHTML = `
    <section class="screen narrow">
      <div class="pixel-box signin">
        <div class="signin-car">${SPRITES.carA}</div>
        <h1 class="pixel">READY TO RACE?</h1>
        <p>Sign in with <b>your own</b> Atlassian account to open <b>${esc(site)}</b>.
        Bug Rally is just another view of Jira: you see what you can see in Jira, and everything you change is saved in Jira as you.</p>
        ${error ? `<p class="form-error">${esc(error)}</p>` : ''}
        <a class="btn primary big" href="/auth/login">Sign in with Atlassian</a>
        <p class="muted small-text">If your company uses single sign-on, you'll go through it as usual.<br><a href="#/settings">Connection settings</a></p>
      </div>
    </section>`;
}

$('#signout-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  resetCaches();
  closeDrawer();
  await loadStatus();
  toast('Signed out');
  location.hash = '#/signin';
  route();
});

/* =========================================================
   Screen 4: Jira connection settings
   ========================================================= */
const peopleText = (n) =>
  n ? `<span class="muted">${n} ${n === 1 ? 'person is' : 'people are'} signed in on this Bug Rally.</span>` : '';

async function renderSettings() {
  setCrumbs([{ label: 'Circuits', href: '#/' }, { label: 'Settings' }]);
  let cfg;
  try {
    cfg = await api('/settings');
  } catch (e) {
    throw new Error(`Couldn't load settings: ${e.message}`);
  }
  const j = cfg.jira || {};
  const method = j.method || 'oauth';
  const connected = cfg.mode === 'jira';
  const sourceText = { settings: 'saved on this page', env: 'from the .env file', none: '' }[cfg.source];
  const st = state.status || {};
  const statusLine =
    st.mode === 'error'
      ? `<span class="dot err"></span> Can't reach Jira: ${esc(st.error)}`
      : cfg.method === 'oauth'
        ? st.signedIn
          ? `<span class="dot ok"></span> Each person signs in with their own Atlassian account on <b>${esc(j.baseUrl)}</b>.
             You are signed in as <b>${esc(st.user)}</b>. ${peopleText(cfg.signedInCount)}`
          : `<span class="dot off"></span> Each person signs in with their own Atlassian account on <b>${esc(j.baseUrl)}</b>.
             You aren't signed in. <a href="/auth/login">Sign in with Atlassian</a> ${peopleText(cfg.signedInCount)}`
        : connected
          ? `<span class="dot ok"></span> Connected to <b>${esc(j.baseUrl)}</b> with an API token${st.user ? ` as <b>${esc(st.user)}</b>` : ''} <span class="muted">(${sourceText})</span>`
          : `<span class="dot off"></span> Not connected. Bug Rally is using <b>demo data</b>.`;

  app.innerHTML = `
    <section class="screen narrow">
      <div class="screen-head">
        <div>
          <h1 class="pixel">SETTINGS</h1>
          <p class="muted">Connect Bug Rally to your Jira Cloud site.</p>
        </div>
      </div>

      <div class="pixel-box status-box">${statusLine}</div>

      <form id="jira-form" class="pixel-box settings-form" autocomplete="off">
        <h2 class="pixel box-title">JIRA CONNECTION</h2>
        <label class="field"><span>Jira address</span>
          <input name="baseUrl" required placeholder="https://your-company.atlassian.net" value="${esc(j.baseUrl || '')}" />
        </label>

        <div class="field"><span>How should people log in?</span>
          <div class="radios">
            <label class="radio"><input type="radio" name="method" value="oauth" ${method === 'oauth' ? 'checked' : ''} />
              <span><b>Each person signs in with their own Atlassian account</b> (recommended). They use the normal Jira login, including company single sign-on, and see and change only what they are allowed to in Jira. Everything they do is recorded in Jira as them.</span></label>
            <label class="radio"><input type="radio" name="method" value="token" ${method === 'token' ? 'checked' : ''} />
              <span><b>One shared account</b> (API token). Everyone using this Bug Rally acts as the same Jira user. Handy for trying it out alone.</span></label>
          </div>
        </div>

        <div class="mode-panel" data-panel="oauth">
          <div class="howto">
            <p><b>One-time setup by whoever runs Bug Rally.</b> This registers Bug Rally itself with Atlassian so it is allowed to show the sign-in page.
            It is <b>not</b> a user account: nobody logs in with it, and it can't see anything in Jira on its own. After this, each person signs in with their own account.</p>
            <p>Even though the app is registered under your developer account, <b>nothing is done in Jira as you</b>. Every read and change uses the access of the person who is signed in, shows up in Jira's history as them, and is limited to their own Jira permissions.
            You're only listed as the app's owner (people see your name on the Atlassian consent screen).</p>
            <ol>
              <li>Open the <a href="https://developer.atlassian.com/console/myapps/" target="_blank" rel="noopener">Atlassian developer console</a> and create an <b>OAuth 2.0 integration</b>.</li>
              <li>Under <b>Permissions</b>, add <b>Jira API</b> with the scopes ${cfg.scopes.filter((x) => x !== 'offline_access').map((x) => `<code>${esc(x)}</code>`).join(' ')}.
                <span class="sw-scopes">For the Kanban's boards and ranking, also add these <b>granular</b> scopes (Jira API and Jira Software):
                ${cfg.softwareScopeList.map((x) => `<code>${esc(x)}</code>`).join(' ')}.</span></li>
              <li>Under <b>Authorization</b>, set the callback URL to
                <span class="copy-row"><code id="cb-url">${esc(cfg.callbackUrl)}</code> <button type="button" class="btn small" id="copy-cb">Copy</button></span></li>
              <li>Under <b>Settings</b>, copy the Client ID and Secret into the fields below.</li>
              <li>To let colleagues sign in too, turn on sharing under <b>Distribution</b>. Your Jira admins may need to approve the app first.</li>
            </ol>
          </div>
          <label class="field"><span>App Client ID</span>
            <input name="clientId" value="${esc(j.clientId || '')}" placeholder="From the developer console" />
          </label>
          <label class="check-label"><input type="checkbox" name="softwareScopes" ${j.softwareScopes ? 'checked' : ''} />
            Ask for Jira Software permissions (Kanban boards and ranking). Only tick this when those scopes are added to the app, or Atlassian refuses the sign-in.</label>
          <label class="field"><span>App Client secret</span>
            <input name="clientSecret" type="password" placeholder="${j.secretHint ? `Saved (${esc(j.secretHint)}). Leave blank to keep it` : 'From the developer console'}" />
          </label>
        </div>

        <div class="mode-panel" data-panel="token">
          <label class="field"><span>Email</span>
            <input name="email" type="email" placeholder="you@company.com" value="${esc(j.email || '')}" />
            <small class="muted">The address you log in to Jira with.</small>
          </label>
          <label class="field"><span>API token</span>
            <input name="token" type="password" placeholder="${j.tokenHint ? `Saved (${esc(j.tokenHint)}). Leave blank to keep it` : 'Paste your API token'}" />
            <small class="muted">Create one at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">id.atlassian.com → Security → API tokens</a>. Some companies turn API tokens off; then use Sign in with Atlassian.</small>
          </label>
        </div>

        <details class="advanced">
          <summary>Advanced</summary>
          <label class="field"><span>Template for new projects</span>
            <input name="projectTemplate" value="${esc(j.projectTemplate || 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic')}" />
            <small class="muted">Used by “+ New project”. The default is a company-managed Kanban project.</small>
          </label>
        </details>
        <p class="form-result" id="form-result" hidden></p>
        <div class="form-actions">
          <button type="button" class="btn" id="test-btn">Test connection</button>
          <button type="submit" class="btn primary" id="save-btn">Save &amp; connect</button>
        </div>
        <p class="muted small-text">Secrets are stored only on this computer, in <code>data/settings.json</code>, and never sent to the browser.</p>
      </form>

      <div class="pixel-box">
        <h2 class="pixel box-title">OTHER OPTIONS</h2>
        <div class="actions">
          ${cfg.method !== 'demo' ? '<button type="button" class="btn" id="use-demo">Disconnect and use demo data</button>' : ''}
          ${cfg.envAvailable && cfg.source !== 'env' ? '<button type="button" class="btn" id="use-env">Use the values in .env</button>' : ''}
          ${cfg.method === 'demo' && !cfg.envAvailable ? '<span class="muted">Nothing else to set up. Fill in the form above to connect.</span>' : ''}
        </div>
      </div>
    </section>`;

  const form = $('#jira-form');
  const result = $('#form-result');
  const body = () => ({ ...Object.fromEntries(new FormData(form)), softwareScopes: form.elements.softwareScopes?.checked === true });
  const show = (msg, ok) => {
    result.hidden = false;
    result.className = `form-result ${ok ? 'ok' : 'err'}`;
    result.innerHTML = msg;
  };
  const sync = () => {
    const m = form.elements.method.value;
    $$('.mode-panel', form).forEach((p) => (p.hidden = p.dataset.panel !== m));
    $('#test-btn').hidden = m === 'oauth';
    $('#save-btn').textContent = m === 'oauth' ? 'Save' : 'Save & connect';
  };
  form.addEventListener('change', (e) => e.target.name === 'method' && sync());
  sync();
  $('#copy-cb').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cfg.callbackUrl);
      toast('Callback URL copied', 'success');
    } catch {
      toast('Copy failed. Select the text instead.', 'warn');
    }
  });

  $('#test-btn').addEventListener('click', async (e) => {
    if (!form.reportValidity()) return;
    e.target.disabled = true;
    e.target.textContent = 'Testing…';
    try {
      const r = await api('/settings/test', { method: 'POST', body: body() });
      show(`✓ Works! Signed in as <b>${esc(r.user)}</b>.`, true);
    } catch (err) {
      show(esc(err.message), false);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Test connection';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#save-btn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await api('/settings', { method: 'POST', body: body() });
      resetCaches();
      await loadStatus();
      if (r.method === 'oauth') {
        toast('Saved. Now sign in with Atlassian.', 'success');
        location.hash = '#/signin';
      } else {
        Sound.play('clear');
        toast(`Connected to Jira as ${r.user}`, 'success');
        location.hash = '#/';
      }
    } catch (err) {
      show(esc(err.message), false);
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  const switchTo = (path, method2, msg) => async () => {
    try {
      await api(path, { method: method2 });
      resetCaches();
      await loadStatus();
      toast(msg, 'success');
      renderSettings();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#use-demo')?.addEventListener('click', switchTo('/settings/demo', 'POST', 'Switched to demo data'));
  $('#use-env')?.addEventListener('click', switchTo('/settings', 'DELETE', 'Using the .env settings'));
}

/* =========================================================
   Boot
   ========================================================= */
$('#logo-bug').innerHTML = SPRITES.carIcon;
renderSoundBtn();
await loadStatus();
route();
