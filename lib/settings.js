import fs from 'node:fs';
import path from 'node:path';

// App settings saved from the Settings page and the Team pages.
// Stored in data/settings.json (git-ignored). Secrets never leave the server.
//
// {
//   jira: { method, ... } | null          (null = use demo data on purpose; absent = use .env)
//   worlds: {
//     [projectKey]: {
//       teams: [{ id: 'b<boardId>', name, filter: { applyToItems }, defaults, linked, hidden }]
//     }
//   }
// }
// Every Jira board of a project is a team page. The board decides what the team sees (its filter) and
// the Kanban columns. Bug Rally keeps the rest per board: linked / hidden features and what gets filled in
// when that team creates issues. Hand-made team pages from earlier versions are no longer shown.
const BOARD_TEAM_RE = /^b(\d{1,20})$/;
export const boardTeamId = (boardId) => `b${boardId}`;

export const ALL_TEAM = '_all';

export function createSettings(file) {
  let data = {};
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`Could not read ${file}: ${e.message}`);
  }
  data.worlds ||= {};

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };

  // Earlier versions kept one filter/defaults set per project. Turn that into a team page.
  let migrated = false;
  for (const [key, w] of Object.entries(data.worlds)) {
    if (Array.isArray(w.teams)) continue;
    const old = normalizeTeam({ ...w, id: 'main', name: w.name || 'Team 1' });
    const hasContent =
      old.filter.mode !== 'project' ||
      old.linked.length ||
      old.hidden.length ||
      old.defaults.labels.length ||
      old.defaults.components.length ||
      old.defaults.workGroup;
    data.worlds[key] = { teams: hasContent ? [old] : [] };
    migrated = true;
  }
  if (migrated) save();

  const project = (key) => (data.worlds[key] ||= { teams: [] });
  const stored = (key, id) => data.worlds[key]?.teams?.find((x) => x.id === id);
  // A board's team page: its saved settings, with the filter and columns taken from the board.
  const boardTeam = (t, boardId, extra = {}) =>
    normalizeTeam({
      ...t,
      ...extra,
      id: boardTeamId(boardId),
      boardId,
      name: extra.name || t?.name || `Board ${boardId}`,
      filter: { applyToItems: t?.filter?.applyToItems, mode: 'board', boardId },
    });

  return {
    hasJiraEntry: () => 'jira' in data,
    getJira: () => data.jira ?? null,
    setJira(jira) {
      data.jira = jira;
      save();
    },
    clearJiraEntry() {
      delete data.jira;
      save();
    },

    // One team page per Jira board: [{ id, name, type }]. Remembers board names for direct links.
    boardTeams(key, boards) {
      let dirty = false;
      const teams = boards.map((b) => {
        let t = stored(key, boardTeamId(b.id));
        if (!t) {
          t = { id: boardTeamId(b.id) };
          project(key).teams.push(t);
        }
        if (t.name !== b.name) {
          t.name = b.name;
          dirty = true;
        }
        return boardTeam(t, b.id, { name: b.name, boardType: b.type });
      });
      if (dirty) save();
      return teams;
    },
    // The "whole project" view: no filter, no defaults. Anything else is a board's team page.
    getTeam(key, id) {
      if (id === ALL_TEAM) return normalizeTeam({ id: ALL_TEAM, name: 'Whole project' });
      const m = BOARD_TEAM_RE.exec(id);
      return m ? boardTeam(stored(key, id), m[1]) : null;
    },
    updateTeam(key, id, patch) {
      const m = BOARD_TEAM_RE.exec(id);
      if (!m) return null;
      const list = project(key).teams;
      let i = list.findIndex((x) => x.id === id);
      if (i < 0) i = list.push({ id }) - 1;
      const name = list[i].name;
      list[i] = normalizeTeam({ ...normalizeTeam(list[i]), ...patch, id });
      if (name) list[i].name = name;
      else delete list[i].name;
      save();
      return boardTeam(list[i], m[1]);
    },
    // Kanban column layout. Team pages keep their own; the whole-project view keeps one per project.
    getKanbanLayout(key, id) {
      if (id === ALL_TEAM) return normalizeLayout(data.worlds[key]?.kanban);
      const m = BOARD_TEAM_RE.exec(id);
      if (m) return { mode: 'board', boardId: m[1], boardName: stored(key, id)?.name || '' }; // always the board's columns
      const t = data.worlds[key]?.teams?.find((x) => x.id === id);
      return normalizeLayout(t?.kanban);
    },
    setKanbanLayout(key, id, layout) {
      const clean = normalizeLayout(layout);
      if (id === ALL_TEAM) project(key).kanban = clean;
      else {
        const t = project(key).teams.find((x) => x.id === id);
        if (!t) return null;
        t.kanban = clean;
      }
      save();
      return clean;
    },
  };
}

// mode: 'board' = columns of a Jira board, 'category' = To Do / In Progress, 'status' = one column per status,
//       'custom' = columns defined in Bug Rally: [{ name, statusIds }].
export function normalizeLayout(l = {}) {
  const mode = ['board', 'category', 'status', 'custom'].includes(l?.mode) ? l.mode : 'category';
  if (mode === 'board') {
    const boardId = String(l?.boardId || '').replace(/\D/g, '').slice(0, 20);
    if (!boardId) return { mode: 'category' };
    return { mode, boardId, boardName: String(l.boardName || '').slice(0, 120) };
  }
  if (mode === 'custom') {
    const seen = new Set();
    const columns = (Array.isArray(l.columns) ? l.columns : [])
      .slice(0, 12)
      .map((c) => ({
        name: String(c?.name || '').trim().slice(0, 40),
        statusIds: (Array.isArray(c?.statusIds) ? c.statusIds : [])
          .map((x) => String(x).slice(0, 40))
          .filter((x) => x && !seen.has(x) && seen.add(x))
          .slice(0, 100),
      }))
      .filter((c) => c.name);
    return columns.length ? { mode, columns } : { mode: 'category' };
  }
  return { mode };
}

const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];

export function normalizeTeam(w = {}) {
  const f = w.filter || {};
  const d = w.defaults || {};
  const wg = d.workGroup;
  return {
    ...(w.kanban ? { kanban: normalizeLayout(w.kanban) } : {}),
    id: String(w.id || '').replace(/[^\w-]/g, '').slice(0, 40),
    name: String(w.name || '').trim().slice(0, 120) || 'Unnamed team',
    ...(w.boardId ? { boardId: String(w.boardId).replace(/\D/g, '').slice(0, 20) } : {}),
    ...(w.boardType ? { boardType: String(w.boardType).slice(0, 20) } : {}),
    linked: uniq(w.linked),
    hidden: uniq(w.hidden),
    filter: {
      mode: ['project', 'jql', 'saved', 'board'].includes(f.mode) ? f.mode : 'project',
      boardId: String(f.boardId || '').replace(/\D/g, '').slice(0, 20),
      jql: String(f.jql || '').trim().slice(0, 2000),
      filterId: String(f.filterId || '').replace(/\D/g, ''),
      filterName: String(f.filterName || '').slice(0, 200),
      applyToItems: f.applyToItems !== false,
    },
    defaults: {
      labels: uniq(d.labels).slice(0, 20),
      components: uniq(d.components).slice(0, 20),
      workGroup:
        wg && wg.fieldId && String(wg.value ?? '').trim()
          ? {
              fieldId: String(wg.fieldId).slice(0, 60),
              fieldName: String(wg.fieldName || wg.fieldId).slice(0, 120),
              fieldType: String(wg.fieldType || 'string').slice(0, 30),
              value: String(wg.value).trim().slice(0, 200),
              valueLabel: String(wg.valueLabel || wg.value).slice(0, 200),
            }
          : null,
      applyOnLink: Boolean(d.applyOnLink),
      // Issue type used by "+ Bug" (e.g. "Fault Report"). Empty = automatic.
      bugType: String(d.bugType || '').trim().slice(0, 60),
    },
  };
}
