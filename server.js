import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import { createJiraBackend, tokenConnection } from './lib/jira.js';
import { createDemoBackend } from './lib/demo.js';
import { createOAuth, OAUTH_SCOPES, SOFTWARE_SCOPES } from './lib/oauth.js';
import { ALL_TEAM, createSettings, normalizeTeam } from './lib/settings.js';
import { ISSUE_KEY_RE, KINDS, PROJECT_KEY_RE } from './lib/board.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));

const PORT = Number(process.env.PORT) || 3000;
// Only reachable from this computer by default, since the settings page can store Jira credentials.
const HOST = process.env.HOST || '127.0.0.1';
// The address people open in the browser. Must match the callback URL registered for "Sign in with Atlassian".
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const CALLBACK_URL = `${PUBLIC_URL}/auth/callback`;
const DEFAULT_TEMPLATE = 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;

const settings = createSettings(path.join(root, 'data', 'settings.json'));
const oauth = createOAuth({
  file: path.join(root, 'data', 'sessions.json'),
  getConfig: () => currentJiraConfig().cfg || {},
});
let demo = null;
let sharedBackend; // demo or API-token backend; null when each user signs in with OAuth
let source; // 'settings' | 'env' | 'none'
let method; // 'demo' | 'token' | 'oauth'
const sessionBackends = new Map();

function envJira() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_TEMPLATE } = process.env;
  if (!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN)) return null;
  return { method: 'token', baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, token: JIRA_API_TOKEN, projectTemplate: JIRA_PROJECT_TEMPLATE };
}

function currentJiraConfig() {
  if (settings.hasJiraEntry()) {
    const cfg = settings.getJira();
    return { cfg: cfg ? { method: 'token', ...cfg } : null, source: cfg ? 'settings' : 'none' };
  }
  const env = envJira();
  return { cfg: env, source: env ? 'env' : 'none' };
}

function makeTokenBackend(cfg) {
  return createJiraBackend({ ...tokenConnection(cfg), projectTemplate: cfg.projectTemplate || DEFAULT_TEMPLATE });
}

function applyConfig() {
  const { cfg, source: src } = currentJiraConfig();
  source = src;
  sessionBackends.clear();
  if (!cfg) {
    method = 'demo';
    demo ||= createDemoBackend(path.join(root, 'data', 'demo-data.json'), path.join(root, 'data', 'demo-attachments'));
    sharedBackend = demo;
  } else if (cfg.method === 'oauth') {
    method = 'oauth';
    sharedBackend = null;
  } else {
    method = 'token';
    sharedBackend = makeTokenBackend(cfg);
  }
}
applyConfig();

/* ---------- Helpers ---------- */
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const issueKey = (k) => {
  const key = String(k || '').toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) throw bad('Invalid issue key.');
  return key;
};
const projectKey = (k) => {
  const key = String(k || '').toUpperCase();
  if (!PROJECT_KEY_RE.test(key)) throw bad('Invalid project key.');
  return key;
};

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}
function setCookie(res, name, value, { maxAge, path: p = '/' } = {}) {
  const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=Lax${secure}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}`,
  );
}

// The backend for this request: shared (demo / API token) or this browser's own Atlassian sign-in.
function be(req) {
  if (sharedBackend) return sharedBackend;
  const sid = cookies(req).bq_sid;
  if (!oauth.getSession(sid)) throw Object.assign(new Error('Please sign in with Atlassian.'), { status: 401, needsLogin: true });
  if (!sessionBackends.has(sid)) {
    const cfg = currentJiraConfig().cfg;
    sessionBackends.set(sid, createJiraBackend({ ...oauth.connectionFor(sid), projectTemplate: cfg.projectTemplate || DEFAULT_TEMPLATE }));
  }
  return sessionBackends.get(sid);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
// Always check for a newer copy, so a reload picks up changes to the page.
app.use(express.static(path.join(root, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Which code is running: shown on the project page, so it's easy to see whether a restart is needed.
const STARTED_AT = new Date().toISOString();
const codeDate = () => {
  let latest = 0;
  for (const f of ['server.js', ...fs.readdirSync(path.join(root, 'lib')).map((x) => `lib/${x}`)]) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(root, f)).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return new Date(latest).toISOString();
};
const serverInfo = () => ({ startedAt: STARTED_AT, codeChangedAt: codeDate(), folder: root });

const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .then((data) => {
      if (!res.headersSent) res.json(data);
    }, next);

/* ---------- Sign in with Atlassian ---------- */
app.get('/auth/login', (req, res) => {
  if (method !== 'oauth') return res.redirect('/#/settings');
  // The state cookie must be set on the same host the callback comes back to.
  if (`${req.protocol}://${req.get('host')}` !== PUBLIC_URL) return res.redirect(`${PUBLIC_URL}/auth/login`);
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'bq_state', state, { maxAge: 600, path: '/auth' });
  res.redirect(oauth.authorizeUrl({ redirectUri: CALLBACK_URL, state }));
});

app.get('/auth/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/#/signin?error=${encodeURIComponent(msg)}`);
  if (req.query.error) return fail(req.query.error_description || String(req.query.error));
  const state = cookies(req).bq_state;
  setCookie(res, 'bq_state', '', { maxAge: 0, path: '/auth' });
  if (!state || state !== req.query.state) return fail('The sign-in took too long or was started in another tab. Please try again.');
  try {
    const sid = await oauth.finishLogin({ code: String(req.query.code || ''), redirectUri: CALLBACK_URL });
    setCookie(res, 'bq_sid', sid, { maxAge: 90 * 24 * 3600 });
    res.redirect('/#/');
  } catch (e) {
    fail(e.message);
  }
});

app.post('/auth/logout', (req, res) => {
  const sid = cookies(req).bq_sid;
  if (sid) {
    oauth.destroy(sid);
    sessionBackends.delete(sid);
  }
  setCookie(res, 'bq_sid', '', { maxAge: 0 });
  res.json({ ok: true });
});

/* ---------- Connection settings (only from this computer) ---------- */
const localOnly = (req, res, next) => {
  const ip = req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: 'Settings can only be changed from the computer running Bug Rally.' });
};

const hint = (secret) => (secret ? `••••${secret.slice(-4)}` : '');

function publicSettings() {
  const { cfg } = currentJiraConfig();
  return {
    mode: method === 'demo' ? 'demo' : 'jira',
    method,
    source,
    envAvailable: Boolean(envJira()),
    callbackUrl: CALLBACK_URL,
    signedInCount: method === 'oauth' ? oauth.count() : 0,
    scopes: OAUTH_SCOPES,
    softwareScopeList: SOFTWARE_SCOPES,
    jira: cfg
      ? {
          method: cfg.method,
          baseUrl: new URL(cfg.method === 'oauth' ? cfg.siteUrl : cfg.baseUrl).origin,
          email: cfg.email || '',
          tokenHint: hint(cfg.token),
          clientId: cfg.clientId || '',
          secretHint: hint(cfg.clientSecret),
          softwareScopes: cfg.softwareScopes === true,
          projectTemplate: cfg.projectTemplate || DEFAULT_TEMPLATE,
        }
      : null,
  };
}

function siteOrigin(value) {
  let v = String(value || '').trim();
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    return new URL(v).origin;
  } catch {
    throw bad('Enter your Jira address, like https://your-company.atlassian.net');
  }
}

function readJiraForm(body) {
  const current = currentJiraConfig().cfg || {};
  const same = (m) => current.method === m;
  const projectTemplate = String(body?.projectTemplate || '').trim() || DEFAULT_TEMPLATE;
  if (body?.method === 'oauth') {
    const clientId = String(body.clientId || '').trim();
    if (!clientId) throw bad('Enter the Client ID of your Atlassian app.');
    // Leaving the secret blank keeps the one already saved.
    const clientSecret = String(body.clientSecret || '').trim() || (same('oauth') ? current.clientSecret : '');
    if (!clientSecret) throw bad('Enter the Client secret of your Atlassian app.');
    return {
      method: 'oauth',
      siteUrl: siteOrigin(body.baseUrl),
      clientId,
      clientSecret,
      projectTemplate,
      // Jira Software permissions (boards, ranking). Off unless ticked; must match the app in the developer console.
      softwareScopes: body.softwareScopes === true || body.softwareScopes === 'on',
    };
  }
  const email = String(body?.email || '').trim();
  if (!email) throw bad('Enter the email you log in to Jira with.');
  const token = String(body?.token || '').trim() || (same('token') ? current.token : '');
  if (!token) throw bad('Enter an API token.');
  return { method: 'token', baseUrl: siteOrigin(body?.baseUrl), email, token, projectTemplate };
}

app.get('/api/settings', localOnly, wrap(() => publicSettings()));

app.post(
  '/api/settings/test',
  localOnly,
  wrap(async (req) => {
    const cfg = readJiraForm(req.body);
    if (cfg.method === 'oauth') return { ok: true, note: 'Saved app details are checked when you sign in.' };
    return { ok: true, ...(await makeTokenBackend(cfg).status()) };
  }),
);

app.post(
  '/api/settings',
  localOnly,
  wrap(async (req) => {
    const cfg = readJiraForm(req.body);
    let user = null;
    if (cfg.method === 'token') user = (await makeTokenBackend(cfg).status()).user; // only save a login that works
    const before = currentJiraConfig().cfg;
    settings.setJira(cfg);
    // New app, site or permissions: old sign-ins don't match any more, so everyone signs in again.
    if (
      cfg.method !== 'oauth' ||
      before?.clientId !== cfg.clientId ||
      before?.siteUrl !== cfg.siteUrl ||
      (before?.softwareScopes === true) !== cfg.softwareScopes
    )
      oauth.destroyAll();
    applyConfig();
    return { ...publicSettings(), user };
  }),
);

app.post(
  '/api/settings/demo',
  localOnly,
  wrap(() => {
    settings.setJira(null);
    oauth.destroyAll();
    applyConfig();
    return publicSettings();
  }),
);

app.delete(
  '/api/settings',
  localOnly,
  wrap(() => {
    settings.clearJiraEntry();
    oauth.destroyAll();
    applyConfig();
    return publicSettings();
  }),
);

/* ---------- Game data ---------- */
app.get(
  '/api/status',
  wrap(async (req) => {
    if (method === 'oauth') {
      const sid = cookies(req).bq_sid;
      const s = oauth.getSession(sid);
      const site = currentJiraConfig().cfg.siteUrl;
      if (!s) return { mode: 'jira', auth: 'oauth', signedIn: false, site, source, server: serverInfo() };
      return { ...(await be(req).status()), auth: 'oauth', signedIn: true, source, server: serverInfo() };
    }
    return { ...(await be(req).status()), signedIn: true, source, server: serverInfo() };
  }),
);

app.get(
  '/api/projects',
  wrap(async (req) => {
    const projects = await be(req).listProjects();
    return projects;
  }),
);

app.post(
  '/api/projects',
  wrap((req) => {
    const name = String(req.body?.name || '').trim();
    const key = String(req.body?.key || '').trim().toUpperCase();
    if (!name) throw bad('Give the project a name.');
    if (!PROJECT_KEY_RE.test(key)) throw bad('Key must be 2–10 characters: letters, digits or _, starting with a letter.');
    return be(req).createProject({ key, name });
  }),
);

/* ---------- Team pages: one per Jira board ---------- */
const teamOf = (pk, id) => {
  const team = settings.getTeam(pk, String(id || ''));
  if (!team) throw bad('That team page no longer exists.', 404);
  return team;
};
// The project's boards as the project page shows them (hidden ones and boards from elsewhere left out).
const isBoardHidden = (key) => {
  const hidden = new Set(settings.getHiddenBoards(key));
  const shown = new Set(settings.getShownBoards(key));
  return (b) => hidden.has(b.id) || (b.elsewhere && !shown.has(b.id));
};
async function visibleBoards(backend, key) {
  const hiddenFn = isBoardHidden(key);
  return (await backend.listBoards(key)).filter((b) => !b.broken && !hiddenFn(b));
}

// Off-board work. Cached for 5 minutes per sign-in.
const offboardCache = new Map();
const cacheKey = (req, ...parts) => [cookies(req).bq_sid || 'shared', ...parts].join('|');
const cached = async (ck, make) => {
  const hit = offboardCache.get(ck);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.value;
  const value = await make();
  offboardCache.set(ck, { value, at: Date.now() });
  return value;
};
// A board whose filter is just the whole project ("project = KEY") shows everything, so nothing would ever be
// "off-board". Those boards are left out of the project's "Not on any board" check.
const isCatchAll = (jql, key) =>
  new RegExp(`^\\s*project\\s*(=|in)\\s*\\(?\\s*"?${key}"?\\s*\\)?\\s*$`, 'i').test(String(jql || '').trim());

// Project: unfinished work that none of the project's shown boards (except catch-all ones) include.
async function offboardInfo(req, backend, key) {
  return cached(cacheKey(req, key, 'project'), async () => {
    const boards = await visibleBoards(backend, key);
    const withJql = await Promise.all(
      boards.map(async (b) => {
        try {
          return { ...b, jql: await backend.boardJql(b.id) };
        } catch (e) {
          throw Object.assign(new Error(`Board “${b.name}” couldn't be read, so off-board work can't be worked out: ${e.message}`), { status: 502 });
        }
      }),
    );
    const real = withJql.filter((b) => !isCatchAll(b.jql, key));
    const notOnAny = real.length ? ` AND NOT (${real.map((b) => `(${b.jql})`).join(' OR ')})` : '';
    return {
      projectJql: `project = "${key}"${notOnAny}`,
      boardCount: real.length,
      ignored: withJql.filter((b) => isCatchAll(b.jql, key)).map((b) => b.name),
    };
  });
}
// One board: tickets in the project assigned to the board's people (assignees of its not-started tickets)
// that this board doesn't show.
async function boardOffInfo(req, backend, key, boardId) {
  return cached(cacheKey(req, key, 'board', boardId), async () => {
    const [jql, people] = await Promise.all([backend.boardJql(boardId), backend.boardPeople(boardId)]);
    const ids = people.map((p) => `"${String(p.id).replace(/"/g, '')}"`).join(',');
    return {
      people,
      jql: people.length ? `project = "${key}" AND assignee in (${ids}) AND NOT (${jql})` : null,
    };
  });
}
const clearOffboard = (key) => {
  for (const k of offboardCache.keys()) if (k.split('|')[1] === key) offboardCache.delete(k);
};

// For the automatic off-board pages: the team with its filter filled in.
async function resolveTeam(req, backend, key, team) {
  if (!team.special) return team;
  if (team.special === 'offboard') {
    const info = await offboardInfo(req, backend, key);
    return {
      ...team,
      openOnly: true,
      filter: { mode: 'jql', jql: info.projectJql, applyToItems: true },
      boardCount: info.boardCount,
      ignored: info.ignored,
    };
  }
  const info = await boardOffInfo(req, backend, key, team.peopleOf);
  // No people → match nothing.
  const jql = info.jql || `project = "${key}" AND created < "1971-01-01"`;
  return { ...team, openOnly: true, people: info.people, filter: { mode: 'jql', jql, applyToItems: true } };
}

// What an off-board page shows, counted from the same data the page loads: unfinished features (that match
// themselves, not ones only shown because they hold a matching ticket), tasks, stories and bugs.
async function offCounts(req, backend, key, team) {
  return cached(cacheKey(req, key, 'count', team.id), async () => {
    const b = await backend.board(key, team, { maxFeatures: 2000, openOnly: true });
    const items = [...b.features.flatMap((f) => f.items), ...b.unsorted].filter((i) => !i.done);
    const features = b.features.filter((f) => !f.viaItems && !f.done).length;
    const bugs = items.filter((i) => i.type === 'bug').length;
    return { count: features + items.length, features, tasks: items.length - bugs, bugs };
  });
}
// What the browser gets: the team without the (long) generated JQL.
const publicTeam = (t) => (t.special ? { ...t, filter: { mode: 'auto' } } : t);

// Team + project, from a request body/query that names them. Used to apply a team's defaults.
const teamFrom = (src) => (src?.worldKey && src?.teamId ? { pk: projectKey(src.worldKey), team: teamOf(projectKey(src.worldKey), src.teamId) } : null);

app.get(
  '/api/projects/:key/teams',
  wrap(async (req) => {
    const key = projectKey(req.params.key);
    const backend = be(req);
    const [project, boards] = await Promise.all([
      backend.projectInfo(key),
      backend.listBoards(key).then(
        (list) => ({ list }),
        (e) => ({ error: e.message }),
      ),
    ]);
    const list = boards.list || [];
    const usable = list.filter((b) => !b.broken);
    const hidden = new Set(settings.getHiddenBoards(key));
    // Hidden: hidden by you, or a board from elsewhere (other project, personal) you haven't chosen to show.
    const isHidden = isBoardHidden(key);
    return {
      project,
      teams: settings.boardTeams(key, usable.filter((b) => !isHidden(b))),
      hiddenBoards: usable
        .filter(isHidden)
        .map(({ id, name, type, elsewhere }) => ({ id, name, type, reason: hidden.has(id) ? 'hidden by you' : elsewhere })),
      // Boards Jira still lists but that can't be used (deleted, no filter…). Never shown as teams.
      brokenBoards: list.filter((b) => b.broken).map(({ id, name, broken }) => ({ id, name, reason: broken })),
      boardsError: boards.error || null,
    };
  }),
);

// Off-board counts: the project tile, and one board (from inside its team page).
app.get(
  '/api/projects/:key/offboard',
  wrap(async (req) => {
    const key = projectKey(req.params.key);
    const backend = be(req);
    if (req.query.refresh) clearOffboard(key);
    const team = await resolveTeam(req, backend, key, teamOf(key, '_offboard'));
    const counts = await offCounts(req, backend, key, team).catch(() => ({ count: null }));
    return { ...counts, boards: team.boardCount, ignored: team.ignored };
  }),
);
app.get(
  '/api/projects/:key/offboard/:board',
  wrap(async (req) => {
    const key = projectKey(req.params.key);
    const boardId = String(req.params.board).replace(/\D/g, '');
    const backend = be(req);
    const team = await resolveTeam(req, backend, key, teamOf(key, `o${boardId}`));
    const counts = team.people.length ? await offCounts(req, backend, key, team).catch(() => ({ count: null })) : { count: 0 };
    return { ...counts, people: team.people.map((p) => p.name) };
  }),
);

// Hide or show a board on the project page. Only saved in Bug Rally.
app.put(
  '/api/projects/:key/hidden-boards',
  wrap((req) => {
    be(req);
    const boardId = String(req.body?.boardId || '').replace(/\D/g, '').slice(0, 20);
    if (!boardId) throw bad('Which board?');
    clearOffboard(projectKey(req.params.key));
    return { hiddenBoards: settings.setBoardHidden(projectKey(req.params.key), boardId, Boolean(req.body?.hidden)) };
  }),
);

app.get('/api/projects/:key/teams/:team', wrap((req) => teamOf(projectKey(req.params.key), req.params.team)));

// Accepts the parts of a team page Bug Rally keeps: linked, hidden, filter.applyToItems, defaults.
// The name, filter and columns come from the Jira board.
app.put(
  '/api/projects/:key/teams/:team',
  wrap((req) => {
    be(req);
    const key = projectKey(req.params.key);
    const id = req.params.team;
    if (id === ALL_TEAM || settings.getTeam(key, id)?.special) throw bad('This page is automatic and has no settings. Open one of the boards instead.');
    teamOf(key, id);
    const body = req.body || {};
    const patch = {};
    if ('linked' in body) patch.linked = (body.linked || []).map(issueKey);
    if ('hidden' in body) patch.hidden = (body.hidden || []).map(issueKey);
    if ('filter' in body) patch.filter = { applyToItems: body.filter?.applyToItems !== false };
    if ('defaults' in body) {
      const d = normalizeTeam({ defaults: body.defaults }).defaults;
      const badLabel = d.labels.find((l) => /\s/.test(l));
      if (badLabel) throw bad(`Jira labels can't contain spaces: “${badLabel}”. Use a dash instead.`);
      patch.defaults = d;
    }
    return settings.updateTeam(key, id, patch);
  }),
);


app.get(
  '/api/projects/:key/teams/:team/board',
  wrap(async (req) => {
    const key = projectKey(req.params.key);
    const backend = be(req);
    const team = await resolveTeam(req, backend, key, teamOf(key, req.params.team));
    // ?features=400 loads more features (200 at a time).
    const maxFeatures = Math.min(10000, Math.max(200, Math.ceil((Number(req.query.features) || 200) / 200) * 200));
    const [board, bugTypeName] = await Promise.all([
      backend.board(key, team, { maxFeatures, openOnly: Boolean(team.openOnly) }),
      backend.bugTypeName(key, team.defaults.bugType),
    ]);
    return { ...board, team: publicTeam(team), bugTypeName };
  }),
);

app.get(
  '/api/projects/:key/teams/:team/kanban',
  wrap(async (req) => {
    const key = projectKey(req.params.key);
    const backend = be(req);
    const team = await resolveTeam(req, backend, key, teamOf(key, req.params.team));
    return backend.kanban(key, team, settings.getKanbanLayout(key, team.id));
  }),
);

// How the Kanban groups statuses into columns: { mode: 'board', boardId, boardName } | { mode: 'category' } | { mode: 'status' }
app.put(
  '/api/projects/:key/teams/:team/kanban-layout',
  wrap((req) => {
    be(req);
    const key = projectKey(req.params.key);
    const team = teamOf(key, req.params.team);
    if (team.boardId) throw bad("A board's team page always uses that board's columns. Change them on the board in Jira.");
    const saved = settings.setKanbanLayout(key, team.id, req.body || {});
    if (!saved) throw bad('That team page no longer exists.', 404);
    return saved;
  }),
);

app.get(
  '/api/projects/:key/boards',
  wrap(async (req) => (await be(req).listBoards(projectKey(req.params.key))).filter((b) => !b.broken)),
);

app.post(
  '/api/projects/:key/teams/:team/test-filter',
  wrap((req) => {
    const f = normalizeTeam({ filter: req.body?.filter }).filter;
    if (f.mode === 'jql' && !f.jql) throw bad('Write a JQL query first.');
    if (f.mode === 'saved' && !f.filterId) throw bad('Pick a saved filter first.');
    return be(req).testFilter(projectKey(req.params.key), f);
  }),
);

app.get('/api/projects/:key/options', wrap((req) => be(req).worldOptions(projectKey(req.params.key))));

app.get('/api/filters', wrap((req) => be(req).searchFilters(String(req.query.q || '').slice(0, 100))));

app.get(
  '/api/search',
  wrap((req) => {
    const kind = req.query.kind === 'feature' ? 'feature' : 'issue';
    const pk = req.query.project ? projectKey(req.query.project) : null;
    return be(req).searchIssues({
      q: String(req.query.q || '').slice(0, 100),
      kind,
      projectKey: pk,
      onlyProject: req.query.only === '1',
    });
  }),
);

app.get(
  '/api/issues/:key',
  wrap((req) => {
    const t = teamFrom({ worldKey: req.query.world, teamId: req.query.team });
    return be(req).getIssue(issueKey(req.params.key), { workGroup: t?.team.defaults.workGroup || null });
  }),
);

app.post(
  '/api/issues',
  wrap((req) => {
    const { kind, parentKey } = req.body || {};
    const summary = String(req.body?.summary || '').trim();
    const pk = projectKey(req.body?.projectKey);
    const t = teamFrom(req.body);
    if (!KINDS.includes(kind)) throw bad(`Kind must be one of ${KINDS.join(', ')}.`);
    if (!summary) throw bad('Give it a summary.');
    return be(req).createIssue({
      projectKey: pk,
      kind,
      summary,
      parentKey: parentKey ? issueKey(parentKey) : null,
      defaults: t?.team.defaults || null,
      homeProject: t?.pk || pk,
    });
  }),
);

app.post('/api/issues/:key/status', wrap((req) => be(req).setDone(issueKey(req.params.key), Boolean(req.body?.done))));

app.put(
  '/api/issues/:key/parent',
  wrap(async (req) => {
    const key = issueKey(req.params.key);
    const parent = req.body?.parentKey ? issueKey(req.body.parentKey) : null;
    if (parent === key) throw bad('An issue cannot be its own feature.');
    const t = teamFrom(req.body);
    const backend = be(req);
    const result = await backend.setParent(key, parent);
    if (parent && t?.team.defaults.applyOnLink) {
      try {
        Object.assign(result, await backend.applyDefaults(key, t.team.defaults, t.pk));
      } catch (e) {
        result.warning = `Linked, but the team defaults couldn't be added: ${e.message}`;
      }
    }
    return result;
  }),
);

// Kanban drag and drop: optionally change status (or finish), then rank before/after another issue.
app.post(
  '/api/issues/:key/move',
  wrap((req) => {
    const key = issueKey(req.params.key);
    const body = req.body || {};
    const before = body.before ? issueKey(body.before) : null;
    const after = body.after ? issueKey(body.after) : null;
    if (before === key || after === key) throw bad('An issue cannot be ranked next to itself.');
    const statusIds = (Array.isArray(body.statusIds) ? body.statusIds : body.statusId ? [body.statusId] : [])
      .map((x) => String(x).slice(0, 40))
      .slice(0, 50);
    if (!statusIds.length && !body.done && !before && !after) throw bad('Nothing to change.');
    return be(req).moveIssue(key, { statusIds, done: Boolean(body.done), before, after });
  }),
);

/* ---------- Description & comments ---------- */
const MAX_TEXT = 32000;
const readText = (body) => {
  const text = String(body?.text ?? '');
  if (text.length > MAX_TEXT) throw bad(`That's too long (max ${MAX_TEXT} characters).`);
  return text;
};

app.get('/api/issues/:key/description', wrap((req) => be(req).getDescriptionSource(issueKey(req.params.key))));
app.put('/api/issues/:key/description', wrap((req) => be(req).setDescription(issueKey(req.params.key), readText(req.body))));
app.post(
  '/api/issues/:key/comments',
  wrap((req) => {
    const text = readText(req.body).trim();
    if (!text) throw bad('Write something first.');
    return be(req).addComment(issueKey(req.params.key), text);
  }),
);

/* ---------- Attachments ---------- */
app.post(
  '/api/issues/:key/attachments',
  express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }),
  wrap((req) => {
    const filename = decodeURIComponent(String(req.get('x-file-name') || ''))
      .replace(/[\\/\0\r\n]/g, '_')
      .slice(0, 200);
    if (!filename) throw bad('Missing file name.');
    if (!req.body?.length) throw bad('The file is empty.');
    return be(req).uploadAttachment(issueKey(req.params.key), {
      filename,
      mimeType: String(req.get('content-type') || 'application/octet-stream').split(';')[0],
      buffer: req.body,
    });
  }),
);

const INLINE_OK = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

app.get(
  '/api/attachments/:id/:kind(content|thumbnail)',
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d{1,20}$/.test(id)) throw bad('Invalid attachment id.');
    const file = await be(req).attachment(id, { thumbnail: req.params.kind === 'thumbnail' });
    const type = (file.mimeType || 'application/octet-stream').split(';')[0];
    const inline = INLINE_OK.test(type) && req.query.download !== '1';
    res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Attachments are other people's files: never let them run as part of this site.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename || `attachment-${id}`)}`,
    );
    if (file.buffer) return res.end(file.buffer);
    const len = file.res.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const reader = file.res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }),
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.type === 'entity.too.large' ? 413 : err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({
    error: status === 413 ? `That file is too big (max ${MAX_UPLOAD_MB} MB).` : err.message || 'Something went wrong',
    needsLogin: Boolean(err.needsLogin),
  });
});

app.listen(PORT, HOST, () => {
  const where = {
    demo: 'DEMO data. Connect Jira on the Settings page',
    token: `Jira with an API token (${source === 'env' ? 'from .env' : 'from Settings page'})`,
    oauth: 'Jira, everyone signs in with their own Atlassian account',
  }[method];
  console.log(`Bug Rally running on ${PUBLIC_URL}  ·  ${where}`);
  console.log(`Code folder: ${root}`);
});
