/* ==========================================================================
   IRONVEIL v3 — Top-Down Tactical Duel (2v2)
   Fighter + Mage · HP-based combat · Mobile-first · Camera follows active unit
   ==========================================================================
   RULES (unchanged from v2)
   - Grid 12x12. Orthogonal movement only. Top-down square tiles.
   - 2 units per side: Fighter (HP10 DMG2, passive half-damage) + Mage (HP10 DMG3 range2, Heal3).
   - Turn: Roll dice (1-6). Pick ONE of your alive units. Either MOVE or HEAL (mage only).
   - Move must consume the FULL dice value (exact path length).
   - If move ends in weapon range, popup: Attack (deal damage) or Skip.
   - Heal restores 3 HP to self or any ally; only enabled if any ally below max HP.
   - End Turn available anytime. Win: all enemies dead. Lose: all your units dead.
   ========================================================================== */
(() => {
'use strict';

/* ============================================================
   CONFIG
   ============================================================ */
const GRID_SIZE   = 10;
const TILE_SIZE   = 80;        // base square tile size in world pixels
const BLOCKED_COUNT = 15;

const STEP_MS      = 160;
const AI_THINK_MS  = 550;
const DICE_ROLL_MS = 1100;
const CAM_LERP     = 0.18;     // camera follow smoothing

const DIR = {
  UP:    { dx:  0, dy: -1, name:'UP'    },
  DOWN:  { dx:  0, dy:  1, name:'DOWN'  },
  LEFT:  { dx: -1, dy:  0, name:'LEFT'  },
  RIGHT: { dx:  1, dy:  0, name:'RIGHT' },
};
const DIRS = [DIR.UP, DIR.DOWN, DIR.LEFT, DIR.RIGHT];

const UNIT_DEFS = {
  fighter: { maxHp:10, dmg:2, range:1, heal:0, passiveHalf:true  },
  mage:    { maxHp:10, dmg:3, range:2, heal:3, passiveHalf:false },
};

/* ============================================================
   STATE
   ============================================================ */
const state = {
  phase: 'lobby',                // lobby | playing | ended
  turn:  'player',               // player | enemy
  subPhase: 'roll',              // roll | select | action | animating | resolving
  dice: 0,
  blocked: new Set(),
  blockedTypes: new Map(),
  units: {},                     // id -> unit
  activeUnit: null,              // id of currently-selected unit (for movement tiles)
  validTargets: null,            // Map<"x,y", {path, cost}>
  hoverTile: null,
  animating: false,
  unitsActedThisTurn: new Set(), // ids that already moved/healed this turn
};

/* ============================================================
   ASSETS
   ------------------------------------------------------------
   Embedded base64 data URIs for sprites/tiles. The `EMBEDDED_ASSETS`
   placeholder below is replaced at package time with actual data URIs.
   Images are pre-loaded on game start; Assets.img(name) returns the
   HTMLImageElement (or null if it hasn't loaded yet — rendering
   falls back to a procedural placeholder in that case).
   ============================================================ */
/* Auto-generated: embedded directional assets (v8) */
const EMBEDDED_ASSETS = {
  normalTile: 'assets/validTile1.png',
  blockedTile: 'assets/blockedTile1.png',
  blockedTile2: 'assets/blockedTile1.png',
  'blue-faceUp': 'assets/blue-faceUp.png',
  'blue-faceRight': 'assets/blue-faceRight.png',
  'blue-faceLeft': 'assets/blue-faceLeft.png',
  'blue-faceDown': 'assets/blue-faceDown.png',
  'blue2-faceUp': 'assets/blue2-faceUp.png',
  'blue2-faceRight': 'assets/blue2-faceRight.png',
  'blue2-faceLeft': 'assets/blue2-faceLeft.png',
  'blue2-faceDown': 'assets/blue2-faceDown.png',
  'red-faceUp': 'assets/red-faceUp.png',
  'red-faceRight': 'assets/red-faceRight.png',
  'red-faceLeft': 'assets/red-faceLeft.png',
  'red-faceDown': 'assets/red-faceDown.png',
  'red1-faceUp': 'assets/red1-faceUp.png',
  'red1-faceRight': 'assets/red1-faceRight.png',
  'red1-faceLeft': 'assets/red1-faceLeft.png',
  'red1-faceDown': 'assets/red1-faceDown.png'
};
const EMBEDDED_ASSETS_SAFE = EMBEDDED_ASSETS;

const Assets = (() => {
  const cache = {};
  let loadedCount = 0;
  let totalCount = 0;

  function loadOne(name, src){
    return new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => { cache[name] = img; loadedCount++; resolve(img); };
      img.onerror = () => { console.warn('Asset failed to load:', name, src); cache[name] = null; loadedCount++; resolve(null); };
      img.src = src;
    });
  }

  async function loadAll(){
    const entries = Object.entries(EMBEDDED_ASSETS_SAFE);
    totalCount = entries.length;
    loadedCount = 0;
    if (totalCount === 0) return;
    await Promise.all(entries.map(([k, v]) => loadOne(k, v)));
  }

  function img(name){ return cache[name] || null; }
  function ready(){ return totalCount > 0 && loadedCount === totalCount; }
  function progress(){ return totalCount === 0 ? 1 : loadedCount / totalCount; }

  return { loadAll, img, ready, progress };
})();

const $id = (id) => document.getElementById(id);
const setText = (el, value) => { if (el) el.textContent = value; };

/* ============================================================
   AUDIO (synthesized stand-in for real sfx files)
   ============================================================ */
const Audio = (() => {
  let ctx = null, bgmGain = null, bgmNodes = [], muted = false;
  function ensure(){
    if (ctx) return ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_){ ctx = null; }
    return ctx;
  }
  function blip({ freq=440, type='sine', dur=0.12, vol=0.18, sweep=0, delay=0 }={}){
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq+sweep), t0+dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noiseBurst({ dur=0.12, vol=0.18, filter=1200, delay=0 }={}){
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<len;i++) d[i] = (Math.random()*2-1) * (1 - i/len);
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=filter; bp.Q.value=1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(c.destination);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }
  const map = {
    'ui-click':    () => blip({ freq:540, type:'square', dur:0.06, vol:0.12, sweep:-120 }),
    'tile-select': () => { blip({ freq:720, type:'triangle', dur:0.08, vol:0.14 });
                           blip({ freq:1080,type:'triangle', dur:0.08, vol:0.10, delay:0.04 }); },
    'xTile':       () => { blip({ freq:180, type:'sawtooth', dur:0.12, vol:0.14, sweep:-60 });
                           noiseBurst({ dur:0.08, vol:0.08, filter:400 }); },
    'walk':        () => noiseBurst({ dur:0.09, vol:0.09, filter:800 }),
    'hit':         () => { blip({ freq:110, type:'square', dur:0.16, vol:0.22, sweep:-40 });
                           noiseBurst({ dur:0.14, vol:0.18, filter:1800 }); },
    'hit-mage':    () => { blip({ freq:880, type:'sine', dur:0.18, vol:0.18, sweep:-500 });
                           blip({ freq:440, type:'triangle', dur:0.12, vol:0.12, delay:0.06 }); },
    'heal':        () => { blip({ freq:660, type:'sine', dur:0.14, vol:0.14 });
                           blip({ freq:990, type:'sine', dur:0.18, vol:0.12, delay:0.05 });
                           blip({ freq:1320,type:'sine', dur:0.22, vol:0.10, delay:0.10 }); },
    'dice':        () => { for (let i=0;i<5;i++) noiseBurst({ dur:0.05, vol:0.07, filter:1400, delay:i*0.12 }); },
    'select':      () => blip({ freq:880, type:'triangle', dur:0.1, vol:0.12 }),
    'death':       () => { blip({ freq:220, type:'sawtooth', dur:0.4, vol:0.18, sweep:-180 });
                           noiseBurst({ dur:0.3, vol:0.12, filter:600, delay:0.1 }); },
  };
  function play(name){ const fn = map[name]; if (fn) fn(); }
  function startBGM(){
    const c = ensure(); if (!c || muted) return;
    stopBGM();
    bgmGain = c.createGain();
    bgmGain.gain.value = 0;
    bgmGain.gain.linearRampToValueAtTime(0.05, c.currentTime + 2.0);
    bgmGain.connect(c.destination);
    const freqs = [55, 82.4, 110, 146.8];
    freqs.forEach((f,i) => {
      const o = c.createOscillator();
      o.type = i%2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const g = c.createGain(); g.gain.value = 0.22 / (i+1);
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.08 + i*0.03;
      const lfoG = c.createGain(); lfoG.gain.value = 0.08;
      lfo.connect(lfoG).connect(g.gain);
      o.connect(g).connect(bgmGain);
      o.start(); lfo.start();
      bgmNodes.push(o, lfo);
    });
  }
  function stopBGM(){
    if (!ctx || !bgmGain) return;
    try {
      bgmGain.gain.cancelScheduledValues(ctx.currentTime);
      bgmGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
      const toStop = bgmNodes.slice();
      setTimeout(() => { toStop.forEach(n => { try{ n.stop(); }catch(_){} }); }, 500);
    } catch(_){}
    bgmNodes = []; bgmGain = null;
  }
  function resume(){ if (ctx && ctx.state === 'suspended') ctx.resume(); }
  return { play, startBGM, stopBGM, resume };
})();

/* ============================================================
   GRID HELPERS
   ============================================================ */
const key = (x,y) => `${x},${y}`;
const inBounds = (x,y) => x>=0 && y>=0 && x<GRID_SIZE && y<GRID_SIZE;
const isBlocked = (x,y) => state.blocked.has(key(x,y));

function unitAt(x,y){
  for (const u of Object.values(state.units)){
    if (u.alive && u.x === x && u.y === y) return u;
  }
  return null;
}
function isOccupied(x,y, ignoreId=null){
  const u = unitAt(x,y);
  return u && u.id !== ignoreId;
}
function tileFree(x,y, ignoreId=null){
  if (!inBounds(x,y)) return false;
  if (isBlocked(x,y)) return false;
  if (isOccupied(x,y, ignoreId)) return false;
  return true;
}

/* ============================================================
   PATHFINDING
   ------------------------------------------------------------
   For v2 the movement rule is: path length === dice (exact).
   We enumerate all tiles reachable in EXACTLY N steps (simple BFS
   over (tile, stepCount), avoiding revisiting a tile within the
   same depth — allowing us to find simple paths).
   ============================================================ */

// Return Map<"x,y", { path: [{x,y}...], cost }> of all tiles reachable in
// a simple path of EXACTLY `exactSteps` tiles from (sx,sy). Avoids blocked
// and (other) occupied tiles.
function tilesReachableExact(sx, sy, exactSteps, ignoreUnitId){
  const result = new Map();
  if (exactSteps <= 0){
    result.set(key(sx,sy), { path:[{x:sx,y:sy}], cost:0 });
    return result;
  }
  // DFS with visited set on the stack to generate simple paths
  const startPath = [{x:sx, y:sy}];
  const startVis  = new Set([key(sx,sy)]);

  function recurse(path, visited, stepsLeft){
    const cur = path[path.length - 1];
    if (stepsLeft === 0){
      const k = key(cur.x, cur.y);
      if (!result.has(k)){
        result.set(k, { path: path.slice(), cost: exactSteps });
      }
      return;
    }
    for (const d of DIRS){
      const nx = cur.x + d.dx, ny = cur.y + d.dy;
      const k = key(nx, ny);
      if (!inBounds(nx, ny)) continue;
      if (isBlocked(nx, ny)) continue;
      if (isOccupied(nx, ny, ignoreUnitId)) continue;
      if (visited.has(k)) continue;
      visited.add(k);
      path.push({x:nx, y:ny});
      recurse(path, visited, stepsLeft - 1);
      path.pop();
      visited.delete(k);
    }
  }

  // Depth limiter: for dice up to 6, search space is ~4*3^5 = 972 leaves worst case, tractable.
  // For larger dice we'd need iterative deepening + memoization; N<=6 is fine.
  recurse(startPath, startVis, exactSteps);
  return result;
}

// Minimum BFS distance from (sx,sy) to every reachable tile (ignores one specific unit).
function bfsDistanceField(sx, sy, ignoreUnitId=null){
  const dist = new Map();
  if (!inBounds(sx,sy)) return dist;
  dist.set(key(sx,sy), 0);
  const q = [[sx,sy]];
  while (q.length){
    const [x,y] = q.shift();
    const d = dist.get(key(x,y));
    for (const dir of DIRS){
      const nx = x + dir.dx, ny = y + dir.dy;
      const k = key(nx,ny);
      if (!inBounds(nx,ny)) continue;
      if (isBlocked(nx,ny)) continue;
      if (isOccupied(nx,ny, ignoreUnitId)) continue;
      if (dist.has(k)) continue;
      dist.set(k, d+1);
      q.push([nx,ny]);
    }
  }
  return dist;
}

// BFS with blocked tiles only (for map validity)
function bfsConnected(sx, sy){
  const seen = new Set([key(sx,sy)]);
  const q = [[sx,sy]];
  while (q.length){
    const [x,y] = q.shift();
    for (const d of DIRS){
      const nx = x + d.dx, ny = y + d.dy;
      if (!inBounds(nx,ny) || isBlocked(nx,ny)) continue;
      const k = key(nx,ny);
      if (seen.has(k)) continue;
      seen.add(k); q.push([nx,ny]);
    }
  }
  return seen;
}

function generateBlocked(positions){
  state.blocked.clear();
  state.blockedTypes.clear();
  const count = BLOCKED_COUNT;
  const protect = new Set();
  for (const p of positions){
    protect.add(key(p.x, p.y));
    for (const d of DIRS) protect.add(key(p.x+d.dx, p.y+d.dy));
  }

  let attempts = 0, placed = 0;
  // On a 10x10 grid with 15 blockers, the free space is tight — raise
  // the attempt budget so the connectivity check has room to reject bad
  // placements without starving out the final count.
  while (placed < count && attempts < 2000){
    attempts++;
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    const k = key(x,y);
    if (state.blocked.has(k) || protect.has(k)) continue;
    state.blocked.add(k);

    // Ensure ALL unit positions remain in one connected component
    const conn = bfsConnected(positions[0].x, positions[0].y);
    let ok = true;
    for (const p of positions){
      if (!conn.has(key(p.x,p.y))){ ok = false; break; }
    }
    if (!ok){ state.blocked.delete(k); continue; }
    placed++;
  }

  for (const k of state.blocked){
    const r = Math.random();
    const type = Math.random() < 0.6 ? 'stone' : 'bush';
    state.blockedTypes.set(k, type);
  }
}

/* ============================================================
   TOP-DOWN PROJECTION
   ------------------------------------------------------------
   Grid-to-world is trivial:
     worldX = gx * TILE_SIZE
     worldY = gy * TILE_SIZE
   Camera stores a world-space center point that the canvas
   should show in the middle of the viewport. `scale` lets us
   shrink tiles on small screens so the grid doesn't force the
   user to pan excessively.
   ============================================================ */

/* ============================================================
   CANVAS SETUP
   ============================================================ */

function isLandscapeViewport(){
  return window.matchMedia && window.matchMedia('(orientation: landscape)').matches;
}
function isCompactLandscape(){
  return isLandscapeViewport() && Math.min(window.innerWidth, window.innerHeight) <= 540;
}
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
let DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

// Camera state: world-space point that should appear at the center of the viewport.
// `scale` is the world-to-screen multiplier applied to tiles.
const camera = {
  cx:  GRID_SIZE * TILE_SIZE / 2,
  cy:  GRID_SIZE * TILE_SIZE / 2,
  targetCx: GRID_SIZE * TILE_SIZE / 2,
  targetCy: GRID_SIZE * TILE_SIZE / 2,
  scale: 1,
  viewW: 0,
  viewH: 0,
};

function resizeCanvas(){
  const stage = canvas.parentElement;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w <= 0 || h <= 0) return;
  canvas.width  = Math.floor(w * DPR);
  canvas.height = Math.floor(h * DPR);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  camera.viewW = w;
  camera.viewH = h;

  // Responsive zoom:
  // - compact landscape phones should show a little more vertically.
  // - portrait keeps larger tiles.
  const compactLandscape = isCompactLandscape();
  const minTilesVisible = compactLandscape ? 8 : 6;
  const maxTilesVisible = GRID_SIZE;
  const byWidth  = w / (minTilesVisible * TILE_SIZE);
  const byHeight = h / (minTilesVisible * TILE_SIZE);
  const desired  = Math.min(Math.max(byWidth, byHeight), compactLandscape ? 1.05 : 1.4);

  const fitAllX = w / (maxTilesVisible * TILE_SIZE);
  const fitAllY = h / (maxTilesVisible * TILE_SIZE);
  const fitAll  = Math.min(fitAllX, fitAllY);

  camera.scale = Math.max(fitAll, Math.min(desired, compactLandscape ? 1.05 : 1.4));
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

/* ============================================================
   CAMERA FOLLOW
   ------------------------------------------------------------
   Camera target is the active unit (or grid center if none).
   Each frame we lerp toward target and clamp so the viewport
   never shows empty space outside the grid (when the grid is
   bigger than the viewport).
   ============================================================ */
function updateCamera(){
  const compactLandscape = isCompactLandscape();

  // Determine target. Default to arena center.
  let tx = GRID_SIZE * TILE_SIZE / 2;
  let ty = GRID_SIZE * TILE_SIZE / 2;
  let follow = null;

  if (state.activeUnit && state.units[state.activeUnit] && state.units[state.activeUnit].alive){
    follow = state.units[state.activeUnit];
  } else if (state.turn === 'enemy'){
    const moving = Object.values(state.units).find(u => u.side === 'enemy' && u.alive && (u.renderOffsetX || u.renderOffsetY));
    follow = moving || null;
  }

  if (follow){
    const rx = follow.x + (follow.renderOffsetX || 0);
    const ry = follow.y + (follow.renderOffsetY || 0);
    tx = rx * TILE_SIZE + TILE_SIZE / 2;
    ty = ry * TILE_SIZE + TILE_SIZE / 2;
  }

  // Turn-focus bias:
  // player side occupies the lower half, enemy side the upper half.
  // In compact landscape, lean the camera toward the acting side.
  if (compactLandscape){
    const sideBiasY = (state.turn === 'player')
      ? GRID_SIZE * TILE_SIZE * 0.72
      : GRID_SIZE * TILE_SIZE * 0.28;
    const blend = follow ? 0.38 : 0.62;
    ty = ty * (1 - blend) + sideBiasY * blend;
  }

  const halfW = camera.viewW / 2 / camera.scale;
  const halfH = camera.viewH / 2 / camera.scale;
  const minX = halfW, maxX = GRID_SIZE * TILE_SIZE - halfW;
  const minY = halfH, maxY = GRID_SIZE * TILE_SIZE - halfH;
  if (maxX > minX) tx = Math.max(minX, Math.min(maxX, tx));
  else tx = GRID_SIZE * TILE_SIZE / 2;
  if (maxY > minY) ty = Math.max(minY, Math.min(maxY, ty));
  else ty = GRID_SIZE * TILE_SIZE / 2;

  camera.targetCx = tx;
  camera.targetCy = ty;
  camera.cx += (camera.targetCx - camera.cx) * CAM_LERP;
  camera.cy += (camera.targetCy - camera.cy) * CAM_LERP;
}

/* ============================================================
   PROJECTION
   ============================================================ */
function worldToCanvas(wx, wy){
  const s = camera.scale;
  return {
    sx: (wx - camera.cx) * s + camera.viewW / 2,
    sy: (wy - camera.cy) * s + camera.viewH / 2,
  };
}
function gridToCanvas(gx, gy){
  // returns top-left corner of the tile
  const wx = gx * TILE_SIZE;
  const wy = gy * TILE_SIZE;
  return worldToCanvas(wx, wy);
}
function gridCenterToCanvas(gx, gy){
  const wx = gx * TILE_SIZE + TILE_SIZE / 2;
  const wy = gy * TILE_SIZE + TILE_SIZE / 2;
  return worldToCanvas(wx, wy);
}
function canvasToGrid(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const wx = (cssX - camera.viewW/2) / camera.scale + camera.cx;
  const wy = (cssY - camera.viewH/2) / camera.scale + camera.cy;
  return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
}

const T = () => TILE_SIZE * camera.scale;        // on-screen tile size

/* ============================================================
   TOP-DOWN RENDERING
   ============================================================ */

// ---- Floor -------------------------------------------------------
// Each tile is a square with a subtle stone-tile inset. Even/odd
// checker is muted so the grid reads without being gaudy.
function drawFloorTile(gx, gy){
  const { sx, sy } = gridToCanvas(gx, gy);
  const t = T();
  const img = Assets.img('normalTile');

  if (img){
    // Draw the tile image filling the square exactly
    ctx.drawImage(img, sx, sy, t, t);
    // subtle darkening on checker pattern for variety
    if ((gx + gy) % 2 === 1){
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(sx, sy, t, t);
    }
    // seam line so the grid reads clearly
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, t - 1, t - 1);
    return;
  }

  // Fallback (image not yet loaded) — procedural stone
  const even = (gx + gy) % 2 === 0;
  const base1 = even ? '#2b231a' : '#231c14';
  const base2 = even ? '#3a2e22' : '#2f261c';
  const grad = ctx.createLinearGradient(sx, sy, sx, sy + t);
  grad.addColorStop(0, base2);
  grad.addColorStop(1, base1);
  ctx.fillStyle = grad;
  ctx.fillRect(sx, sy, t, t);
  ctx.strokeStyle = 'rgba(16,10,6,0.65)';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx + 0.5, sy + 0.5, t - 1, t - 1);
}

// ---- Highlights ---------------------------------------------------
function drawHighlight(gx, gy, kind){
  const { sx, sy } = gridToCanvas(gx, gy);
  const t = T();
  let fill, stroke, lw = 2;
  if (kind === 'valid'){
    const pulse = 0.28 + 0.12 * Math.sin(performance.now() / 340);
    fill = `rgba(224,133,64,${pulse})`;
    stroke = 'rgba(255,180,110,0.9)';
  } else if (kind === 'hover'){
    fill = 'rgba(255,230,160,0.28)';
    stroke = 'rgba(255,240,200,1)';
    lw = 2.5;
  } else if (kind === 'path'){
    fill = 'rgba(255,200,120,0.22)';
    stroke = 'rgba(255,220,160,0.85)';
    lw = 1.5;
  } else if (kind === 'attack'){
    fill = 'rgba(180,40,30,0.45)';
    stroke = 'rgba(255,100,70,1)';
  } else if (kind === 'heal'){
    fill = 'rgba(74,157,106,0.45)';
    stroke = 'rgba(140,220,160,1)';
  } else if (kind === 'active'){
    const p = 0.5 + 0.3 * Math.sin(performance.now() / 240);
    fill = `rgba(255,200,130,${0.2 + p*0.15})`;
    stroke = `rgba(255,220,160,${0.7 + p*0.3})`;
    lw = 2.5;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(sx, sy, t, t);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.strokeRect(sx + lw/2, sy + lw/2, t - lw, t - lw);
}

// Path dashes — draw arrow-chain from each tile center to next
function drawPathArrows(path){
  if (!path || path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,220,160,0.85)';
  ctx.fillStyle   = 'rgba(255,220,160,0.85)';
  ctx.lineWidth   = Math.max(2, 3 * camera.scale);
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.setLineDash([]);
  for (let i = 0; i < path.length - 1; i++){
    const a = gridCenterToCanvas(path[i].x, path[i].y);
    const b = gridCenterToCanvas(path[i+1].x, path[i+1].y);
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  }
  // arrowhead at the last tile
  const pen = path[path.length - 2];
  const end = path[path.length - 1];
  const ep = gridCenterToCanvas(end.x, end.y);
  const pp = gridCenterToCanvas(pen.x, pen.y);
  const ang = Math.atan2(ep.sy - pp.sy, ep.sx - pp.sx);
  const size = 10 * camera.scale;
  ctx.beginPath();
  ctx.moveTo(ep.sx, ep.sy);
  ctx.lineTo(ep.sx - Math.cos(ang - 0.5) * size, ep.sy - Math.sin(ang - 0.5) * size);
  ctx.lineTo(ep.sx - Math.cos(ang + 0.5) * size, ep.sy - Math.sin(ang + 0.5) * size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---- Obstacles ---------------------------------------------------
// Two visual styles, both block movement:
//   'stone' — uses blockedTile.png (full-tile stone with skulls/spikes).
//             Drawn in place of the floor tile, no shadow needed.
//   'bush'  — uses blockedTile2.png (overlay sprite on top of normal floor).
function drawObstacle(gx, gy, type){
  const { sx, sy } = gridToCanvas(gx, gy);
  const t = T();
  const cx = sx + t/2, cy = sy + t/2;

  if (type === 'stone'){
    const img = Assets.img('blockedTile');
    if (img){
      // cover the entire tile (overwrites the floor under it)
      ctx.drawImage(img, sx, sy, t, t);
      // seam so it still reads as part of the grid
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, t - 1, t - 1);
      return;
    }
    // fallback
    ctx.fillStyle = '#3d3630';
    ctx.fillRect(sx, sy, t, t);
    ctx.strokeStyle = '#14100b';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, t - 1, t - 1);
    return;
  }

  // BUSH — floor already drawn underneath; we just overlay the leafy image.
  if (type === 'bush'){
    // soft ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + t*0.22, t*0.36, t*0.13, 0, 0, Math.PI*2);
    ctx.fill();

    const img = Assets.img('blockedTile2');
    if (img){
      // scale to cover most of the tile but leave a bit of floor showing
      const bw = t * 0.92;
      const bh = t * 0.92;
      ctx.drawImage(img, cx - bw/2, cy - bh/2, bw, bh);
      return;
    }
    // fallback procedural bush
    const blobs = [
      { dx:-0.14, dy: 0.05, r:0.24, c1:'#1f3a22', c2:'#3b5e38' },
      { dx: 0.12, dy: 0.00, r:0.26, c1:'#223f25', c2:'#456b42' },
      { dx: 0.00, dy:-0.14, r:0.22, c1:'#264527', c2:'#517946' },
    ];
    for (const b of blobs){
      ctx.fillStyle = b.c1;
      ctx.beginPath();
      ctx.arc(cx + b.dx*t, cy + b.dy*t, b.r*t, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = b.c2;
      ctx.beginPath();
      ctx.arc(cx + (b.dx - 0.05)*t, cy + (b.dy - 0.06)*t, b.r*t*0.55, 0, Math.PI*2);
      ctx.fill();
    }
    return;
  }
}

// ---- Ambient torch glow (decorative, applied after floor) --------
// Place torches procedurally at stable positions so the dungeon feels lit.
// We use a fixed seed derived from blocked tiles to keep them stable per match.
let torchPositions = null;
function computeTorchPositions(){
  // Put torches at the four corners of the arena + a couple of stable mid-wall spots.
  torchPositions = [
    { x: 0.5, y: 0.5 },
    { x: GRID_SIZE - 1.5, y: 0.5 },
    { x: 0.5, y: GRID_SIZE - 1.5 },
    { x: GRID_SIZE - 1.5, y: GRID_SIZE - 1.5 },
    { x: GRID_SIZE / 2,   y: 0.5 },
    { x: GRID_SIZE / 2,   y: GRID_SIZE - 1.5 },
  ];
}
function drawTorches(){
  if (!torchPositions) return;
  const now = performance.now();
  for (const tp of torchPositions){
    const { sx, sy } = gridCenterToCanvas(tp.x - 0.5, tp.y - 0.5);
    const t = T();
    const flick = 0.85 + 0.15 * Math.sin(now / 160 + tp.x*3 + tp.y*5);
    const r = t * 0.55 * flick;
    const grad = ctx.createRadialGradient(sx, sy, 2, sx, sy, r);
    grad.addColorStop(0, `rgba(255,170,80,${0.22 * flick})`);
    grad.addColorStop(0.6, `rgba(224,120,40,${0.08 * flick})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grad;
    ctx.fillRect(sx - r, sy - r, r*2, r*2);
    ctx.restore();
    // flame core
    ctx.fillStyle = `rgba(255,210,120,${0.95 * flick})`;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(2, 3 * camera.scale), 0, Math.PI*2);
    ctx.fill();
  }
}

// ---- Characters --------------------------------------------------
// v8: directional sprites — 4 PNGs per character (faceUp/Down/Left/Right).
// Facing is updated by the movement animation (last step direction) and by
// faceToward(...) before attacks. Dead units keep their last facing.
// Key mapping: player fighter=blue, player mage=blue2, enemy fighter=red, enemy mage=red1.
function spriteKeyFor(unit){
  const base =
    (unit.side === 'player')
      ? (unit.type === 'mage' ? 'blue2' : 'blue')
      : (unit.type === 'mage' ? 'red1' : 'red');
  const facing = unit.facing || DIR.DOWN;
  const suffix =
    (facing === DIR.UP)    ? 'faceUp'    :
    (facing === DIR.DOWN)  ? 'faceDown'  :
    (facing === DIR.LEFT)  ? 'faceLeft'  : 'faceRight';
  return base + '-' + suffix;
}

function drawCharacter(unit, cx, cy){
  const s = camera.scale;
  const t = T();
  const bob = Math.sin(performance.now() / 500 + (unit.x + unit.y)) * 1.4 * s;

  const isPlayer = unit.side === 'player';
  const isMage   = unit.type === 'mage';

  const sprite = Assets.img(spriteKeyFor(unit));

  // GROUND SHADOW
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + t*0.28, t*0.30, t*0.10, 0, 0, Math.PI*2);
  ctx.fill();

  // ALLEGIANCE RING
  const ringColor = isPlayer ? 'rgba(224,133,64,0.65)' : 'rgba(106,139,171,0.65)';
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = Math.max(1.5, 2.5 * s);
  ctx.beginPath();
  ctx.ellipse(cx, cy + t*0.29, t*0.32, t*0.10, 0, 0, Math.PI*2);
  ctx.stroke();

  const unit_s = t / 80; // scale reference

  // SPRITE BLIT — use the direction-specific sprite. No flipping or rotation.
  if (sprite){
    const targetH = t * 1.1;
    const targetW = targetH * (sprite.width / sprite.height);
    const sx = cx - targetW / 2;
    const sy = cy + t * 0.29 + bob - targetH * 0.95;

    ctx.save();
    if (!unit.alive) ctx.globalAlpha = 0.45;
    ctx.drawImage(sprite, sx, sy, targetW, targetH);
    ctx.restore();
  } else {
    // Fallback: simple coloured circle so layout is still readable
    ctx.fillStyle = isPlayer
      ? (isMage ? '#b43a3a' : '#c55a3a')
      : (isMage ? '#3a6da8' : '#4a7bab');
    ctx.beginPath();
    ctx.arc(cx, cy + bob, t*0.28, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 2 * s;
    ctx.stroke();
  }

  // Facing chevron under the character
  drawFacingChevron(unit, cx, cy + t*0.38, unit_s);

  // HP bar above head — lifted higher because sprite is tall
  drawUnitHpBar(unit, cx, cy - t*0.75);

  // Death mark
  if (!unit.alive){
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#8a2b1e';
    ctx.lineWidth = 3.5 * unit_s;
    ctx.lineCap = 'round';
    const r = 16 * unit_s;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r * 0.6); ctx.lineTo(cx + r, cy + r * 0.6);
    ctx.moveTo(cx + r, cy - r * 0.6); ctx.lineTo(cx - r, cy + r * 0.6);
    ctx.stroke();
    ctx.restore();
  }
}


function drawFacingChevron(unit, cx, cy, u){
  const f = unit.facing; if (!f) return;
  const ang = Math.atan2(f.dy, f.dx || 0.0001);
  const color = (unit.side === 'player')
    ? 'rgba(255,180,110,0.8)'
    : 'rgba(140,180,220,0.8)';
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(7*u, 0);
  ctx.lineTo(-3*u,  4*u);
  ctx.lineTo(-3*u, -4*u);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawUnitHpBar(unit, cx, topY){
  if (!unit.alive) return;
  const u = T() / 80;
  const w = 28 * u, h = 4 * u;
  const x = cx - w/2;
  // backdrop
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(x - 1, topY - 1, w + 2, h + 2);
  // segments
  const frac = Math.max(0, unit.hp / unit.maxHp);
  let col;
  if (unit.side === 'player'){
    col = frac > 0.5 ? '#e06540' : frac > 0.25 ? '#d98535' : '#8a2b1e';
  } else {
    col = frac > 0.5 ? '#6a9bc8' : frac > 0.25 ? '#4a7bab' : '#2a4a6a';
  }
  ctx.fillStyle = col;
  ctx.fillRect(x, topY, w * frac, h);
  // segment dividers every 1 HP
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 1; i < unit.maxHp; i++){
    const sx2 = x + (i / unit.maxHp) * w;
    ctx.fillRect(sx2 - 0.5, topY, 1, h);
  }
}

/* ---- Floating damage numbers ---- */
const floaters = [];
function addFloater(gx, gy, text, color='#ffe0a0'){
  floaters.push({ x: gx, y: gy, text, color, t: 0, life: 900 });
}
function drawFloaters(dt){
  for (let i = floaters.length - 1; i >= 0; i--){
    const f = floaters[i];
    f.t += dt;
    if (f.t >= f.life){ floaters.splice(i,1); continue; }
    const progress = f.t / f.life;
    const { sx, sy } = gridCenterToCanvas(f.x, f.y);
    const yOff = -T()*0.4 - progress * 40 * camera.scale;
    const alpha = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${Math.round(18 * camera.scale)}px "Cinzel", serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3 * camera.scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(f.text, sx, sy + yOff);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, sx, sy + yOff);
    ctx.restore();
  }
}

/* ============================================================
   MAIN RENDER
   ============================================================ */
let lastFrame = performance.now();
function render(){
  const now = performance.now();
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;

  updateCamera();

  const W = canvas.width / DPR, H = canvas.height / DPR;
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // background pitch
  ctx.fillStyle = '#060403';
  ctx.fillRect(0, 0, W, H);

  // ---- compute tile visible range for culling ----
  const topLeft = { x: (0 - camera.viewW/2)/camera.scale + camera.cx,
                    y: (0 - camera.viewH/2)/camera.scale + camera.cy };
  const botRight= { x: (camera.viewW - camera.viewW/2)/camera.scale + camera.cx,
                    y: (camera.viewH - camera.viewH/2)/camera.scale + camera.cy };
  const gx0 = Math.max(0, Math.floor(topLeft.x / TILE_SIZE) - 1);
  const gy0 = Math.max(0, Math.floor(topLeft.y / TILE_SIZE) - 1);
  const gx1 = Math.min(GRID_SIZE - 1, Math.ceil(botRight.x / TILE_SIZE) + 1);
  const gy1 = Math.min(GRID_SIZE - 1, Math.ceil(botRight.y / TILE_SIZE) + 1);

  // ---- 1) Floor ----
  for (let y = gy0; y <= gy1; y++){
    for (let x = gx0; x <= gx1; x++){
      drawFloorTile(x, y);
    }
  }

  // ---- 2) Torch glow on top of floor, under entities ----
  drawTorches();

  // ---- 3) Movement highlights ----
  drawHighlightsLayer();

  // ---- 4) Entities depth-sorted by world Y (top-down: lower on screen = in front) ----
  const entities = [];
  for (const [k, type] of state.blockedTypes){
    const [x,y] = k.split(',').map(Number);
    entities.push({ gx: x, gy: y, z: y, kind:'obstacle', type });
  }
  for (const u of Object.values(state.units)){
    const ex = u.x + (u.renderOffsetX || 0);
    const ey = u.y + (u.renderOffsetY || 0);
    entities.push({ gx: ex, gy: ey, z: ey + (u.alive ? 0.5 : -1000), kind:'unit', unit: u });
  }
  entities.sort((a,b) => a.z - b.z);
  for (const e of entities){
    if (e.kind === 'obstacle'){
      drawObstacle(e.gx, e.gy, e.type);
    } else {
      const { sx, sy } = gridCenterToCanvas(e.gx, e.gy);
      drawCharacter(e.unit, sx, sy);
    }
  }

  // ---- 5) Vignette overlay ----
  const vg = ctx.createRadialGradient(W/2, H/2, Math.min(W,H)*0.3, W/2, H/2, Math.max(W,H)*0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // ---- 6) Floaters on top ----
  drawFloaters(dt);

  ctx.restore();
}

function drawHighlightsLayer(){
  // Active unit pulse on its tile
  if (state.activeUnit && state.turn === 'player'){
    const u = state.units[state.activeUnit];
    if (u && u.alive){
      drawHighlight(u.x, u.y, 'active');
    }
  }
  // Valid move tiles
  if (state.turn === 'player' && state.subPhase === 'action' && state.activeUnit && state.validTargets){
    for (const [k, info] of state.validTargets){
      if (info.cost === 0) continue;
      const [x, y] = k.split(',').map(Number);
      drawHighlight(x, y, 'valid');
    }
    // Hover path
    if (state.hoverTile){
      const hk = key(state.hoverTile.x, state.hoverTile.y);
      if (state.validTargets.has(hk)){
        const path = state.validTargets.get(hk).path;
        for (let i = 1; i < path.length - 1; i++){
          drawHighlight(path[i].x, path[i].y, 'path');
        }
        drawHighlight(state.hoverTile.x, state.hoverTile.y, 'hover');
        // Path arrows overlaid
        drawPathArrows(path);
      }
    }
  }
}

/* ============================================================
   INPUT
   ============================================================ */
function pointerHandler(ev){
  if (ev.cancelable && ev.preventDefault) ev.preventDefault();
  const p = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
  return canvasToGrid(p.clientX, p.clientY);
}

function handleCanvasPointer(ev, isTap){
  if (state.phase !== 'playing' || state.turn !== 'player' || state.animating) return;
  const { x, y } = pointerHandler(ev);
  if (!inBounds(x,y)){ state.hoverTile = null; return; }
  state.hoverTile = { x, y };
  if (!isTap) return;

  // Tap priority: own unit → activate; valid tile → move; otherwise xTile
  const u = unitAt(x, y);
  if (u && u.side === 'player' && u.alive && !state.unitsActedThisTurn.has(u.id)){
    if (state.subPhase === 'select' || state.subPhase === 'action'){
      selectUnit(u.id);
      return;
    }
  }
  if (state.subPhase === 'action' && state.activeUnit && state.validTargets){
    const k = key(x,y);
    if (state.validTargets.has(k) && state.validTargets.get(k).cost > 0){
      const info = state.validTargets.get(k);
      Audio.play('tile-select');
      commitMove(state.activeUnit, info.path);
    } else {
      Audio.play('xTile');
      flashLog('Invalid tile. Must use the full dice.');
    }
    return;
  }
  Audio.play('xTile');
}

canvas.addEventListener('mousemove', (ev) => {
  if (state.phase !== 'playing') return;
  const { x, y } = pointerHandler(ev);
  state.hoverTile = inBounds(x,y) ? { x, y } : null;
});
canvas.addEventListener('mouseleave', () => { state.hoverTile = null; });
canvas.addEventListener('click', (ev) => handleCanvasPointer(ev, true));
canvas.addEventListener('touchstart', (ev) => handleCanvasPointer(ev, true), { passive:false });
canvas.addEventListener('touchmove',  (ev) => {
  if (state.phase !== 'playing') return;
  const { x, y } = pointerHandler(ev);
  state.hoverTile = inBounds(x,y) ? { x, y } : null;
}, { passive:false });


/* ============================================================
   DICE
   ============================================================ */
function faceHTML(n){
  const pos = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] }[n] || [4];
  let html = '';
  for (let i=0;i<9;i++){
    html += pos.includes(i) ? '<span></span>' : '<span style="opacity:0"></span>';
  }
  return html;
}
function setDiceFace(n){ document.querySelector('.dice-face').innerHTML = faceHTML(n); }

function rollDice(){
  return new Promise(resolve => {
    const cube = document.getElementById('dice-cube');
    Audio.play('dice');
    cube.classList.remove('rolling');
    void cube.offsetWidth;
    cube.classList.add('rolling');
    const interval = setInterval(() => setDiceFace(1 + Math.floor(Math.random()*6)), 90);
    setTimeout(() => {
      clearInterval(interval);
      const n = 1 + Math.floor(Math.random()*6);
      setDiceFace(n);
      cube.classList.remove('rolling');
      resolve(n);
    }, DICE_ROLL_MS);
  });
}

/* ============================================================
   MOVEMENT
   ============================================================ */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function animateMove(unit, path){
  state.animating = true;
  for (let i=1; i<path.length; i++){
    const from = path[i-1], to = path[i];
    const dx = to.x - from.x, dy = to.y - from.y;
    if (dx ===  1) unit.facing = DIR.RIGHT;
    else if (dx === -1) unit.facing = DIR.LEFT;
    else if (dy ===  1) unit.facing = DIR.DOWN;
    else if (dy === -1) unit.facing = DIR.UP;

    const startT = performance.now();
    await new Promise(res => {
      function tick(t){
        const p = Math.min(1, (t - startT) / STEP_MS);
        const e = p*p*(3-2*p);
        unit.renderOffsetX = (to.x - from.x) * e;
        unit.renderOffsetY = (to.y - from.y) * e;
        if (p < 1) requestAnimationFrame(tick);
        else {
          unit.x = to.x; unit.y = to.y;
          unit.renderOffsetX = 0; unit.renderOffsetY = 0;
          res();
        }
      }
      unit.x = from.x; unit.y = from.y;
      unit.renderOffsetX = 0; unit.renderOffsetY = 0;
      requestAnimationFrame(tick);
    });
    Audio.play('walk');
  }
  state.animating = false;
}

async function commitMove(unitId, path){
  const unit = state.units[unitId];
  state.subPhase = 'animating';
  updateUI();
  await animateMove(unit, path);

  // Defensive: ensure coordinates match the intended destination. There's a
  // subtle race window if animation ordering ever changes — pin it explicitly.
  const dest = path[path.length - 1];
  unit.x = dest.x; unit.y = dest.y;
  unit.renderOffsetX = 0; unit.renderOffsetY = 0;
  state.animating = false;

  // Let the render loop settle before resolving combat.
  await new Promise(resolve => requestAnimationFrame(() => resolve()));

  // After move, check if a valid enemy target exists within weapon range
  const entries = enemiesInRange(unit).filter(e => e && e.target && e.target.alive);
  console.debug('post-move combat check', unit.id, { x: unit.x, y: unit.y, entries: entries.map(e => ({ target: e.target.id, intended: e.intendedTarget && e.intendedTarget.id, damage: e.damage, deflected: e.isDeflected })) });
  if (entries.length > 0){
    if (unit.side === 'player'){
      showAttackModal(unit, entries);
    } else {
      // AI: pick the entry that kills or deals most effective HP damage.
      // Prefer killing blows; break ties by avoiding deflected low-damage hits.
      const scored = entries.map(e => {
        let s = e.damage;
        if (e.target.hp <= e.damage) s += 100;             // killing blow
        if (e.target.type === 'mage') s += 5;               // prioritise squishy mage
        if (e.isDeflected) s -= 3;                          // deflection is weak
        return { e, s };
      }).sort((a,b) => b.s - a.s);
      await performAttack(unit, scored[0].e);
      finishUnitAction(unit);
    }
  } else {
    const u = unit.type === 'mage' ? 'Mage' : 'Fighter';
    flashLog(`${u} lands at (${unit.x},${unit.y}) — no foe in reach.`);
    finishUnitAction(unit);
  }
}

/* ============================================================
   COMBAT / HEAL
   ============================================================ */
// v8 attack-range semantics:
//   Fighter — returns enemies orthogonally adjacent (range 1).
//   Mage    — returns all enemies on a cardinal straight line at range 1 or 2.
//             For range-2 line attacks, the intervening tile matters:
//             * Blocked by terrain: the attack line is obstructed — this
//               enemy is NOT returned.
//             * Occupied by another enemy: that blocker becomes the effective
//               target (takes 1 damage instead of the intended), and we return
//               the blocker (not the intended target).
//             * Empty: the enemy at range 2 is returned normally.
// Each entry in the returned list is { target, intendedTarget, isDeflected, damageOverride? }
// v8.1 attack-range semantics (corrected against user's stated rules):
//   Fighter — A battle triggers if any enemy is orthogonally adjacent.
//             Damage as normal (2, halved vs. fighter passive).
//   Mage    — A battle triggers if an enemy is in the mage's straight attack
//             line (range 1 or range 2 on a cardinal axis). At RANGE 1 there
//             is no intervening tile — the attack is a normal direct hit.
//             At RANGE 2 the intervening (range-1) tile matters:
//             * If the intervening tile is blocked by terrain, the attack
//               line fails entirely — this enemy is NOT offered.
//             * If the intervening tile is occupied by another enemy, that
//               blocker "catches" the line: it takes 1 damage instead of the
//               intended target. The intended target is unharmed.
//             * If the intervening tile holds an ally, the line is obstructed
//               (no friendly-fire) — attack option not shown.
//             * Otherwise the range-2 enemy takes normal mage damage (3).
// Each entry returned: { target, intendedTarget, isDeflected, damage }
function enemiesInRange(attacker){
  const all = Object.values(state.units).filter(u => u.alive);
  const out = [];
  const fighterDmg = UNIT_DEFS.fighter.dmg;
  const mageDmg    = UNIT_DEFS.mage.dmg;

  if (attacker.type === 'fighter'){
    for (const e of all){
      if (e.side === attacker.side) continue;
      const dx = e.x - attacker.x, dy = e.y - attacker.y;
      if (Math.abs(dx) + Math.abs(dy) === 1){
        out.push({
          target: e, intendedTarget: e,
          isDeflected: false,
          damage: fighterDmg,
        });
      }
    }
    return out;
  }

  // Mage — scan each cardinal ray (straight attack line, up to range 2).
  // The rule literally: an enemy in the attack line triggers a battle.
  // At range 2 the intervening (range-1) tile matters:
  //   terrain-blocked intervening  → attack fails on that axis.
  //   enemy intervening            → blocker takes 1 dmg INSTEAD of target.
  //   ally intervening             → line obstructed (no friendly-fire).
  // An enemy at range 1 is a straightforward hit (no intervening tile).
  // When BOTH a range-1 enemy and a range-2 enemy exist on the same axis,
  // the player sees two attack options: plain adjacent hit (3 dmg) OR
  // aim-past where the adjacent enemy catches the bolt for 1 dmg (per the
  // "blocking enemy takes 1 damage instead" rule).
  for (const d of DIRS){
    const r1x = attacker.x + d.dx,   r1y = attacker.y + d.dy;
    const r2x = attacker.x + d.dx*2, r2y = attacker.y + d.dy*2;
    if (!inBounds(r1x, r1y)) continue;

    const u1 = all.find(u => u.x === r1x && u.y === r1y);
    const terrain1 = isBlocked(r1x, r1y);
    const r2Inside = inBounds(r2x, r2y);
    const u2 = r2Inside ? all.find(u => u.x === r2x && u.y === r2y) : null;

    if (u1){
      if (u1.side !== attacker.side){
        // Adjacent foe: normal hit option.
        out.push({
          target: u1, intendedTarget: u1,
          isDeflected: false,
          damage: mageDmg,
        });
        // If a range-2 foe sits behind the adjacent foe, the player may
        // instead aim past — the deflection rule triggers: blocker takes 1.
        if (u2 && u2.side !== attacker.side){
          out.push({
            target: u1, intendedTarget: u2,
            isDeflected: true,
            damage: 1,
          });
        }
      }
      // Whether foe or ally, nothing further on this axis.
      continue;
    }

    // Intervening tile is unit-free.
    if (terrain1) continue;     // terrain blocks the ray entirely
    if (!r2Inside) continue;

    // Range 2 shot: target at r2 (clean line).
    if (u2 && u2.side !== attacker.side){
      out.push({
        target: u2, intendedTarget: u2,
        isDeflected: false,
        damage: mageDmg,
      });
    }
  }
  return out;
}

// Legacy helper for places that just want a boolean — returns true if there
// is ANY valid attack line from `attacker` to `target`.
function hasAttackOn(attacker, target){
  const list = enemiesInRange(attacker);
  return list.some(entry => entry.target === target || entry.intendedTarget === target);
}

// Rotate `unit` to face `target` when they're orthogonally aligned.
// For diagonal relationships (mages don't produce these, fighters can't attack them)
// we fall back to the axis of larger magnitude.
function faceToward(unit, target){
  const dx = target.x - unit.x, dy = target.y - unit.y;
  if (dx === 0 && dy === 0) return;
  if (Math.abs(dx) >= Math.abs(dy)){
    unit.facing = dx >= 0 ? DIR.RIGHT : DIR.LEFT;
  } else {
    unit.facing = dy >= 0 ? DIR.DOWN : DIR.UP;
  }
}

// `entry` is the attack-range object returned by enemiesInRange:
//   { target, intendedTarget, isDeflected, damage }
// For back-compat with callers that pass a raw target unit, we synthesize
// a default entry (adjacency-hit, full damage).
async function performAttack(attacker, entryOrTarget){
  let entry;
  if (entryOrTarget && entryOrTarget.target){
    entry = entryOrTarget;
  } else {
    const def = UNIT_DEFS[attacker.type];
    entry = { target: entryOrTarget, intendedTarget: entryOrTarget,
              isDeflected: false, damage: def.dmg };
  }
  const target = entry.target;

  // Auto-face the intended target direction so the sprite points properly.
  faceToward(attacker, entry.intendedTarget || target);

  let damage = entry.damage;
  // Defender passive: fighter halves (round up). Deflected 1-damage hits
  // are already below the passive threshold (Math.ceil(1/2) = 1) — no change.
  if (target.type === 'fighter' && UNIT_DEFS.fighter.passiveHalf && !entry.isDeflected){
    damage = Math.ceil(damage / 2);
  }
  target.hp = Math.max(0, target.hp - damage);
  Audio.play(target.type === 'mage' ? 'hit-mage' : 'hit');
  addFloater(target.x, target.y, `-${damage}`, entry.isDeflected ? '#ffb870' : '#ff8866');
  if (entry.isDeflected && entry.intendedTarget !== target){
    flashLog(`${label(attacker)}'s bolt is caught by ${label(target)} (${damage} dmg — ${label(entry.intendedTarget)} safe).`);
  } else if (entry.isDeflected){
    flashLog(`${label(attacker)}'s bolt grazes ${label(target)} (${damage} dmg).`);
  } else {
    flashLog(`${label(attacker)} strikes ${label(target)} for ${damage}.`);
  }
  updateHpUI();

  await sleep(650);

  if (target.hp <= 0){
    target.alive = false;
    Audio.play('death');
    addFloater(target.x, target.y, 'SLAIN', '#ff4030');
    flashLog(`${label(target)} falls.`);
    updateHpUI();
    await sleep(700);
  }
}

async function performHeal(healer, target){
  const def = UNIT_DEFS[healer.type];
  const amt = Math.min(def.heal, target.maxHp - target.hp);
  target.hp += amt;
  Audio.play('heal');
  addFloater(target.x, target.y, `+${amt}`, '#a0ffb0');
  flashLog(`${label(healer)} mends ${label(target)} for ${amt}.`);
  updateHpUI();
  await sleep(700);
}

function label(unit){
  const name = unit.type === 'mage' ? 'Mage' : 'Fighter';
  return `${unit.side === 'player' ? 'Your' : 'AudWeak'} ${name}`;
}

/* ============================================================
   HEAL ELIGIBILITY
   ============================================================ */
function canHeal(mage){
  if (mage.type !== 'mage' || !mage.alive) return false;
  const allies = Object.values(state.units).filter(u =>
    u.alive && u.side === mage.side);
  return allies.some(a => a.hp < a.maxHp);
}

/* ============================================================
   TURN / PHASE MANAGEMENT
   ------------------------------------------------------------
   Each unit rolls its OWN dice. Flow per side's turn:
     select → (tap a unit) → active+roll → (roll) → active+action → (move) → finish
                                                                           ↓
                               another alive unit un-acted? → loop to select
                                                           else → end turn
   ============================================================ */
function startPlayerTurn(){
  state.turn = 'player';
  state.subPhase = 'select';
  state.dice = 0;
  state.activeUnit = null;
  state.validTargets = null;
  state.unitsActedThisTurn = new Set();
  setDiceFace(1);
  flashLog('Your move. Tap a hero to activate.');
  updateUI();
}

// Called after the player rolls dice for the ACTIVE unit.
function playerRolled(n){
  state.dice = n;
  state.subPhase = 'action';
  const u = state.units[state.activeUnit];
  if (!u){ updateUI(); return; }
  state.validTargets = tilesReachableExact(u.x, u.y, n, u.id);
  const name = u.type === 'mage' ? 'Mage' : 'Fighter';
  const entriesNow = enemiesInRange(u);
  if (entriesNow.length > 0){
    flashLog(`${name} rolled ${n}. Foe already in reach — attack or move.`);
  } else if (state.validTargets.size === 0 ||
      (state.validTargets.size === 1 && state.validTargets.has(key(u.x,u.y)))){
    flashLog(`${name} rolled ${n} but cannot move that far. End hero's turn?`);
  } else {
    flashLog(`${name} rolled ${n}. Tap a tile to move exactly ${n} tiles.`);
  }
  updateUI();
  // If adjacent to an enemy after rolling, auto-pop the battle modal. Skip
  // preserves the roll so the player can still move.
  if (entriesNow.length > 0){
    setTimeout(() => {
      if (state.activeUnit === u.id && state.subPhase === 'action'){
        const fresh = enemiesInRange(u);
        if (fresh.length > 0) showAttackModal(u, fresh, { endOnSkip: false });
      }
    }, 60);
  }
}

// Player taps a hero in the bottom HUD (or on the map).
// New rule: activating a unit ALWAYS resets dice for that unit.
function selectUnit(unitId){
  const u = state.units[unitId];
  if (!u || !u.alive || u.side !== 'player') return;
  if (state.unitsActedThisTurn.has(unitId)) return;
  if (state.animating) return;
  // Only allow activation when we're idle between actions
  if (state.subPhase !== 'select') return;

  Audio.play('select');
  state.activeUnit = unitId;
  state.subPhase = 'roll';     // waiting for this unit to roll
  state.dice = 0;
  state.validTargets = null;
  setDiceFace(1);
  const name = u.type === 'mage' ? 'Mage' : 'Fighter';
  const entriesNow = enemiesInRange(u);
  if (entriesNow.length > 0){
    flashLog(`${name} selected — foe in reach, but you must roll first.`);
  } else if (u.type === 'mage' && canHeal(u)){
    flashLog(`${name} selected. Roll the dice, or tap Heal.`);
  } else {
    flashLog(`${name} selected. Roll the dice to move.`);
  }
  updateUI();
}

// Called after any action (move+attack, skip, or heal) completes.
// If the OTHER unit is still eligible, return to 'select'.
// Otherwise end the turn.
function finishUnitAction(unit){
  state.unitsActedThisTurn.add(unit.id);
  state.activeUnit = null;
  state.validTargets = null;
  state.dice = 0;
  setDiceFace(1);
  if (checkEndGame()) return;

  const mySide = unit.side;
  const otherUnits = Object.values(state.units).filter(u =>
    u.side === mySide && u.alive && !state.unitsActedThisTurn.has(u.id));

  if (otherUnits.length > 0){
    // Stay in the same player's/side's turn, back to select
    if (mySide === 'player'){
      state.subPhase = 'select';
      flashLog('Tap your other hero, or End Turn.');
      updateUI();
    } else {
      // AI side: immediately let the AI pick its next actor
      state.subPhase = 'select';
      updateUI();
      setTimeout(() => aiTakeNextAction(), 450);
    }
  } else {
    // Side is done
    if (mySide === 'player') endPlayerTurn();
    else endEnemyTurn();
  }
}

function endPlayerTurn(){
  if (checkEndGame()) return;
  state.subPhase = 'resolving';
  state.activeUnit = null;
  state.validTargets = null;
  state.dice = 0;
  updateUI();
  setTimeout(() => startEnemyTurn(), 500);
}

function startEnemyTurn(){
  state.turn = 'enemy';
  state.subPhase = 'select';
  state.dice = 0;
  state.activeUnit = null;
  state.validTargets = null;
  state.unitsActedThisTurn = new Set();
  setDiceFace(1);
  updateUI();
  flashLog('AudWeak considers…');
  setTimeout(() => aiTakeNextAction(), 700);
}

function endEnemyTurn(){
  if (checkEndGame()) return;
  startPlayerTurn();
}

function checkEndGame(){
  const pAlive = ['p-fighter','p-mage'].some(id => state.units[id] && state.units[id].alive);
  const eAlive = ['e-fighter','e-mage'].some(id => state.units[id] && state.units[id].alive);
  if (!pAlive){ endGame(false); return true; }
  if (!eAlive){ endGame(true);  return true; }
  return false;
}

/* ============================================================
   AI
   ------------------------------------------------------------
   For each alive enemy unit candidate:
     - Fighter:
        * Find tiles reachable in exactly `dice` steps that put it adjacent
          AND facing a player unit (=> attack). Prefer this.
        * Otherwise find the tile that minimizes BFS distance to the closest
          player unit (to set up next turn).
     - Mage:
        * If any ally below max HP and critical, heal instead of moving (no roll needed).
        * Otherwise find tiles reachable in exactly `dice` that put it in
          range 1 or 2 of a player unit (=> attack).
        * Otherwise minimize distance to nearest foe.
   NEW in v5: Each unit rolls its OWN dice. The AI picks one unit to act, rolls,
   then chooses the best concrete action with that specific roll.
   ============================================================ */

// Core scoring — given a specific dice roll and specific acting unit,
// enumerate all move destinations + optional heal and return the best candidate.
function aiBestActionFor(me, roll, foes, allUnits){
  const candidates = [];

  // HEAL option for mage (doesn't use dice — always available if anyone hurt)
  if (me.type === 'mage' && canHeal(me)){
    for (const a of allUnits.filter(u => u.alive && u.side === me.side && u.hp < u.maxHp)){
      const missing = a.maxHp - a.hp;
      const crit = a.hp <= 4 ? 30 : 0;
      candidates.push({ kind:'heal', unit:me, target:a, score: missing*3 + crit });
    }
  }

  // MOVE options — exact `roll` steps
  const reach = tilesReachableExact(me.x, me.y, roll, me.id);
  for (const [k, info] of reach){
    if (info.cost !== roll) continue;
    const [x,y] = k.split(',').map(Number);

    // Temporarily move `me` to (x,y) to get accurate range entries under the
    // new v8 rules (deflection, terrain block, etc). Restore after scoring.
    const origX = me.x, origY = me.y;
    me.x = x; me.y = y;
    const entries = enemiesInRange(me);
    me.x = origX; me.y = origY;

    let score = 0;
    if (entries.length){
      // Evaluate best attack outcome from this tile
      let best = null, bestV = -Infinity;
      for (const entry of entries){
        let effDmg = entry.damage;
        // account for fighter passive halving when not deflected
        if (entry.target.type === 'fighter' && !entry.isDeflected){
          effDmg = Math.ceil(effDmg / 2);
        }
        let v = effDmg * 8;
        if (entry.target.hp <= effDmg) v += 80;              // killing blow
        if (entry.target.type === 'mage') v += 10;           // prioritise squishy mage
        if (entry.isDeflected) v -= 4;                        // deflect is usually weaker
        if (v > bestV){ bestV = v; best = entry; }
      }
      score += 40 + bestV;
    } else {
      // No attack option — score by distance to nearest foe
      let minDist = Infinity;
      for (const foe of foes){
        minDist = Math.min(minDist, Math.abs(x - foe.x) + Math.abs(y - foe.y));
      }
      score -= minDist * 2;
      if (me.type === 'mage'){
        // Mage wants a clear 2-tile line; prefers distance 2
        if (minDist === 2) score += 6;
        if (minDist >= 1 && minDist <= 2) score += 3;
      }
    }
    candidates.push({ kind:'move', unit:me, path: info.path, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a,b) => b.score - a.score);
  return candidates[0];
}

// Estimate a unit's "upside" over all possible rolls (1..6).
// Used to pick which unit to activate first when multiple are eligible.
function aiEstimateUnitUpside(me, foes, allUnits){
  let best = -Infinity;
  for (let r = 1; r <= 6; r++){
    const a = aiBestActionFor(me, r, foes, allUnits);
    if (a && a.score > best) best = a.score;
  }
  // If the mage has a critical heal available (no roll needed), factor it in
  if (me.type === 'mage' && canHeal(me)){
    const crit = allUnits.find(u => u.alive && u.side === me.side && u.hp <= 4);
    if (crit) best = Math.max(best, 110);
  }
  return best;
}

// Entry point: called whenever the AI needs to pick & act on its next unit.
async function aiTakeNextAction(){
  if (state.phase !== 'playing' || state.turn !== 'enemy') return;

  const myUnits = ['e-fighter','e-mage']
    .map(id => state.units[id]).filter(u => u && u.alive && !state.unitsActedThisTurn.has(u.id));
  const foes = ['p-fighter','p-mage']
    .map(id => state.units[id]).filter(u => u && u.alive);
  if (myUnits.length === 0 || foes.length === 0){ endEnemyTurn(); return; }

  // Pick the unit with the best expected upside across all dice values.
  const allUnits = Object.values(state.units);
  const scored = myUnits.map(u => ({ u, upside: aiEstimateUnitUpside(u, foes, allUnits) }));
  scored.sort((a,b) => b.upside - a.upside);
  const me = scored[0].u;

  state.activeUnit = me.id;
  state.subPhase = 'roll';
  updateUI();
  flashLog(`${label(me)} steps forward…`);
  await sleep(400);

  // If the mage would prefer a critical heal, do it now (no roll needed)
  if (me.type === 'mage' && canHeal(me)){
    const critically = Object.values(state.units).find(u =>
      u.alive && u.side === me.side && u.hp <= 4);
    if (critically){
      flashLog(`${label(me)} weaves mending light…`);
      await performHeal(me, critically);
      finishUnitAction(me);
      return;
    }
  }

  // Roll dice for this specific unit
  Audio.play('ui-click');
  const roll = await rollDice();
  state.dice = roll;
  state.subPhase = 'action';
  updateUI();
  flashLog(`${label(me)} rolls ${roll}.`);
  await sleep(AI_THINK_MS);

  // Pick best concrete action for this specific roll
  const action = aiBestActionFor(me, roll, foes, allUnits);
  if (!action){
    flashLog(`${label(me)} finds no path.`);
    await sleep(500);
    finishUnitAction(me);
    return;
  }

  if (action.kind === 'heal'){
    flashLog(`${label(me)} weaves mending light…`);
    await performHeal(action.unit, action.target);
    finishUnitAction(action.unit);
  } else {
    flashLog(`${label(me)} moves.`);
    commitMove(action.unit.id, action.path);
  }
}

/* ============================================================
   MODAL — ATTACK / SKIP
   ============================================================ */
const modalAttack = document.getElementById('modal-attack');
const modalHeal   = document.getElementById('modal-heal');

function showAttackModal(attacker, entries, opts){
  opts = opts || {};
  // When opened reactively after a move commits, Skip should finish the unit's
  // action (the hero already used its dice to move). When opened proactively
  // (before the hero moved/rolled), Skip should return to normal flow so the
  // player can still move, heal, or do nothing.
  const endOnSkip = opts.endOnSkip !== false; // default true

  // If we're opening proactively, remember the subPhase so we can restore it.
  const prevSubPhase  = state.subPhase;
  const prevValidTgts = state.validTargets;
  state.subPhase = 'resolving';

  const attackTitleEl = $id('attack-title');
  const attackSubEl = $id('attack-sub');
  const attackDmgEl = $id('attack-dmg');
  if (!modalAttack || !attackTitleEl || !attackSubEl || !attackDmgEl) {
    console.warn('Attack modal elements missing; falling back to immediate attack.');
    if (entries && entries.length) { performAttack(attacker, entries[0]).then(() => finishUnitAction(attacker)); }
    return;
  }
  attackTitleEl.textContent = attacker.type === 'mage' ? 'CAST?' : 'STRIKE?';
  // Renderable display damage (accounting for fighter passive halving on non-deflected hits)
  function displayDamage(entry){
    let d = entry.damage;
    if (entry.target.type === 'fighter' && !entry.isDeflected){
      d = Math.ceil(d / 2);
    }
    return d;
  }
  if (entries.length === 1){
    const e = entries[0];
    const deflectNote = e.isDeflected ? ' — DEFLECTED' : '';
    attackSubEl.textContent = `${label(e.target)} in reach (HP ${e.target.hp}/${e.target.maxHp})${deflectNote}.`;
  } else {
    attackSubEl.textContent = 'Multiple foes in range — choose your target.';
  }
  attackDmgEl.textContent = '';

  const actionsDiv = modalAttack.querySelector('.modal-actions');
  actionsDiv.innerHTML = '';
  actionsDiv.classList.remove('single','stack');

  function onAttackChoice(entry){
    return async () => {
      hideModal(modalAttack);
      Audio.play('ui-click');
      await performAttack(attacker, entry);
      finishUnitAction(attacker);
    };
  }
  function onSkip(){
    hideModal(modalAttack);
    Audio.play('ui-click');
    if (endOnSkip){
      flashLog(`${label(attacker)} holds.`);
      finishUnitAction(attacker);
    } else {
      state.subPhase = prevSubPhase;
      state.validTargets = prevValidTgts;
      flashLog(`${label(attacker)} holds — still your turn.`);
      updateUI();
    }
  }

  // Build a button for each attack entry
  function buildAttackBtn(entry){
    const b = document.createElement('button');
    b.className = 'modal-btn primary';
    const glyph = attacker.type === 'mage' ? '✸' : '⚔';
    const tname = entry.target.type === 'mage' ? 'MAGE' : 'FIGHTER';
    const dmg = displayDamage(entry);
    let label1, sub;
    if (entry.isDeflected && entry.intendedTarget !== entry.target){
      // Trying range-2 but blocker catches it
      label1 = `AIM PAST ${tname}`;
      sub = `Blocker takes ${dmg} · HP ${entry.target.hp}/${entry.target.maxHp}`;
    } else if (entry.isDeflected){
      label1 = `GRAZE ${tname}`;
      sub = `${dmg} dmg · HP ${entry.target.hp}/${entry.target.maxHp}`;
    } else {
      label1 = `ATTACK ${tname}`;
      sub = `${dmg} dmg · HP ${entry.target.hp}/${entry.target.maxHp}`;
    }
    b.innerHTML = `<span class="mb-glyph">${glyph}</span>
                   <span class="mb-label">${label1}</span>
                   <span class="mb-sub">${sub}</span>`;
    b.onclick = onAttackChoice(entry);
    return b;
  }

  if (entries.length === 1){
    const atk = buildAttackBtn(entries[0]);
    const skip = document.createElement('button');
    skip.className = 'modal-btn ghost';
    skip.innerHTML = `<span class="mb-glyph">↩</span>
                      <span class="mb-label">SKIP</span>
                      <span class="mb-sub">${endOnSkip ? 'no strike' : 'keep moving'}</span>`;
    skip.onclick = onSkip;
    actionsDiv.appendChild(atk);
    actionsDiv.appendChild(skip);
  } else {
    actionsDiv.classList.add('stack');
    for (const e of entries) actionsDiv.appendChild(buildAttackBtn(e));
    const skip = document.createElement('button');
    skip.className = 'modal-btn ghost';
    skip.innerHTML = `<span class="mb-glyph">↩</span><span class="mb-label">SKIP</span><span class="mb-sub">${endOnSkip ? 'no strike' : 'keep moving'}</span>`;
    skip.onclick = onSkip;
    actionsDiv.appendChild(skip);
  }

  showModal(modalAttack);
}

function showHealModal(mage){
  const allies = Object.values(state.units).filter(u =>
    u.alive && u.side === mage.side);
  const div = document.getElementById('heal-targets');
  div.innerHTML = '';
  div.classList.remove('single','stack');
  div.classList.add('stack');
  for (const a of allies){
    const full = a.hp >= a.maxHp;
    const b = document.createElement('button');
    b.className = 'modal-btn heal-target';
    const glyph = a.type === 'mage' ? '✷' : '⚔';
    const self = a.id === mage.id ? ' (self)' : '';
    b.innerHTML = `<span class="mb-glyph">${glyph}</span>
                   <span class="mb-label">${a.type === 'mage' ? 'MAGE' : 'FIGHTER'}${self}</span>
                   <span class="mb-sub">HP ${a.hp}/${a.maxHp}</span>`;
    if (full) b.disabled = true;
    b.onclick = async () => {
      hideModal(modalHeal);
      Audio.play('ui-click');
      state.subPhase = 'resolving';
      updateUI();
      await performHeal(mage, a);
      finishUnitAction(mage);
    };
    div.appendChild(b);
  }
  showModal(modalHeal);
}

function showModal(m){ m.classList.add('active'); m.setAttribute('aria-hidden','false'); }
function hideModal(m){ m.classList.remove('active'); m.setAttribute('aria-hidden','true'); }

document.getElementById('btn-heal-cancel').addEventListener('click', () => {
  Audio.play('ui-click');
  hideModal(modalHeal);
});

/* ============================================================
   UI UPDATE
   ============================================================ */
function updateUI(){
  const ti = $id('turn-indicator');
  const tt = ti ? ti.querySelector('.turn-text') : null;
  if (!ti || !tt) return;
  if (state.turn === 'player'){
    ti.classList.remove('enemy');
    tt.textContent = 'YOUR TURN';
  } else {
    ti.classList.add('enemy');
    tt.textContent = 'AUDWEAK';
  }

  // Moves-left display
  const m = document.getElementById('moves-left');
  if (m) m.textContent = (state.dice > 0) ? `${state.dice}` : '—';

  // Dice button — only when a unit is active and waiting for its roll
  const btnDice = document.getElementById('btn-dice');
  if (btnDice) btnDice.disabled = !(state.turn === 'player'
                     && state.subPhase === 'roll'
                     && state.activeUnit
                     && !state.animating);

  // End turn button — ALWAYS enabled during the player's turn, regardless of
  // phase/animation state. Required by v8 UX rules.
  const btnEnd = document.getElementById('btn-endturn');
  if (btnEnd) btnEnd.disabled = !(state.turn === 'player' && state.phase === 'playing');

  // Heal button (mage only) — available whenever mage is active (before OR
  // after the roll), as long as an ally is below full HP.
  const btnHeal = document.getElementById('btn-heal');
  let showHeal = false;
  if (state.turn === 'player'
      && (state.subPhase === 'roll' || state.subPhase === 'action')
      && state.activeUnit && !state.animating){
    const u = state.units[state.activeUnit];
    if (u && u.type === 'mage' && u.alive && canHeal(u)) showHeal = true;
  }
  if (btnHeal) btnHeal.hidden = !showHeal;

  // Attack button — only after the active hero has rolled this turn.
  // Mere adjacency at turn start must not auto-trigger combat.
  const btnAttack = document.getElementById('btn-attack-action');
  let showAttack = false;
  if (state.turn === 'player'
      && state.subPhase === 'action'
      && state.activeUnit && !state.animating){
    const u = state.units[state.activeUnit];
    if (u && u.alive && enemiesInRange(u).length > 0) showAttack = true;
  }
  if (btnAttack) btnAttack.hidden = !showAttack;

  // Unit rows in bottom HUD
  for (const id of Object.keys(state.units)){
    const row = document.getElementById('unit-' + id);
    if (!row) continue;
    const u = state.units[id];
    row.classList.toggle('active', state.activeUnit === id);
    row.classList.toggle('dead', !u.alive);
  }

  updateHpUI();
  positionActionDock();
}

function updateHpUI(){
  for (const id of Object.keys(state.units)){
    const u = state.units[id];
    const fill = document.querySelector(`[data-hp="${id}"]`);
    const text = document.querySelector(`[data-hptext="${id}"]`);
    if (fill){
      const pct = u.alive ? (u.hp / u.maxHp * 100) : 0;
      fill.style.width = pct + '%';
    }
    if (text) text.textContent = `${u.alive ? u.hp : 0}/${u.maxHp}`;
  }
}

function positionActionDock(){
  const hud = document.querySelector('.hud-bottom');
  if (!hud) return;
  document.documentElement.style.setProperty('--hud-bottom-h', hud.offsetHeight + 'px');
}

let logTimer = null;
function flashLog(msg){
  clearTimeout(logTimer);
  const logEl = $id('log'); if (logEl) logEl.textContent = msg;
}

/* ============================================================
   INIT
   ============================================================ */
function createUnit(id, side, type, x, y, facing){
  const def = UNIT_DEFS[type];
  return {
    id, side, type, x, y, facing,
    hp: def.maxHp, maxHp: def.maxHp,
    dmg: def.dmg, range: def.range, heal: def.heal,
    alive: true,
    renderOffsetX: 0, renderOffsetY: 0,
  };
}

function initGame(){
  state.units = {
    'p-fighter': createUnit('p-fighter', 'player', 'fighter', 1, GRID_SIZE - 2, DIR.RIGHT),
    'p-mage':    createUnit('p-mage',    'player', 'mage',    1, GRID_SIZE - 4, DIR.RIGHT),
    'e-fighter': createUnit('e-fighter', 'enemy',  'fighter', GRID_SIZE - 2, 1, DIR.LEFT),
    'e-mage':    createUnit('e-mage',    'enemy',  'mage',    GRID_SIZE - 2, 3, DIR.LEFT),
  };

  generateBlocked(Object.values(state.units).map(u => ({x:u.x,y:u.y})));
  computeTorchPositions();

  state.phase = 'playing';
  state.subPhase = 'roll';
  state.dice = 0;
  state.activeUnit = null;
  state.validTargets = null;
  state.unitsActedThisTurn = new Set();
  setDiceFace(1);

  // Snap camera to player fighter start position so there's no opening pan
  const pf = state.units['p-fighter'];
  if (pf){
    camera.cx = camera.targetCx = pf.x * TILE_SIZE + TILE_SIZE/2;
    const initialY = isCompactLandscape()
      ? (pf.y * TILE_SIZE + TILE_SIZE/2) * 0.6 + (GRID_SIZE * TILE_SIZE * 0.72) * 0.4
      : (pf.y * TILE_SIZE + TILE_SIZE/2);
    camera.cy = camera.targetCy = initialY;
  }

  requestAnimationFrame(() => { resizeCanvas(); updateUI(); });
  startPlayerTurn();
}

function endGame(won){
  state.phase = 'ended';
  state.animating = false;
  Audio.stopBGM();
  setTimeout(() => {
    showScreen('endscreen');
    const emblem = document.getElementById('end-emblem');
    const title  = document.getElementById('end-title');
    const sub    = document.getElementById('end-sub');
    const screen = document.getElementById('endscreen');
    if (!screen || !emblem || !title || !sub) return;
    if (won){
      screen.classList.remove('lose');
      emblem.textContent = '✦';
      title.textContent  = 'YOU WIN';
      sub.textContent    = 'AudWeak falls. The causeway is yours.';
    } else {
      screen.classList.add('lose');
      emblem.textContent = '✟';
      title.textContent  = 'YOU LOSE';
      sub.textContent    = 'Your heroes fall. AudWeak stands victorious.';
    }
  }, 600);
}

function showScreen(id){
  ['lobby','game','endscreen'].forEach(s => {
    const screenEl = $id(s); if (screenEl) screenEl.classList.toggle('active', s === id);
  });
}

/* ============================================================
   WIRING
   ============================================================ */
// ===== LOBBY BUTTONS =====
document.getElementById('btn-play-ai').addEventListener('click', async () => {
  Audio.resume();
  Audio.play('ui-click');
  Audio.startBGM();
  const btn = document.getElementById('btn-play-ai');
  const label = btn.querySelector('.btn-label');
  const origLabel = label.textContent;
  if (!Assets.ready()){
    label.textContent = 'LOADING…';
    btn.disabled = true;
    await Assets.loadAll();
    label.textContent = origLabel;
    btn.disabled = false;
  }
  showScreen('game');
  initGame();
});

// Create/Join disabled but still give a gentle tap response
document.getElementById('btn-create-game').addEventListener('click', () => {
  Audio.play('xTile');
});
document.getElementById('btn-join-game').addEventListener('click', () => {
  Audio.play('xTile');
});

// Exit Game: attempt window.close(); fall back to a modal if the browser
// refuses (which it will in most cases where the tab wasn't opened by script).
document.getElementById('btn-exit-game').addEventListener('click', () => {
  Audio.play('ui-click');
  try { window.close(); } catch (_) {}
  // window.close() on tabs not opened by script is silently ignored. Give
  // the browser a moment; if we're still here, show the fallback.
  setTimeout(() => {
    if (!document.hidden){
      showModal(document.getElementById('modal-close-tab'));
    }
  }, 180);
});
document.getElementById('btn-close-tab-ack').addEventListener('click', () => {
  Audio.play('ui-click');
  hideModal(document.getElementById('modal-close-tab'));
});

// In-game Exit-to-Lobby button + confirmation
document.getElementById('btn-exit-lobby').addEventListener('click', () => {
  Audio.play('ui-click');
  showModal(document.getElementById('modal-exit'));
});
document.getElementById('btn-exit-no').addEventListener('click', () => {
  Audio.play('ui-click');
  hideModal(document.getElementById('modal-exit'));
});
document.getElementById('btn-exit-yes').addEventListener('click', () => {
  Audio.play('ui-click');
  hideModal(document.getElementById('modal-exit'));
  // Hide any other open modal (attack, heal)
  hideModal(document.getElementById('modal-attack'));
  hideModal(document.getElementById('modal-heal'));
  Audio.stopBGM();
  state.phase = 'lobby';
  state.animating = false;
  state.activeUnit = null;
  state.validTargets = null;
  showScreen('lobby');
});

document.getElementById('btn-return').addEventListener('click', () => {
  Audio.play('ui-click');
  Audio.stopBGM();
  showScreen('lobby');
  state.phase = 'lobby';
});

document.getElementById('btn-dice').addEventListener('click', async () => {
  if (state.phase !== 'playing' || state.turn !== 'player') return;
  if (state.subPhase !== 'roll' || state.animating) return;
  Audio.play('ui-click');
  const n = await rollDice();
  playerRolled(n);
});

document.getElementById('btn-endturn').addEventListener('click', () => {
  if (state.phase !== 'playing' || state.turn !== 'player') return;
  // Don't interrupt a running animation or open modal
  if (state.animating) return;
  if (document.getElementById('modal-attack').classList.contains('active')) return;
  if (document.getElementById('modal-heal').classList.contains('active')) return;
  Audio.play('ui-click');
  flashLog('You end your turn.');
  state.activeUnit = null;
  state.validTargets = null;
  endPlayerTurn();
});

document.getElementById('btn-heal').addEventListener('click', () => {
  if (state.turn !== 'player' || !state.activeUnit) return;
  const u = state.units[state.activeUnit];
  if (!u || u.type !== 'mage' || !canHeal(u)) return;
  Audio.play('ui-click');
  showHealModal(u);
});

document.getElementById('btn-attack-action').addEventListener('click', () => {
  if (state.turn !== 'player' || !state.activeUnit || state.animating) return;
  const u = state.units[state.activeUnit];
  if (!u || !u.alive) return;
  const targets = enemiesInRange(u);
  if (targets.length === 0){
    Audio.play('xTile');
    flashLog('No foes in range.');
    return;
  }
  Audio.play('ui-click');
  // If the player picks Attack, they commit (finishes action).
  // If they hit Skip, we close the modal and let them continue (roll/move/heal).
  showAttackModal(u, targets, { endOnSkip: false });
});

// Unit row clicks (bottom HUD) - tap to activate
for (const id of ['p-fighter','p-mage']){
  const row = document.getElementById('unit-' + id);
  if (!row) continue;
  row.addEventListener('click', () => {
    if (state.phase !== 'playing' || state.turn !== 'player' || state.animating) return;
    if (state.subPhase !== 'select' && state.subPhase !== 'action') return;
    const u = state.units[id];
    if (!u || !u.alive) return;
    if (state.unitsActedThisTurn.has(id)){
      flashLog('This hero has already acted this turn.');
      return;
    }
    selectUnit(id);
  });
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
function loop(){
  if (state.phase === 'playing' || state.phase === 'ended'){
    render();
  }
  requestAnimationFrame(loop);
}
window.addEventListener('load', () => {
  resizeCanvas();
  setDiceFace(1);
  loop();
});
document.addEventListener('gesturestart', e => e.preventDefault());

})();
