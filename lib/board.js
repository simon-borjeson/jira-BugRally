// Shared helpers that turn a flat list of issues into "levels".

export function classifyType(name = '', hierarchyLevel, isSubtask) {
  if (isSubtask || hierarchyLevel === -1) return 'subtask';
  if (hierarchyLevel === 1 || /epic/i.test(name)) return 'epic';
  // Bugs, defects and fault reports are all hazards on the track.
  if (/bug|defect|fault/i.test(name)) return 'bug';
  if (/story/i.test(name)) return 'story';
  return 'task';
}

export function buildBoard(project, epics, children, unsorted = []) {
  const features = epics.map((e) => ({ ...e, items: [] }));
  const byKey = new Map(features.map((f) => [f.key, f]));
  for (const issue of children) {
    if (issue.type === 'epic' || issue.type === 'subtask') continue;
    byKey.get(issue.parentKey)?.items.push(issue);
  }
  return {
    project,
    features,
    unsorted: unsorted.filter((i) => i.type !== 'epic' && i.type !== 'subtask'),
  };
}

export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const KINDS = ['task', 'bug', 'story', 'epic'];
