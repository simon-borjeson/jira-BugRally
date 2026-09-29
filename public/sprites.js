// Original pixel-art sprites, drawn as SVG so they stay crisp at any size.

export function pixelSvg(rows, palette, scale = 4, cls = '') {
  const h = rows.length;
  const w = rows[0].length;
  let rects = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const c = row[x];
      if (!palette[c]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < w && row[x + run] === c) run++;
      rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${palette[c]}"/>`;
      x += run;
    }
  });
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${
    h * scale
  }" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

const grid = (w, h, fn) =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => fn(x, y)).join(''));

/* ---------- The race car (side view, facing right) ---------- */
const carRows = (frame) =>
  grid(28, 13, (x, y) => {
    for (const cx of [6.5, 21.5]) {
      const cy = 9.5;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= 3.4) {
        if (d <= 0.9) return 'H';
        if (d <= 2.3) {
          const ang = Math.atan2(y - cy, x - cx);
          const spoke = frame ? Math.abs(Math.sin(2 * ang)) < 0.45 : Math.abs(Math.cos(2 * ang)) < 0.45;
          return spoke ? 'H' : 'G';
        }
        return 'K';
      }
    }
    if (y === 0) return x >= 11 && x <= 18 ? 'R' : '.';
    if (y >= 1 && y <= 3) {
      const l = 11 - y;
      const r = 18 + y;
      if (x < l || x > r) return '.';
      if (x === l || x === r || x === 15) return 'R';
      if ((x === 17 || x === 18) && y <= 2) return 'M'; // driver's helmet
      return 'C';
    }
    if (y === 4) return x >= 3 && x <= 25 ? 'R' : '.';
    if (y === 5) return x === 1 ? 'T' : x === 27 ? 'Y' : x >= 1 && x <= 27 ? 'R' : '.';
    if (y === 6) return x >= 2 && x <= 25 ? 'W' : 'R';
    if (y === 7) return 'R';
    if (y === 8) return 'D';
    if (y === 9) return x >= 1 && x <= 26 ? 'D' : '.';
    return '.';
  });
const CAR_PAL = {
  R: '#b13e53',
  D: '#5d275d',
  W: '#f4f4f4',
  C: '#73eff7',
  M: '#ffcd75',
  K: '#1a1c2c',
  G: '#94b0c2',
  H: '#566c86',
  Y: '#ffcd75',
  T: '#ef7d57',
};

/* ---------- Bugs: traffic cones blocking the track ---------- */
const coneRows = (lamp) =>
  grid(12, 17, (x, y) => {
    if (y === 0) return x === 5 || x === 6 ? (lamp ? 'L' : 'O') : '.';
    if (y >= 15) return y === 15 ? 'O' : 'D';
    const cy = y - 1;
    const half = 0.6 + cy * 0.38;
    const cx = 5.5;
    if (Math.abs(x - cx) > half) return '.';
    if ((cy >= 4 && cy <= 5) || (cy >= 9 && cy <= 10)) return 'W';
    return x < cx - half + 1 ? 'S' : 'O';
  });
const CONE_PAL = { O: '#ef7d57', S: '#b13e53', W: '#f4f4f4', D: '#333c57', L: '#ffcd75' };

/* ---------- Tasks & stories: fuel cans to collect ---------- */
const canRows = grid(12, 14, (x, y) => {
  if (y <= 2) {
    if (y === 0 && x >= 2 && x <= 6) return 'D';
    if (y >= 1 && (x === 2 || x === 6)) return 'D';
    if (y === 1 && (x === 8 || x === 9)) return 'Y';
    if (y === 2 && (x === 8 || x === 9)) return 'D';
    return '.';
  }
  if (x === 0 || x === 11 || y === 13 || y === 3) return 'D';
  const u = x - 1;
  const v = y - 4;
  if (Math.abs(u - (v * 10) / 9) < 0.8 || Math.abs(9 - u - (v * 10) / 9) < 0.8) return 'L';
  return 'R';
});
const TASK_PAL = { R: '#b13e53', L: '#ef7d57', D: '#5d275d', Y: '#ffcd75' };
const STORY_PAL = { R: '#3b5dc9', L: '#41a6f6', D: '#29366f', Y: '#ffcd75' };

/* ---------- Done tasks: a passed checkpoint flag ---------- */
const FLAG_CHECK = new Set(['3,5', '4,6', '5,5', '6,4', '7,3', '4,5', '5,4']);
const flagRows = grid(12, 18, (x, y) => {
  if (x === 1 && y <= 16) return 'P';
  if (y === 17) return x <= 3 ? 'D' : '.';
  if (y >= 1 && y <= 9) {
    const w = 10 - Math.abs(y - 5) * 2;
    if (x >= 2 && x < 2 + w) return FLAG_CHECK.has(`${x},${y}`) ? 'W' : 'G';
  }
  return '.';
});
const FLAG_PAL = { P: '#94b0c2', D: '#333c57', G: '#38b764', W: '#f4f4f4' };

/* ---------- Trophy at the finish ---------- */
const trophyRows = grid(14, 16, (x, y) => {
  if (y <= 7) {
    const l = 2 + Math.floor(y / 3);
    const r = 11 - Math.floor(y / 3);
    if (x >= l && x <= r) return x === l + 1 && y < 6 ? 'L' : 'Y';
    if ((x === 0 || x === 13) && y >= 1 && y <= 4) return 'Y';
    if ((x === 1 || x === 12) && (y === 1 || y === 4)) return 'Y';
    return '.';
  }
  if (y <= 10) return x === 6 || x === 7 ? 'Y' : '.';
  if (y <= 12) return x >= 4 && x <= 9 ? 'Y' : '.';
  return x >= 2 && x <= 11 ? 'D' : '.';
});
const TROPHY_PAL = { Y: '#ffcd75', L: '#f4f4f4', D: '#5d275d' };

/* ---------- Checkered flag icon ---------- */
const checkeredRows = grid(11, 9, (x, y) => {
  if (x === 0) return 'P';
  if (y <= 6) return (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 'K' : 'W';
  return '.';
});
const CHECKERED_PAL = { P: '#94b0c2', K: '#1a1c2c', W: '#f4f4f4' };

/* ---------- Scenery ---------- */
const cloudRows = grid(24, 10, (x, y) => {
  const blobs = [
    [6, 6, 4.2],
    [12, 4.5, 5],
    [18, 6, 4.2],
  ];
  const inside = (pad) => blobs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= (r + pad) ** 2);
  if (y > 8) return '.';
  if (inside(-1)) return 'W';
  if (inside(0)) return 'E';
  return '.';
});
const CLOUD_PAL = { W: '#f4f4f4', E: '#c8e6ff' };

const bushRows = grid(20, 8, (x, y) => {
  const blobs = [
    [5, 7, 4.5],
    [10, 5.5, 5.5],
    [15, 7, 4.5],
  ];
  const inside = (pad) => blobs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= (r + pad) ** 2);
  if (inside(-1)) return (x + y) % 5 === 0 ? 'L' : 'G';
  if (inside(0)) return 'D';
  return '.';
});
const BUSH_PAL = { G: '#38b764', L: '#a7f070', D: '#257179' };

export const SPRITES = {
  carA: pixelSvg(carRows(0), CAR_PAL, 4),
  carB: pixelSvg(carRows(1), CAR_PAL, 4),
  carSmall: pixelSvg(carRows(0), CAR_PAL, 1),
  carIcon: pixelSvg(carRows(0), CAR_PAL, 1),
  coneA: pixelSvg(coneRows(true), CONE_PAL, 3),
  coneB: pixelSvg(coneRows(false), CONE_PAL, 3),
  coneIcon: pixelSvg(coneRows(false), CONE_PAL, 1),
  taskCan: pixelSvg(canRows, TASK_PAL, 3),
  storyCan: pixelSvg(canRows, STORY_PAL, 3),
  taskIcon: pixelSvg(canRows, TASK_PAL, 1),
  storyIcon: pixelSvg(canRows, STORY_PAL, 1),
  flag: pixelSvg(flagRows, FLAG_PAL, 3),
  trophy: pixelSvg(trophyRows, TROPHY_PAL, 4),
  checkered: pixelSvg(checkeredRows, CHECKERED_PAL, 3),
  checkeredSmall: pixelSvg(checkeredRows, CHECKERED_PAL, 2),
  cloud: pixelSvg(cloudRows, CLOUD_PAL, 5),
  bush: pixelSvg(bushRows, BUSH_PAL, 4),
};
