import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// App settings saved from the Settings page and the Team pages.
// Stored in data/settings.json (git-ignored). Secrets never leave the server.
//
// {
//   jira: { method, ... } | null          (null = use demo data on purpose; absent = use .env)
//   worlds: {
//     [projectKey]: {
//       teams: [{ id, name, filter, defaults, linked, hidden }]
//     }
//   }
// }
// Team pages only exist in Bug Rally. They decide which part of a Jira project a team sees
// (filter, linked / hidden features) and what gets filled in when that team creates issues.

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

    listTeams(key) {
      return (data.worlds[key]?.teams || []).map((t) => normalizeTeam(t));
    },
    teamCount(key) {
      return data.worlds[key]?.teams?.length || 0;
    },
    // The "whole project" view: no filter, no defaults.
    getTeam(key, id) {
      if (id === ALL_TEAM) return normalizeTeam({ id: ALL_TEAM, name: 'Whole project' });
      const t = data.worlds[key]?.teams?.find((x) => x.id === id);
      return t ? normalizeTeam(t) : null;
    },
    createTeam(key, name) {
      const team = normalizeTeam({ id: crypto.randomBytes(4).toString('hex'), name });
      project(key).teams.push(team);
      save();
      return team;
    },
    updateTeam(key, id, patch) {
      const list = project(key).teams;
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return null;
      list[i] = normalizeTeam({ ...normalizeTeam(list[i]), ...patch, id });
      save();
      return list[i];
    },
    // Kanban column layout. Team pages keep their own; the whole-project view keeps one per project.
    getKanbanLayout(key, id) {
      if (id === ALL_TEAM) return normalizeLayout(data.worlds[key]?.kanban);
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
    deleteTeam(key, id) {
      const p = project(key);
      const before = p.teams.length;
      p.teams = p.teams.filter((x) => x.id !== id);
      save();
      return p.teams.length < before;
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
    name: String(w.name || '').trim().slice(0, 80) || 'Unnamed team',
    linked: uniq(w.linked),
    hidden: uniq(w.hidden),
    filter: {
      mode: ['project', 'jql', 'saved'].includes(f.mode) ? f.mode : 'project',
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
