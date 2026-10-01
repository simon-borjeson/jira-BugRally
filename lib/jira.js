import { buildBoard, classifyType, ISSUE_KEY_RE } from './board.js';

const FIELDS = [
  'summary',
  'status',
  'issuetype',
  'parent',
  'assignee',
  'created',
  'resolutiondate',
  'statuscategorychangedate',
  'priority',
  'duedate',
];

const DETAIL_FIELDS = [
  ...FIELDS,
  'description',
  'priority',
  'reporter',
  'updated',
  'duedate',
  'labels',
  'components',
  'subtasks',
  'issuelinks',
  'comment',
  'attachment',
];

const RASTER = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

// API-token login (Basic auth against the site itself).
export function tokenConnection({ baseUrl, email, token }) {
  const site = new URL(baseUrl).origin;
  const header = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return { apiRoot: site, site, getAuth: async () => header, authKind: 'token', email };
}

function extractError(data) {
  // HTML error pages (proxies, gateways) aren't useful to show; the status code is used instead.
  if (typeof data === 'string') return /<\s*(!doctype|html)/i.test(data) ? null : data.slice(0, 300) || null;
  if (!data || typeof data !== 'object') return null;
  const parts = [...(data.errorMessages || []), ...Object.values(data.errors || {})];
  return parts.length ? parts.join(' ') : data.message || null;
}

// Keep user text safe inside a JQL string literal.
const jqlText = (q) =>
  String(q || '')
    .replace(/["\\+\-&|!(){}[\]^~*?:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

const stripOrderBy = (jql) => String(jql || '').replace(/\border\s+by\b[\s\S]*$/i, '').trim();

// Turn a saved world default into the value Jira expects for that field type.
function fieldValue(wg) {
  const v = wg.value;
  switch (wg.fieldType) {
    case 'option':
      return { value: v };
    case 'array-option':
      return [{ value: v }];
    case 'group':
      return { name: v };
    case 'array-group':
      return [{ name: v }];
    case 'array-string':
      return [v];
    case 'number':
      return Number(v);
    case 'team':
    case 'string':
    default:
      return v;
  }
}

function fieldType(schema = {}) {
  if (schema.type === 'array') return `array-${schema.items || 'string'}`;
  return schema.type || 'string';
}

const SUPPORTED_TYPES = new Set(['option', 'array-option', 'group', 'array-group', 'array-string', 'string', 'number', 'team']);

function display(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(display).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.value || v.name || v.title || v.displayName || v.id || '';
  return String(v);
}

// connection: { apiRoot, site, getAuth: async () => 'Authorization header', authKind: 'token' | 'oauth' }
export function createJiraBackend({ apiRoot, site, getAuth, authKind, email, projectTemplate }) {
  const typeCache = new Map();
  const createFieldCache = new Map();
  const filterCache = new Map();
  const boardHealth = new Map(); // boardId -> { broken, at }

  // Can this board still be used? Boards that were deleted in Jira, lost their filter, or whose filter
  // you can't see are left out. Temporary errors (timeouts, 5xx) never hide a board.
  async function boardProblem(id) {
    const hit = boardHealth.get(id);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.broken;
    let broken = null;
    try {
      const cfg = await jira('GET', `/rest/agile/1.0/board/${id}/configuration`);
      const fid = cfg.filter?.id;
      if (!fid) broken = 'has no filter';
      else {
        try {
          const f = await jira('GET', `/rest/api/3/filter/${fid}`);
          filterCache.set(`board:${id}`, { jql: stripOrderBy(f.jql) || `filter = ${fid}`, at: Date.now() });
        } catch (e) {
          if ([400, 403, 404].includes(e.jiraStatus)) broken = "its filter was deleted or isn't shared with you";
        }
      }
    } catch (e) {
      if (e.jiraStatus === 404) broken = 'was deleted in Jira';
      else if (e.jiraStatus === 403 || e.jiraStatus === 401) broken = "can't be opened with your access";
    }
    boardHealth.set(id, { broken, at: Date.now() });
    return broken;
  }

  // The JQL that decides which issues belong to a world.
  async function scopeJql(projectKey, filter = {}) {
    if (filter.mode === 'jql' && filter.jql) return stripOrderBy(filter.jql);
    // A board's team page: the board's own saved filter.
    if (filter.mode === 'board' && filter.boardId) {
      const hit = filterCache.get(`board:${filter.boardId}`);
      if (hit && Date.now() - hit.at < 60000) return hit.jql;
      let cfg;
      try {
        cfg = await jira('GET', `/rest/agile/1.0/board/${filter.boardId}/configuration`);
      } catch (e) {
        throw Object.assign(new Error(`Couldn't read Jira board ${filter.boardId}: ${e.message}`), { status: e.status || 502 });
      }
      const fid = cfg.filter?.id;
      if (!fid) throw Object.assign(new Error(`Jira board ${filter.boardId} has no filter.`), { status: 400 });
      let jql = `filter = ${fid}`;
      try {
        jql = stripOrderBy((await jira('GET', `/rest/api/3/filter/${fid}`)).jql) || jql;
      } catch {
        // The filter itself isn't shared with you; Jira can still apply it by id.
      }
      filterCache.set(`board:${filter.boardId}`, { jql, at: Date.now() });
      return jql;
    }
    if (filter.mode === 'saved' && filter.filterId) {
      const hit = filterCache.get(filter.filterId);
      if (hit && Date.now() - hit.at < 60000) return hit.jql;
      let f;
      try {
        f = await jira('GET', `/rest/api/3/filter/${filter.filterId}`);
      } catch (e) {
        if (e.jiraStatus === 404 || e.jiraStatus === 400) {
          throw Object.assign(
            new Error(`Saved filter "${filter.filterName || filter.filterId}" wasn't found, or isn't shared with you. Pick another in World settings.`),
            { status: 400 },
          );
        }
        throw e;
      }
      const jql = stripOrderBy(f.jql);
      filterCache.set(filter.filterId, { jql, at: Date.now() });
      return jql;
    }
    return `project = "${projectKey}"`;
  }

  async function createFields(projectKey, typeId) {
    const k = `${projectKey}/${typeId}`;
    if (createFieldCache.has(k)) return createFieldCache.get(k);
    const data = await jira('GET', `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${typeId}?maxResults=200`);
    const map = new Map((data.fields || data.values || []).map((f) => [f.fieldId || f.key, f]));
    createFieldCache.set(k, map);
    return map;
  }

  // Jira can be slow, so calls get plenty of time. Reads are retried once after a network hiccup,
  // and with "Sign in with Atlassian" a 401 first renews the token and retries before asking to sign in again.
  async function request(method, path, { json, form, headers = {}, accept = 'application/json', timeout = 60000 } = {}, attempt = 1) {
    const authorization = await getAuth(attempt > 1 && authKind === 'oauth');
    let res;
    try {
      res = await fetch(apiRoot + path, {
        method,
        headers: {
          Authorization: authorization,
          Accept: accept,
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : form,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      if (method === 'GET' && attempt < 2) return request(method, path, { json, form, headers, accept, timeout }, attempt + 1);
      const why = e.name === 'TimeoutError' ? `it did not answer within ${timeout / 1000} seconds` : e.cause?.code || e.message;
      throw Object.assign(new Error(`Couldn't reach ${site} (${why}). Jira may be slow right now; try again.`), { status: 504 });
    }
    if (res.status === 401 && authKind === 'oauth' && attempt < 2) {
      await res.body?.cancel().catch(() => {});
      return request(method, path, { json, form, headers, accept, timeout }, attempt + 1);
    }
    if ((res.status === 502 || res.status === 503 || res.status === 504) && method === 'GET' && attempt < 2) {
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      return request(method, path, { json, form, headers, accept, timeout }, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let data = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      let err;
      if (res.status === 401 && authKind === 'oauth') {
        // Still 401 with a fresh token. If the sign-in itself works, this is a missing permission for this
        // part of Jira (for example Jira Software boards), not a reason to sign anyone out.
        const probe = await fetch(`${apiRoot}/rest/api/3/myself`, {
          headers: { Authorization: authorization, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        }).catch(() => null);
        if (probe?.ok) {
          err = Object.assign(
            new Error(
              path.startsWith('/rest/agile/')
                ? "Your Atlassian sign-in isn't allowed to use Jira Software boards and ranking yet. Add the Jira Software scopes to the Bug Rally app (see Settings), then sign out and sign in again."
                : `Jira refused this for your sign-in (${extractError(data) || 'missing permission'}).`,
            ),
            { status: 403, missingScope: path.startsWith('/rest/agile/') },
          );
        } else {
          err = Object.assign(new Error('Your Atlassian sign-in has expired. Please sign in again.'), { status: 401, needsLogin: true });
        }
      } else if (res.status === 401) {
        err = Object.assign(new Error('Jira rejected the login. Check the email and API token on the Settings page.'), { status: 502 });
      } else {
        err = Object.assign(new Error(`Jira says: ${extractError(data) || `${res.status} ${res.statusText}`}`), { status: res.status });
      }
      err.jiraStatus = res.status;
      throw err;
    }
    return res;
  }

  async function jira(method, path, body) {
    const res = await request(method, path, { json: body });
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  const mapAttachment = (a) => ({
    id: String(a.id),
    filename: a.filename,
    mimeType: a.mimeType || 'application/octet-stream',
    size: a.size || 0,
    created: a.created || null,
    author: a.author?.displayName || null,
    isImage: RASTER.test(a.mimeType || ''),
  });

  function normalize(issue) {
    const f = issue.fields || {};
    const it = f.issuetype || {};
    return {
      key: issue.key,
      summary: f.summary || '(no summary)',
      type: classifyType(it.name, it.hierarchyLevel, it.subtask),
      typeName: it.name || 'Issue',
      statusName: f.status?.name || '',
      statusId: f.status?.id ? String(f.status.id) : null,
      statusCategory: f.status?.statusCategory?.key || 'new',
      done: f.status?.statusCategory?.key === 'done',
      priority: f.priority?.name || null,
      duedate: f.duedate || null,
      parentSummary: f.parent?.fields?.summary || null,
      assignee: f.assignee?.displayName || null,
      created: f.created || '',
      doneAt: f.resolutiondate || f.statuscategorychangedate || null,
      parentKey: f.parent?.key || null,
      projectKey: issue.key.split('-')[0],
      url: `${site}/browse/${issue.key}`,
    };
  }

  // Uses the enhanced search endpoint (the old /rest/api/3/search is retired).
  async function search(jql, { limit = 2000 } = {}) {
    const out = [];
    let nextPageToken;
    do {
      const data = await jira('POST', '/rest/api/3/search/jql', {
        jql,
        fields: FIELDS,
        maxResults: Math.min(100, limit - out.length),
        nextPageToken,
      });
      out.push(...(data.issues || []));
      nextPageToken = data.isLast ? undefined : data.nextPageToken;
    } while (nextPageToken && out.length < limit);
    return out.map(normalize);
  }

  async function getBasic(key) {
    try {
      return normalize(await jira('GET', `/rest/api/3/issue/${key}?fields=${FIELDS.join(',')}`));
    } catch (e) {
      if (e.jiraStatus === 404) return null;
      throw e;
    }
  }

  async function issueTypes(projectKey) {
    if (typeCache.has(projectKey)) return typeCache.get(projectKey);
    const data = await jira('GET', `/rest/api/3/issue/createmeta/${projectKey}/issuetypes?maxResults=100`);
    const types = (data.issueTypes || data.values || []).filter((t) => !t.subtask);
    typeCache.set(projectKey, types);
    return types;
  }

  // For bugs a team can pick the exact issue type (e.g. "Fault Report"); otherwise Fault Report wins over Bug.
  async function findType(projectKey, kind, preferred = '') {
    const types = await issueTypes(projectKey);
    const by = (re) => types.find((t) => re.test(t.name));
    let t;
    if (kind === 'bug' && preferred) t = types.find((x) => x.name.toLowerCase() === preferred.toLowerCase());
    if (t) return t;
    if (kind === 'epic') t = types.find((x) => x.hierarchyLevel === 1) || by(/epic/i);
    else if (kind === 'bug') t = by(/fault/i) || by(/^bug$/i) || by(/bug|defect/i);
    else if (kind === 'story') t = by(/^story$/i) || by(/story/i);
    else t = by(/^task$/i);
    if (!t && kind !== 'epic' && kind !== 'bug') {
      t = types.find((x) => (x.hierarchyLevel ?? 0) === 0);
    }
    if (!t) throw Object.assign(new Error(`Project ${projectKey} has no "${kind}" issue type.`), { status: 400 });
    return t;
  }

  return {
    mode: 'jira',

    async status() {
      const me = await jira('GET', '/rest/api/3/myself');
      return { mode: 'jira', site, user: me.displayName, email: me.emailAddress || email, auth: authKind };
    },

    async listProjects() {
      const out = [];
      let startAt = 0;
      for (;;) {
        const data = await jira('GET', `/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=name`);
        out.push(...(data.values || []));
        if (data.isLast || !data.values?.length || out.length >= 500) break;
        startAt += data.values.length;
      }
      return out.map((p) => ({ key: p.key, name: p.name, url: `${site}/browse/${p.key}` }));
    },

    async projectInfo(key) {
      const p = await jira('GET', `/rest/api/3/project/${key}`);
      return { key: p.key, name: p.name, url: `${site}/browse/${p.key}` };
    },

    async createProject({ key, name }) {
      const me = await jira('GET', '/rest/api/3/myself');
      await jira('POST', '/rest/api/3/project', {
        key,
        name,
        projectTypeKey: 'software',
        projectTemplateKey: projectTemplate,
        leadAccountId: me.accountId,
        assigneeType: 'UNASSIGNED',
      });
      return { key, name, url: `${site}/browse/${key}` };
    },

    async board(projectKey, { linked = [], hidden = [], filter = {} } = {}) {
      const project = await jira('GET', `/rest/api/3/project/${projectKey}`);
      const scope = await scopeJql(projectKey, filter);
      const custom = filter.mode === 'jql' || filter.mode === 'saved' || filter.mode === 'board';
      let native = [];
      try {
        // Stages follow Jira's Rank (top = highest), like a backlog.
        native = await search(`(${scope}) AND issuetype = Epic ORDER BY Rank ASC`, { limit: 200 });
      } catch (e) {
        // A project without an Epic issue type has no features yet. A broken custom filter is a real error.
        if (e.jiraStatus !== 400 || custom) {
          if (custom) e.message = `The team's filter doesn't work: ${e.message}`;
          throw e;
        }
      }

      const nativeKeys = new Set(native.map((e) => e.key));
      const hiddenSet = new Set(hidden);
      const linkedEpics = (
        await Promise.all(linked.filter((k) => !nativeKeys.has(k)).map((k) => getBasic(k)))
      )
        .filter(Boolean)
        .map((e) => ({ ...e, linked: true }));

      let epics = [...native.filter((e) => !hiddenSet.has(e.key)), ...linkedEpics];
      // Linked epics come from elsewhere: put them where their Rank says, among the team's own.
      if (linkedEpics.length) {
        try {
          const ranked = [];
          const all = epics.map((e) => e.key);
          for (let i = 0; i < all.length; i += 100) {
            ranked.push(...(await search(`key in (${all.slice(i, i + 100).join(',')}) ORDER BY Rank ASC`, { limit: 100 })));
          }
          if (all.length <= 100) {
            const pos = new Map(ranked.map((e, i) => [e.key, i]));
            epics = [...epics].sort((a, b) => (pos.get(a.key) ?? 1e9) - (pos.get(b.key) ?? 1e9));
          }
        } catch {
          // Keep the team's own epics in rank order with the linked ones after them.
        }
      }
      const children = [];
      const fetchChildren = async (keys, itemScope) => {
        for (let i = 0; i < keys.length; i += 50) {
          children.push(...(await search(`parent in (${keys.slice(i, i + 50).join(',')})${itemScope} ORDER BY Rank ASC`)));
        }
      };
      // The team filter can apply inside the team's own features. A linked feature always shows all of its
      // issues, so its progress is right even when they don't match the filter.
      await fetchChildren(
        epics.filter((e) => !e.linked).map((e) => e.key),
        custom && filter.applyToItems ? ` AND (${scope})` : '',
      );
      await fetchChildren(epics.filter((e) => e.linked).map((e) => e.key), '');

      let unsorted = [];
      try {
        unsorted = await search(
          `(${scope}) AND parent is EMPTY AND issuetype in standardIssueTypes() AND issuetype != Epic ` +
            `AND (statusCategory != Done OR statusCategoryChangedDate >= -14d) ORDER BY Rank ASC`,
          { limit: 300 },
        );
      } catch {
        // Unsorted issues are a bonus; don't fail the whole board over them.
      }

      const board = buildBoard(
        { key: project.key, name: project.name, url: `${site}/browse/${project.key}` },
        epics,
        children,
        unsorted,
      );
      board.hiddenFeatures = native.filter((e) => hiddenSet.has(e.key));
      return board;
    },

    async getIssue(key, { workGroup } = {}) {
      const fields = workGroup ? [...DETAIL_FIELDS, workGroup.fieldId] : DETAIL_FIELDS;
      const data = await jira('GET', `/rest/api/3/issue/${key}?expand=renderedFields&fields=${fields.join(',')}`);
      const f = data.fields || {};
      const r = data.renderedFields || {};
      const comments = f.comment?.comments || [];
      const renderedComments = r.comment?.comments || [];
      // Child items: a feature's tasks, stories and bugs, or a ticket's sub-tasks.
      let children = [];
      let childrenError = null;
      try {
        children = await search(`parent = ${key} ORDER BY Rank ASC`, { limit: 200 });
      } catch (e) {
        try {
          children = await search(`parent = ${key}`, { limit: 200 });
        } catch (e2) {
          childrenError = e2.message || e.message;
        }
      }
      // Company-managed projects that still use the old Epic Link field.
      if (!children.length && normalize(data).type === 'epic') {
        try {
          children = await search(`"Epic Link" = ${key} ORDER BY Rank ASC`, { limit: 200 });
        } catch {
          /* no Epic Link field on this site */
        }
      }
      if (!children.length && f.subtasks?.length) children = f.subtasks.map(normalize);
      // Related tickets (issue links), e.g. "blocks", "is blocked by", "relates to".
      const links = (f.issuelinks || [])
        .map((l) => {
          const other = l.outwardIssue || l.inwardIssue;
          if (!other) return null;
          return { relation: (l.outwardIssue ? l.type?.outward : l.type?.inward) || l.type?.name || 'relates to', issue: normalize(other) };
        })
        .filter(Boolean);
      return {
        ...normalize(data),
        priority: f.priority?.name || null,
        reporter: f.reporter?.displayName || null,
        updated: f.updated || null,
        duedate: f.duedate || null,
        labels: f.labels || [],
        components: (f.components || []).map((c) => c.name),
        parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
        descriptionHtml: r.description || '',
        children,
        childrenError,
        links,
        comments: comments.slice(-20).map((c, i) => ({
          author: c.author?.displayName || 'Someone',
          created: c.created,
          bodyHtml: renderedComments[comments.length - Math.min(20, comments.length) + i]?.body || '',
        })),
        commentsTotal: f.comment?.total ?? comments.length,
        workGroup: workGroup ? { name: workGroup.fieldName, value: display(f[workGroup.fieldId]) } : null,
        attachments: (f.attachment || []).map(mapAttachment),
      };
    },

    // Streams an attachment (or its thumbnail) through this server, since the browser has no Jira login.
    async attachment(id, { thumbnail = false } = {}) {
      if (thumbnail) {
        const res = await request('GET', `/rest/api/3/attachment/thumbnail/${id}?redirect=false&fallbackToDefault=true&width=320&height=320`, {
          accept: '*/*',
          timeout: 60000,
        });
        return { res, filename: `thumbnail-${id}`, mimeType: res.headers.get('content-type') || 'image/png' };
      }
      const meta = await jira('GET', `/rest/api/3/attachment/${id}`);
      const res = await request('GET', `/rest/api/3/attachment/content/${id}?redirect=false`, { accept: '*/*', timeout: 120000 });
      return { res, filename: meta.filename, mimeType: meta.mimeType || res.headers.get('content-type') };
    },

    async uploadAttachment(key, { filename, mimeType, buffer }) {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);
      const res = await request('POST', `/rest/api/3/issue/${key}/attachments`, {
        form,
        headers: { 'X-Atlassian-Token': 'no-check' },
        timeout: 300000,
      });
      const list = await res.json();
      return (Array.isArray(list) ? list : []).map(mapAttachment);
    },

    // Descriptions and comments are edited as Jira wiki markup through REST v2,
    // which Jira converts losslessly enough (tables, images, panels) in both directions.
    async getDescriptionSource(key) {
      const data = await jira('GET', `/rest/api/2/issue/${key}?fields=description`);
      return { text: data.fields?.description || '' };
    },

    async setDescription(key, text) {
      await jira('PUT', `/rest/api/2/issue/${key}`, { fields: { description: text } });
      return { key };
    },

    async addComment(key, text) {
      const c = await jira('POST', `/rest/api/2/issue/${key}/comment`, { body: text });
      return { id: c?.id || null };
    },

    // Everything the World settings page needs to offer as defaults.
    async worldOptions(projectKey) {
      const [components, types] = await Promise.all([
        jira('GET', `/rest/api/3/project/${projectKey}/components`).catch(() => []),
        issueTypes(projectKey).catch(() => []),
      ]);
      const base = types.find((t) => /^task$/i.test(t.name)) || types.find((t) => (t.hierarchyLevel ?? 0) === 0) || types[0];
      let fields = [];
      if (base) {
        const meta = await createFields(projectKey, base.id).catch(() => new Map());
        fields = [...meta.entries()]
          .filter(([id]) => id.startsWith('customfield_'))
          .map(([id, f]) => ({
            id,
            name: f.name,
            type: fieldType(f.schema),
            allowedValues: (f.allowedValues || []).map((v) => v.value || v.name).filter(Boolean),
          }))
          .filter((f) => SUPPORTED_TYPES.has(f.type))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      return {
        filtersAvailable: true,
        issueTypes: types.filter((x) => (x.hierarchyLevel ?? 0) === 0).map((x) => x.name),
        components: (components || []).map((c) => c.name),
        fields,
        fieldsFrom: base?.name || null,
      };
    },

    async searchFilters(q) {
      const params = new URLSearchParams({ expand: 'jql,owner', maxResults: '20', orderBy: 'name' });
      if (q) params.set('filterName', q);
      const data = await jira('GET', `/rest/api/3/filter/search?${params}`);
      return (data.values || []).map((f) => ({
        id: String(f.id),
        name: f.name,
        jql: f.jql || '',
        owner: f.owner?.displayName || '',
      }));
    },

    async testFilter(projectKey, filter) {
      const scope = await scopeJql(projectKey, filter);
      const count = async (jql) => {
        try {
          return (await jira('POST', '/rest/api/3/search/approximate-count', { jql })).count;
        } catch (e) {
          if (e.jiraStatus !== 404) throw e;
          const n = (await search(jql, { limit: 100 })).length;
          return n >= 100 ? '100+' : n;
        }
      };
      const [issues, features] = await Promise.all([count(scope), count(`(${scope}) AND issuetype = Epic`)]);
      return { jql: scope, issues, features };
    },

    // Add a world's labels/components/work group to an existing issue.
    async applyDefaults(key, defaults, homeProject) {
      const applied = [];
      const skipped = [];
      const body = { update: {}, fields: {} };
      if (defaults.labels.length) {
        body.update.labels = defaults.labels.map((l) => ({ add: l }));
        applied.push('labels');
      }
      if (defaults.components.length) {
        if (key.split('-')[0] === homeProject) {
          body.update.components = defaults.components.map((name) => ({ add: { name } }));
          applied.push('components');
        } else skipped.push('components (other project)');
      }
      if (defaults.workGroup) {
        body.fields[defaults.workGroup.fieldId] = fieldValue(defaults.workGroup);
        applied.push(defaults.workGroup.fieldName);
      }
      if (!applied.length) return { applied, skipped };
      await jira('PUT', `/rest/api/3/issue/${key}`, body);
      return { applied, skipped };
    },

    async searchIssues({ q, kind, projectKey, onlyProject }) {
      const text = jqlText(q);
      const upper = String(q || '').trim().toUpperCase();
      const typeOk = (i) => (kind === 'feature' ? i.type === 'epic' : i.type !== 'epic' && i.type !== 'subtask');
      if (ISSUE_KEY_RE.test(upper)) {
        const one = await getBasic(upper);
        return one && typeOk(one) ? [one] : [];
      }
      const parts = [
        kind === 'feature' ? 'issuetype = Epic' : 'issuetype in standardIssueTypes() AND issuetype != Epic',
      ];
      if (onlyProject && projectKey) parts.push(`project = "${projectKey}"`);
      if (text) parts.push(`summary ~ "${text}*"`);
      return (await search(`${parts.join(' AND ')} ORDER BY updated DESC`, { limit: 25 })).filter(typeOk);
    },

    async setParent(key, parentKey) {
      if (parentKey) {
        await jira('PUT', `/rest/api/3/issue/${key}`, { fields: { parent: { key: parentKey } } });
      } else {
        try {
          await jira('PUT', `/rest/api/3/issue/${key}`, { fields: { parent: null } });
        } catch (e) {
          if (e.jiraStatus !== 400) throw e;
          await jira('PUT', `/rest/api/3/issue/${key}`, { update: { parent: [{ set: { none: true } }] } });
        }
      }
      return { key, parentKey: parentKey || null };
    },

    async bugTypeName(projectKey, preferred) {
      try {
        return (await findType(projectKey, 'bug', preferred)).name;
      } catch {
        return 'Bug';
      }
    },

    async createIssue({ projectKey, kind, summary, parentKey, defaults, homeProject }) {
      const type = await findType(projectKey, kind, defaults?.bugType);
      const fields = { project: { key: projectKey }, summary, issuetype: { id: type.id } };
      if (parentKey && kind !== 'epic') fields.parent = { key: parentKey };
      const applied = [];
      const skipped = [];
      if (defaults) {
        // Only send fields that are on this issue type's create screen, so creation never fails because of a default.
        const meta = await createFields(projectKey, type.id).catch(() => null);
        const has = (id) => !meta || meta.has(id);
        if (defaults.labels.length) {
          if (has('labels')) {
            fields.labels = defaults.labels;
            applied.push('labels');
          } else skipped.push('labels');
        }
        if (defaults.components.length) {
          if (projectKey === homeProject && has('components')) {
            fields.components = defaults.components.map((name) => ({ name }));
            applied.push('components');
          } else skipped.push('components');
        }
        if (defaults.workGroup) {
          if (has(defaults.workGroup.fieldId)) {
            fields[defaults.workGroup.fieldId] = fieldValue(defaults.workGroup);
            applied.push(defaults.workGroup.fieldName);
          } else skipped.push(defaults.workGroup.fieldName);
        }
      }
      const created = await jira('POST', '/rest/api/3/issue', { fields });
      return { key: created.key, applied, skipped };
    },

    // Boards in a project, for "columns like this Jira board".
    // The project's boards. Each one is checked (a few at a time); broken: why it can't be used, or null.
    async listBoards(projectKey) {
      const all = [];
      let startAt = 0;
      for (;;) {
        const data = await jira('GET', `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&startAt=${startAt}&maxResults=50`);
        const values = data.values || [];
        all.push(...values);
        startAt += values.length;
        if (data.isLast || !values.length || all.length >= 300) break;
      }
      // Where the board lives. Jira also lists boards of other projects and personal boards whose filter
      // happens to include this project; the project's own board list in Jira doesn't show those.
      const here = String(projectKey).toUpperCase();
      const elsewhereOf = (loc) => {
        if (loc?.projectKey) return String(loc.projectKey).toUpperCase() === here ? null : `belongs to project ${loc.projectKey}`;
        if (loc?.userAccountId || loc?.userId) return `is a personal board${loc.displayName || loc.name ? ` of ${loc.displayName || loc.name}` : ''}`;
        return "isn't placed in any project";
      };
      const boards = all.map((x) => ({ id: String(x.id), name: x.name, type: x.type, broken: null, elsewhere: elsewhereOf(x.location) }));
      let next = 0;
      const worker = async () => {
        while (next < boards.length) {
          const b = boards[next++];
          b.broken = await boardProblem(b.id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, boards.length) }, worker));
      return boards;
    },

    // Kanban: every unfinished task/story/bug in the team's scope, in Jira Rank order, grouped into columns
    // by the chosen layout (a Jira board's columns, your own columns, status category, or one per status).
    // Columns that hold Done statuses show what was finished in the last 14 days.
    async kanban(projectKey, { filter = {}, linked = [], hidden = [] } = {}, layout = { mode: 'category' }) {
      // Every status we know about (name + category), and the project's workflow order.
      const known = new Map();
      const workflowOrder = [];
      const remember = (id, name, category) => {
        id = String(id);
        if (!known.has(id)) known.set(id, { id, name, category: category || 'indeterminate' });
      };
      try {
        const perType = await jira('GET', `/rest/api/3/project/${projectKey}/statuses`);
        for (const t of perType || []) {
          if (t.subtask) continue;
          for (const st of t.statuses || []) {
            if (!known.has(String(st.id))) workflowOrder.push(String(st.id));
            remember(st.id, st.name, st.statusCategory?.key);
          }
        }
      } catch {
        /* filled in from the issues below */
      }
      const lookupAll = async () => {
        const all = await jira('GET', '/rest/api/3/status').catch(() => []);
        for (const st of all || []) remember(st.id, st.name, st.statusCategory?.key);
      };
      const statusOf = (id) => known.get(String(id)) || { id: String(id), name: `Status ${id}`, category: 'indeterminate' };

      let columns;
      let layoutError = null;
      if (layout.mode === 'custom') {
        if (layout.columns.some((c) => c.statusIds.some((id) => !known.has(id)))) await lookupAll();
        columns = layout.columns.map((c, i) => ({ id: `cu${i}`, name: c.name, statuses: c.statusIds.map(statusOf) }));
      }
      if (layout.mode === 'board') {
        try {
          const cfg = await jira('GET', `/rest/agile/1.0/board/${layout.boardId}/configuration`);
          const cols = cfg.columnConfig?.columns || [];
          if (cols.some((c) => (c.statuses || []).some((st) => !known.has(String(st.id))))) await lookupAll();
          columns = cols.map((c, i) => ({ id: `col${i}`, name: c.name, statuses: (c.statuses || []).map((st) => statusOf(st.id)) }));
        } catch (e) {
          layoutError = `Couldn't read the board's columns: ${e.message} Showing To Do / In Progress instead.`;
        }
      }
      const byCategory = !columns;

      // Which Done statuses have their own column (then recently finished issues are shown there).
      const doneIds = byCategory ? [] : [...new Set(columns.flatMap((c) => c.statuses.filter((st) => st.category === 'done').map((st) => st.id)))];

      // Only what matches the team's filter. Issues in linked features that don't match stay off the board
      // (their progress still shows in the features rail).
      let where = `(${await scopeJql(projectKey, filter)})`;
      if (hidden.length) where += ` AND (parent is EMPTY OR parent not in (${hidden.join(',')}))`;
      const open = doneIds.length
        ? `(statusCategory != Done OR (status in (${doneIds.join(',')}) AND statusCategoryChangedDate >= -14d))`
        : 'statusCategory != Done';
      const issues = (
        await search(`${where} AND ${open} AND issuetype in standardIssueTypes() AND issuetype != Epic ORDER BY Rank ASC`, { limit: 500 })
      ).filter((i) => i.type !== 'epic' && i.type !== 'subtask');
      for (const i of issues) if (i.statusId) remember(i.statusId, i.statusName, i.statusCategory);

      // Workflow order first, then any other status the issues are in (e.g. from another project).
      const ordered = [...workflowOrder.map((id) => known.get(id)), ...[...known.values()].filter((st) => !workflowOrder.includes(st.id))];

      if (byCategory) {
        const cats = { new: 0, indeterminate: 1 };
        const sorted = ordered.filter((st) => st.category !== 'done').sort((a, b) => (cats[a.category] ?? 1) - (cats[b.category] ?? 1));
        columns =
          layout.mode === 'status'
            ? sorted.map((st) => ({ id: `st${st.id}`, name: st.name, statuses: [st] }))
            : [
                { id: 'cat-new', name: 'To Do', statuses: sorted.filter((st) => st.category === 'new') },
                { id: 'cat-progress', name: 'In Progress', statuses: sorted.filter((st) => st.category !== 'new') },
              ];
        columns = columns.filter((c) => c.statuses.length);
      } else if (layout.mode === 'board') {
        columns = columns.filter((c) => c.statuses.length);
      }

      const mapped = new Set(columns.flatMap((c) => c.statuses.map((st) => st.id)));
      const stray = [...new Map(issues.filter((i) => !mapped.has(i.statusId)).map((i) => [i.statusId, known.get(i.statusId)])).values()].filter(Boolean);
      if (stray.length) columns.push({ id: 'other', name: layout.mode === 'board' ? 'Not on the board' : 'Other statuses', statuses: stray });

      const categoryOf = (c) =>
        c.statuses.length && c.statuses.every((st) => st.category === 'done') ? 'done' : c.statuses.every((st) => st.category === 'new') ? 'new' : 'indeterminate';
      return {
        columns: columns.map((c) => ({
          id: c.id,
          name: c.name,
          category: categoryOf(c),
          statuses: c.statuses.map((st) => ({ id: st.id, name: st.name, category: st.category })),
        })),
        issues,
        layout,
        layoutError,
        doneWindowDays: doneIds.length ? 14 : 0,
        allStatuses: ordered.map((st) => ({ id: st.id, name: st.name, category: st.category })),
      };
    },

    // Drag and drop on the Kanban board: optional status change, then rank before/after another issue.
    // statusIds: the statuses of the target column, in column order. The first one the workflow allows wins.
    async moveIssue(key, { statusIds = [], done, before, after }) {
      const result = { key };
      if (done || statusIds.length) {
        const { transitions = [] } = await jira('GET', `/rest/api/3/issue/${key}/transitions`);
        const pick = done
          ? transitions.find((t) => t.to?.statusCategory?.key === 'done')
          : statusIds.map((id) => transitions.find((t) => String(t.to?.id) === String(id))).find(Boolean);
        if (!pick) {
          throw Object.assign(
            new Error(`Jira's workflow doesn't allow moving ${key} ${done ? 'to Done' : 'to that column'} from its current status.`),
            { status: 409 },
          );
        }
        await jira('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: pick.id } });
        result.status = pick.to?.name;
      }
      if (before || after) {
        const res = await request('PUT', '/rest/agile/1.0/issue/rank', {
          json: { issues: [key], ...(before ? { rankBeforeIssue: before } : { rankAfterIssue: after }) },
        });
        if (res.status === 207) {
          const data = await res.json().catch(() => ({}));
          const failed = (data.entries || []).find((e) => e.status >= 400);
          if (failed) {
            throw Object.assign(new Error(`Jira couldn't change the rank: ${(failed.errors || []).join(' ') || failed.status}`), { status: 409 });
          }
        }
        result.ranked = true;
      }
      return result;
    },

    async setDone(key, done) {
      const { transitions = [] } = await jira('GET', `/rest/api/3/issue/${key}/transitions`);
      const cat = (t) => t.to?.statusCategory?.key;
      const pick = done
        ? transitions.find((t) => cat(t) === 'done')
        : transitions.find((t) => cat(t) === 'new') || transitions.find((t) => cat(t) === 'indeterminate');
      if (!pick) {
        const err = new Error(
          `${key} has no workflow transition ${done ? 'to a Done status' : 'back to an open status'} from where it is now.`,
        );
        err.status = 409;
        throw err;
      }
      await jira('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: pick.id } });
      return { key, done, status: pick.to?.name };
    },
  };
}
