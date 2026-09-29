import fs from 'node:fs';
import path from 'node:path';
import { buildBoard } from './board.js';

// A small local stand-in for Jira so the game works before credentials are set up.
// Data lives in data/demo-data.json; delete that file to reset.

const DEMO_COMPONENTS = ['Web', 'Mobile', 'Backend', 'Payments'];
const DEMO_FIELDS = [
  { id: 'customfield_10100', name: 'Work group', type: 'option', allowedValues: ['Team Rocket', 'Platform', 'Growth'] },
  { id: 'customfield_10001', name: 'Team', type: 'team', allowedValues: [] },
];

// A small workflow so the Kanban view has columns in demo mode.
const DEMO_STATUSES = [
  { id: 'todo', name: 'To Do', category: 'new' },
  { id: 'progress', name: 'In Progress', category: 'indeterminate' },
  { id: 'review', name: 'In Review', category: 'indeterminate' },
];
const statusOf = (i) => (i.done ? { id: 'done', name: 'Done', category: 'done' } : DEMO_STATUSES.find((x) => x.id === i.status) || DEMO_STATUSES[0]);

const TYPE_NAMES = { task: 'Task', bug: 'Bug', story: 'Story', epic: 'Epic' };

function seed() {
  const now = Date.now();
  const day = 86400000;
  const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  const issues = [];
  const counters = { GAME: 0, SHOP: 0 };
  const add = (
    project,
    type,
    summary,
    { done = false, parent = null, age = 10, doneAge = null, description = '', comments = [], priority = 'Medium' } = {},
  ) => {
    const key = `${project}-${++counters[project]}`;
    issues.push({
      key,
      project,
      type,
      summary,
      done,
      parentKey: parent,
      created: iso(age),
      doneAt: done ? iso(doneAge ?? Math.max(0, age - 2)) : null,
      description,
      priority,
      comments: comments.map((body, i) => ({ author: i % 2 ? 'Alex' : 'Sam', body, created: iso(Math.max(0, age - 1 - i)) })),
    });
    return key;
  };

  const login = add('GAME', 'epic', 'Login & onboarding', { age: 30 });
  add('GAME', 'task', 'Design the sign-up form', { parent: login, done: true, age: 29, doneAge: 20 });
  add('GAME', 'story', 'As a user I can reset my password', { parent: login, done: true, age: 28, doneAge: 15 });
  add('GAME', 'bug', 'Email validation accepts "a@b"', { parent: login, done: true, age: 20, doneAge: 12 });
  add('GAME', 'task', 'Add Google sign-in', { parent: login, done: true, age: 18, doneAge: 6 });
  add('GAME', 'bug', 'Welcome email sent twice', {
    parent: login,
    age: 9,
    priority: 'High',
    description:
      'h3. Steps to reproduce\n# Sign up with a new email\n# Confirm the address\n\n*Expected:* one welcome email.\n*Actual:* two identical emails arrive a few seconds apart.',
    comments: ['Looks like the confirm webhook fires twice.', 'Confirmed on staging, taking this one.'],
  });
  add('GAME', 'task', 'Onboarding tour with 3 steps', {
    parent: login,
    age: 8,
    description: 'Show a short tour after the first login: profile, dashboard, invite teammates. Skippable.',
  });
  add('GAME', 'bug', 'Avatar upload crashes on HEIC images', { parent: login, age: 5 });
  add('GAME', 'task', 'Write onboarding analytics events', { parent: login, age: 4 });

  const board = add('GAME', 'epic', 'Leaderboard', { age: 25, done: true, doneAge: 3 });
  add('GAME', 'task', 'Leaderboard API endpoint', { parent: board, done: true, age: 24, doneAge: 14 });
  add('GAME', 'bug', 'Ties are sorted randomly', { parent: board, done: true, age: 16, doneAge: 9 });
  add('GAME', 'story', 'As a player I see my rank', { parent: board, done: true, age: 15, doneAge: 5 });

  const pay = add('GAME', 'epic', 'Payments', { age: 7 });
  add('GAME', 'task', 'Pick a payment provider', { parent: pay, age: 7 });
  add('GAME', 'bug', 'Currency shows as USD for everyone', { parent: pay, age: 6 });
  add('GAME', 'story', 'As a buyer I can pay by card', { parent: pay, age: 5 });
  add('GAME', 'task', 'Receipt email template', { parent: pay, age: 3 });

  add('GAME', 'task', 'Upgrade Node to the current LTS', { age: 2 });
  add('GAME', 'bug', 'Dark mode toggle forgets its setting', { age: 1 });

  const cart = add('SHOP', 'epic', 'Shopping cart', { age: 12 });
  add('SHOP', 'task', 'Cart drawer UI', { parent: cart, done: true, age: 11, doneAge: 7 });
  add('SHOP', 'bug', 'Quantity can go negative', { parent: cart, age: 6 });
  add('SHOP', 'task', 'Persist cart between visits', { parent: cart, age: 4 });

  return {
    projects: [
      { key: 'GAME', name: 'Bug Rally Demo' },
      { key: 'SHOP', name: 'Web Shop' },
    ],
    counters,
    issues,
  };
}

// Tiny subset of Jira wiki markup, so demo descriptions/comments look like they would in Jira.
function wikiToHtml(text, attachments = []) {
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const byName = (n) => attachments.find((a) => a.filename === n);
  const inline = (t) =>
    esc(t)
      .replace(/!([^!|\n]+?)(\|[^!\n]*)?!/g, (m, name) => {
        const a = byName(name.trim());
        return a ? `<img src="/api/attachments/${a.id}/content" alt="${esc(a.filename)}">` : m;
      })
      .replace(/\[\^([^\]]+)\]/g, (m, name) => {
        const a = byName(name.trim());
        return a ? `<a href="/api/attachments/${a.id}/content?download=1">${esc(a.filename)}</a>` : m;
      })
      .replace(/\[([^|\]]+)\|(https?:\/\/[^\]\s]+)\]/g, '<a href="$2">$1</a>')
      .replace(/\{\{(.+?)\}\}/g, '<code>$1</code>')
      .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,!?:;]|$)/g, '$1<b>$2</b>')
      .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  const out = [];
  let list = null;
  let para = [];
  let code = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (code !== null) {
      if (/^\{code\}\s*$/.test(line)) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\{code(:[^}]*)?\}\s*$/.test(line)) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const h = line.match(/^h([1-6])\.\s+(.*)$/);
    const li = line.match(/^([*#])+\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1]}>${inline(h[2])}</h${h[1]}>`);
    } else if (li) {
      flushPara();
      const tag = li[1] === '#' ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push(li[2]);
    } else if (/^bq\.\s+/.test(line)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(line.replace(/^bq\.\s+/, ''))}</blockquote>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushPara();
  flushList();
  return out.join('');
}

const RASTER = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

export function createDemoBackend(file, attachDir) {
  let db;
  if (fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    db = seed();
    db.issues.find((i) => i.key === 'GAME-7').status = 'progress';
    db.issues.find((i) => i.key === 'GAME-6').status = 'review';
    save();
  }

  // Rank: lower number = higher up. Issues without one get it from their creation order.
  const ensureRanks = () => {
    let max = Math.max(0, ...db.issues.map((i) => i.rank || 0));
    for (const i of db.issues) if (i.rank == null) i.rank = max += 1000;
  };

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
  }

  const view = (i) => ({
    key: i.key,
    summary: i.summary,
    type: i.type,
    typeName: i.typeName || TYPE_NAMES[i.type] || 'Task',
    statusName: statusOf(i).name,
    statusId: statusOf(i).id,
    statusCategory: statusOf(i).category,
    done: i.done,
    priority: i.priority || 'Medium',
    parentSummary: i.parentKey ? find(i.parentKey)?.summary || null : null,
    assignee: null,
    created: i.created,
    doneAt: i.doneAt,
    parentKey: i.parentKey,
    projectKey: i.project,
    url: null,
  });

  // Apply a world's default labels / components / work group to a demo issue.
  function stamp(i, d, homeProject) {
    const applied = [];
    const skipped = [];
    if (d.labels.length) {
      i.labels = [...new Set([...(i.labels || []), ...d.labels])];
      applied.push('labels');
    }
    if (d.components.length) {
      if (i.project === homeProject) {
        i.components = [...new Set([...(i.components || []), ...d.components])];
        applied.push('components');
      } else skipped.push('components');
    }
    if (d.workGroup) {
      i.fields = { ...(i.fields || {}), [d.workGroup.fieldId]: d.workGroup.valueLabel };
      applied.push(d.workGroup.fieldName);
    }
    return { applied, skipped };
  }

  const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });
  const find = (key) => db.issues.find((i) => i.key === key);

  return {
    mode: 'demo',

    async status() {
      return { mode: 'demo' };
    },

    async listProjects() {
      return db.projects.map((p) => ({ ...p, url: null }));
    },

    async projectInfo(key) {
      const p = db.projects.find((x) => x.key === key);
      if (!p) throw notFound(`Project ${key}`);
      return { ...p, url: null };
    },

    async createProject({ key, name }) {
      if (db.projects.some((p) => p.key === key)) {
        throw Object.assign(new Error(`A project with key ${key} already exists.`), { status: 409 });
      }
      db.projects.push({ key, name });
      db.counters[key] = 0;
      save();
      return { key, name, url: null };
    },

    async board(projectKey, { linked = [], hidden = [] } = {}) {
      const project = db.projects.find((p) => p.key === projectKey);
      if (!project) throw notFound(`Project ${projectKey}`);
      const hiddenSet = new Set(hidden);
      const native = db.issues.filter((i) => i.project === projectKey && i.type === 'epic').map(view);
      const nativeKeys = new Set(native.map((e) => e.key));
      const linkedEpics = linked
        .filter((k) => !nativeKeys.has(k))
        .map(find)
        .filter((i) => i && i.type === 'epic')
        .map((i) => ({ ...view(i), linked: true }));
      const epics = [...native.filter((e) => !hiddenSet.has(e.key)), ...linkedEpics];
      const epicKeys = new Set(epics.map((e) => e.key));
      const board = buildBoard(
        { ...project, url: null },
        epics,
        db.issues.filter((i) => epicKeys.has(i.parentKey)).map(view),
        db.issues.filter((i) => i.project === projectKey && !i.parentKey && i.type !== 'epic').map(view),
      );
      board.hiddenFeatures = native.filter((e) => hiddenSet.has(e.key));
      return board;
    },

    async getIssue(key, { workGroup } = {}) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      const parent = i.parentKey ? find(i.parentKey) : null;
      return {
        ...view(i),
        priority: i.priority || 'Medium',
        reporter: 'Demo user',
        updated: i.doneAt || i.created,
        duedate: null,
        labels: i.labels || [],
        components: i.components || [],
        parent: parent ? { key: parent.key, summary: parent.summary } : null,
        descriptionHtml: wikiToHtml(i.description, i.attachments),
        subtasks: [],
        comments: (i.comments || []).map((c) => ({ author: c.author, created: c.created, bodyHtml: wikiToHtml(c.body, i.attachments) })),
        commentsTotal: (i.comments || []).length,
        workGroup: workGroup ? { name: workGroup.fieldName, value: i.fields?.[workGroup.fieldId] || '' } : null,
        attachments: (i.attachments || []).map((a) => ({ ...a, isImage: RASTER.test(a.mimeType) })),
      };
    },

    async attachment(id) {
      const hit = db.issues.flatMap((i) => i.attachments || []).find((a) => a.id === String(id));
      if (!hit) throw notFound('Attachment');
      return { buffer: fs.readFileSync(path.join(attachDir, hit.id)), filename: hit.filename, mimeType: hit.mimeType };
    },

    async uploadAttachment(key, { filename, mimeType, buffer }) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      db.attachSeq = (db.attachSeq || 10000) + 1;
      const a = {
        id: String(db.attachSeq),
        filename,
        mimeType,
        size: buffer.length,
        created: new Date().toISOString(),
        author: 'Demo user',
      };
      fs.mkdirSync(attachDir, { recursive: true });
      fs.writeFileSync(path.join(attachDir, a.id), buffer);
      (i.attachments ||= []).push(a);
      save();
      return [{ ...a, isImage: RASTER.test(mimeType) }];
    },

    async getDescriptionSource(key) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      return { text: i.description || '' };
    },

    async setDescription(key, text) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      i.description = text;
      save();
      return { key };
    },

    async addComment(key, text) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      (i.comments ||= []).push({ author: 'Demo user', body: text, created: new Date().toISOString() });
      save();
      return { id: String(i.comments.length) };
    },

    async bugTypeName(projectKey, preferred) {
      return preferred || 'Bug';
    },

    async worldOptions() {
      return {
        filtersAvailable: false,
        issueTypes: ['Task', 'Story', 'Bug', 'Fault Report'],
        components: DEMO_COMPONENTS,
        fields: DEMO_FIELDS,
        fieldsFrom: 'Task',
      };
    },

    async searchFilters() {
      throw Object.assign(new Error('Saved filters need a Jira connection.'), { status: 400 });
    },

    async testFilter() {
      throw Object.assign(new Error('Filters need a Jira connection. In demo mode every world shows its whole project.'), {
        status: 400,
      });
    },

    async applyDefaults(key, defaults, homeProject) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      const res = stamp(i, defaults, homeProject);
      save();
      return res;
    },

    async searchIssues({ q, kind, projectKey, onlyProject }) {
      const needle = String(q || '').trim().toLowerCase();
      return db.issues
        .filter((i) => (kind === 'feature' ? i.type === 'epic' : i.type !== 'epic'))
        .filter((i) => !onlyProject || i.project === projectKey)
        .filter((i) => !needle || i.key.toLowerCase() === needle || i.summary.toLowerCase().includes(needle))
        .slice(-25)
        .reverse()
        .map(view);
    },

    async setParent(key, parentKey) {
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      if (parentKey) {
        const p = find(parentKey);
        if (!p || p.type !== 'epic') throw notFound(`Feature ${parentKey}`);
      }
      i.parentKey = parentKey || null;
      save();
      return { key, parentKey: i.parentKey };
    },

    async createIssue({ projectKey, kind, summary, parentKey, defaults, homeProject }) {
      if (!db.projects.some((p) => p.key === projectKey)) throw notFound(`Project ${projectKey}`);
      if (parentKey && !find(parentKey)) throw notFound(`Feature ${parentKey}`);
      db.counters[projectKey] = (db.counters[projectKey] || 0) + 1;
      const key = `${projectKey}-${db.counters[projectKey]}`;
      db.issues.push({
        key,
        project: projectKey,
        type: kind,
        typeName: kind === 'bug' && defaults?.bugType ? defaults.bugType : undefined,
        summary,
        done: false,
        parentKey: kind === 'epic' ? null : parentKey || null,
        created: new Date().toISOString(),
        doneAt: null,
      });
      const res = defaults ? stamp(db.issues.at(-1), defaults, homeProject) : { applied: [], skipped: [] };
      save();
      return { key, ...res };
    },

    async setDone(key, done) {
      const issue = find(key);
      if (!issue) throw notFound(`Issue ${key}`);
      issue.done = done;
      issue.doneAt = done ? new Date().toISOString() : null;
      if (!done) issue.status = 'todo';
      save();
      return { key, done, status: done ? 'Done' : 'To Do' };
    },

    async listBoards() {
      return [{ id: '1', name: 'Demo team board', type: 'kanban' }];
    },

    async kanban(projectKey, { linked = [], hidden = [] } = {}, layout = { mode: 'category' }) {
      ensureRanks();
      const ALL = [...DEMO_STATUSES, { id: 'done', name: 'Done', category: 'done' }];
      const st = (id) => {
        const x = ALL.find((d) => d.id === id);
        return { id: x.id, name: x.name, category: x.category };
      };
      let columns =
        layout.mode === 'custom'
          ? layout.columns.map((c, i) => ({ id: `cu${i}`, name: c.name, statuses: c.statusIds.filter((id) => ALL.some((d) => d.id === id)).map(st) }))
          : layout.mode === 'status'
            ? DEMO_STATUSES.map((x) => ({ id: `st${x.id}`, name: x.name, statuses: [st(x.id)] }))
            : layout.mode === 'board'
              ? [
                  { id: 'col0', name: 'To Do', statuses: [st('todo')] },
                  { id: 'col1', name: 'In Progress', statuses: [st('progress')] },
                  { id: 'col2', name: 'Verification', statuses: [st('review')] },
                  { id: 'col3', name: 'Done', statuses: [st('done')] },
                ]
              : [
                  { id: 'cat-new', name: 'To Do', statuses: [st('todo')] },
                  { id: 'cat-progress', name: 'In Progress', statuses: [st('progress'), st('review')] },
                ];
      const showDone = columns.some((c) => c.statuses.some((x) => x.id === 'done'));
      const since = Date.now() - 14 * 86400000;
      const hiddenSet = new Set(hidden);
      const issues = db.issues
        .filter((i) => i.type !== 'epic')
        .filter((i) => !i.done || (showDone && new Date(i.doneAt).getTime() >= since))
        .filter((i) => i.project === projectKey || linked.includes(i.parentKey))
        .filter((i) => !hiddenSet.has(i.parentKey))
        .sort((a, b) => a.rank - b.rank)
        .map(view);
      const mapped = new Set(columns.flatMap((c) => c.statuses.map((x) => x.id)));
      const stray = ALL.filter((d) => !mapped.has(d.id) && issues.some((i) => i.statusId === d.id));
      if (stray.length) columns.push({ id: 'other', name: 'Other statuses', statuses: stray.map((d) => st(d.id)) });
      columns = columns.map((c) => ({
        ...c,
        category: c.statuses.length && c.statuses.every((x) => x.category === 'done') ? 'done' : c.statuses.every((x) => x.category === 'new') ? 'new' : 'indeterminate',
      }));
      return {
        columns,
        issues,
        layout,
        layoutError: null,
        doneWindowDays: showDone ? 14 : 0,
        allStatuses: ALL.map((d) => ({ id: d.id, name: d.name, category: d.category })),
      };
    },

    async moveIssue(key, { statusIds = [], done, before, after }) {
      const statusId = statusIds[0];
      ensureRanks();
      const i = find(key);
      if (!i) throw notFound(`Issue ${key}`);
      if (done || statusId === 'done') {
        i.done = true;
        i.doneAt = new Date().toISOString();
      } else if (statusId) {
        i.done = false;
        i.doneAt = null;
        if (!DEMO_STATUSES.some((x) => x.id === statusId)) throw Object.assign(new Error('Unknown status'), { status: 400 });
        i.status = statusId;
      }
      if (before || after) {
        const sorted = db.issues.filter((x) => x !== i).sort((a, b) => a.rank - b.rank);
        const idx = sorted.findIndex((x) => x.key === (before || after));
        if (idx < 0) throw notFound(`Issue ${before || after}`);
        if (before) {
          const prev = sorted[idx - 1];
          i.rank = prev ? (prev.rank + sorted[idx].rank) / 2 : sorted[idx].rank - 1000;
        } else {
          const next = sorted[idx + 1];
          i.rank = next ? (sorted[idx].rank + next.rank) / 2 : sorted[idx].rank + 1000;
        }
      }
      save();
      return { key, ranked: Boolean(before || after) };
    },
  };
}
