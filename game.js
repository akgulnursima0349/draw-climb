'use strict';

// ─── Matter.js ───────────────────────────────────────────────────────────────
const { Engine, Runner, Bodies, Body, Composite, Constraint } = Matter;

// ─── Constants ───────────────────────────────────────────────────────────────
const DRAW_THICKNESS = 4;
const DRAW_MIN_DIST  = 8;
const CAR_SPEED      = 0.22;
const GRAVITY_DEF    = 1.0;
const GRID           = 60;   // arka plan ızgara kare boyutu
const TILE           = 100;  // engel tile görsel boyutu
const TILE_PHY       = 80;   // engel tile fizik çarpışma boyutu (görsel taş ~80px, etraf şeffaf ~10px)
const FINISH_W       = 80;   // bitiş bayrağı genişliği
const FINISH_H       = 130;  // bitiş bayrağı yüksekliği
const CAR_W          = 140;
const CAR_H          = 50;
const WHEEL_R        = 18;   // physics collision radius
const WHEEL_VR       = 18;   // visual draw radius — fizik yarıçapıyla eşleştirildi (yüzey teması için)
const MAX_INK        = 3500; // toplam çizim mesafesi (piksel) — mürekkep göstergesi
const INK_BAR_X      = 10;   // mürekkep çubuğu sol kenar
const INK_BAR_Y      = 8;    // mürekkep çubuğu üst kenar
const INK_BAR_W      = 210;  // mürekkep çubuğu genişliği
const INK_BAR_H      = 16;   // mürekkep çubuğu yüksekliği

// Collision categories
const CAT_ENV  = 0x0001;
const CAT_CAR  = 0x0002;
const CAT_DRAW = 0x0004;
const CAT_BALL = 0x0008;

// ─── State ───────────────────────────────────────────────────────────────────
let engine, runner, world;
let car         = null;   // { chassis, wheelL, wheelR }
let drawBodies  = [];     // player-drawn static bodies
let drawStrokes = [];     // her çizim hamlesi ayrı grup [ [body,...], ... ]
let levelBodies = [];     // obstacle + boundary bodies
let specials    = [];     // active special-item descriptors
let prevPt      = null;
let isDrawing   = false;
let gameStarted = false;
let finished    = false;
let currentLvl  = 0;
let gravInverted = false;
let failCooldown = 0;
let finishRect  = null;   // { x, y, w, h } world coords (centre)
let tutAnim     = null;   // tutorial hand animation state (level 1 only)
let confetti    = [];     // confetti particles on win
let inkUsed          = 0;     // kullanılan mürekkep miktarı (piksel toplamı)
let itemBonusStars   = 0;     // item kullanımından gelen bonus yıldız
let rocketBonusGiven  = false;
let gravityBonusGiven = false;
let boostBonusGiven   = false;
let levelStars = {};          // { levelIndex: bestStars } — localStorage'a kaydedilir

// ─── Canvas ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');
let W = 0, H = 0;

function resizeCanvas() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
}

// ─── Image Loading ────────────────────────────────────────────────────────────
const IMG = {};

function loadImages() {
  return new Promise(res => {
    const map = {
      carBody: 'car-body.png',
      wheel:   'wheel.png',
      wall:    'wall.png',
      finish:  'finish.png',
      bg:      'backround.png'
    };
    let n = 0;
    const total = Object.keys(map).length;
    for (const [k, src] of Object.entries(map)) {
      IMG[k] = new Image();
      IMG[k].onload = IMG[k].onerror = () => { if (++n === total) res(); };
      IMG[k].src = src;
    }
  });
}

// ─── Sound System ────────────────────────────────────────────────────────────
const SFX = {};

function loadSounds() {
  const files = {
    engineStart:  'sounds/engine-start.mp3',
    celebration:  'sounds/celebration.mp3',
    star1:        'sounds/star.mp3',
    star2:        'sounds/star.mp3',
    star3:        'sounds/star.mp3'
  };
  for (const [key, src] of Object.entries(files)) {
    const a   = new Audio(src);
    a.preload = 'auto';
    SFX[key]  = a;
  }
}

function playSound(key, volume = 1.0) {
  const sfx = SFX[key];
  if (!sfx) return;
  try {
    sfx.currentTime = 0;
    sfx.volume      = Math.min(1, Math.max(0, volume));
    sfx.play().catch(() => {});   // autoplay policy hatalarını yoksay
  } catch(e) {}
}

function stopSound(key) {
  const sfx = SFX[key];
  if (!sfx) return;
  try { sfx.pause(); sfx.currentTime = 0; } catch(e) {}
}

// ─── Physics ─────────────────────────────────────────────────────────────────
function initPhysics() {
  engine = Engine.create({ gravity: { y: GRAVITY_DEF } });
  world  = engine.world;
  runner = Runner.create();
  Runner.run(runner, engine);
}

// ─── Car ─────────────────────────────────────────────────────────────────────
// Axle positions — adjusted for transparent padding in car-body.png.
// Car body occupies the inner ~55% of the image width, so arches are
// much closer to the chassis centre than raw image-percentage would suggest.
const AXLE_FRONT = CAR_W * 0.15;   // ~21 px – front wheel offset
const AXLE_REAR  = CAR_W * 0.171;  // ~24 px – rear wheel offset
const AXLE_X     = (AXLE_FRONT + AXLE_REAR) / 2;  // avg for symmetric fallback
const AXLE_Y     = CAR_H * 0.46;   // 23 px – arch centre below chassis centre
const WHEEL_DROP = AXLE_Y;         // wheel physics body placed at arch centre

function createCar(x, y) {
  const grp = Body.nextGroup(true); // negative group = no intra-car collision

  const chassis = Bodies.rectangle(x, y, CAR_W, CAR_H, {
    label:       'chassis',
    friction:    0.05,
    frictionAir: 0.018,
    density:     0.002,
    restitution: 0.05,
    collisionFilter: { group: grp, category: CAT_CAR, mask: CAT_ENV | CAT_DRAW }
  });

  const wOpts = {
    label:          'wheel',
    friction:       0.95,
    frictionStatic: 1.0,
    frictionAir:    0.008,
    density:        0.04,
    restitution:    0.1,
    collisionFilter: { group: grp, category: CAT_CAR, mask: CAT_ENV | CAT_DRAW | CAT_BALL }
  };

  // Front wheel on the LEFT side of the chassis, rear on the RIGHT
  const wheelL = Bodies.circle(x - AXLE_FRONT, y + WHEEL_DROP, WHEEL_R, wOpts);
  const wheelR = Bodies.circle(x + AXLE_REAR,  y + WHEEL_DROP, WHEEL_R, wOpts);

  const cL = Constraint.create({
    bodyA: chassis, pointA: { x: -AXLE_FRONT, y: AXLE_Y },
    bodyB: wheelL,
    stiffness: 0.45, length: 3, damping: 0.45
  });
  const cR = Constraint.create({
    bodyA: chassis, pointA: { x: AXLE_REAR, y: AXLE_Y },
    bodyB: wheelR,
    stiffness: 0.45, length: 3, damping: 0.45
  });

  Composite.add(world, [chassis, wheelL, wheelR, cL, cR]);
  car = { chassis, wheelL, wheelR };
}

// ─── Drawing System ──────────────────────────────────────────────────────────
function initDrawSystem() {
  canvas.addEventListener('mousedown',  e  => onDS(e));
  canvas.addEventListener('mousemove',  e  => onDM(e));
  canvas.addEventListener('mouseup',    ()  => onDE());
  canvas.addEventListener('mouseleave', ()  => onDE());
  canvas.addEventListener('touchstart', e  => { e.preventDefault(); onDS(e.touches[0]); }, { passive: false });
  canvas.addEventListener('touchmove',  e  => { e.preventDefault(); onDM(e.touches[0]); }, { passive: false });
  canvas.addEventListener('touchend',   e  => { e.preventDefault(); onDE(); },             { passive: false });
}

function getPt(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDS(e) {
  tutAnim   = null;       // çizim başlayınca eğitim animasyonunu iptal et
  isDrawing = true;
  prevPt    = getPt(e);
  drawStrokes.push([]);  // yeni hamle başlat
}

function onDM(e) {
  if (!isDrawing || !prevPt) return;
  const p   = getPt(e);
  const dx  = p.x - prevPt.x;
  const dy  = p.y - prevPt.y;
  const len = Math.hypot(dx, dy);
  if (len < DRAW_MIN_DIST) return;
  if (inkUsed >= MAX_INK) { prevPt = p; return; }  // mürekkep bitti — çizim engelle
  inkUsed += len;

  const seg = Bodies.rectangle(
    (prevPt.x + p.x) / 2,
    (prevPt.y + p.y) / 2,
    len + 2,
    DRAW_THICKNESS,
    {
      isStatic:       true,
      angle:          Math.atan2(dy, dx),
      label:          'drawn',
      friction:       0.85,
      frictionStatic: 1.0,
      restitution:    0.05,
      collisionFilter: { category: CAT_DRAW, mask: CAT_CAR | CAT_BALL }
    }
  );
  Composite.add(world, seg);
  drawBodies.push(seg);
  drawStrokes[drawStrokes.length - 1].push(seg);  // mevcut hamleye ekle
  prevPt = p;
}

function onDE() { isDrawing = false; prevPt = null; }

function clearDrawings() {
  drawBodies.forEach(b => Composite.remove(world, b));
  drawBodies  = [];
  drawStrokes = [];
}

function undoLastStroke() {
  if (!drawStrokes.length) return;
  const last = drawStrokes.pop();
  last.forEach(b => {
    Composite.remove(world, b);
    const idx = drawBodies.indexOf(b);
    if (idx !== -1) drawBodies.splice(idx, 1);
  });
}

// ─── Tutorial Animation ───────────────────────────────────────────────────────
function initTutorialAnim() {
  if (!car || !finishRect) return;

  const groundY = car.wheelR.position.y + WHEEL_VR;          // tekerleğin değdiği y
  const startX  = car.chassis.position.x + AXLE_REAR + WHEEL_R + 18; // ön tekerin önü
  const endX    = finishRect.x - FINISH_W * 0.5 - 8;         // bitiş direği kenarı

  // Hafif yay — quadratic bezier
  const cpX = (startX + endX) / 2;
  const cpY = groundY - 55;
  const N   = 80;
  const points = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, mt = 1 - t;
    points.push({
      x: mt * mt * startX + 2 * mt * t * cpX + t * t * endX,
      y: mt * mt * groundY + 2 * mt * t * cpY + t * t * groundY
    });
  }

  tutAnim = { active: true, frame: 0, drawFrames: 85, holdFrames: 45, points };
}

function renderTutorialAnim() {
  if (!tutAnim || !tutAnim.active) return;
  tutAnim.frame++;

  const { frame, drawFrames, holdFrames, points } = tutAnim;
  const cycleLen = drawFrames + holdFrames;
  const cycleT   = frame % cycleLen;
  const cycleNum = Math.floor(frame / cycleLen);
  if (cycleNum >= 3) { tutAnim.active = false; return; }

  const progress  = Math.min(1, cycleT / drawFrames);
  const tipIdx    = Math.floor(progress * (points.length - 1));
  const inHold    = cycleT >= drawFrames;
  const holdAlpha = inHold ? 1 - (cycleT - drawFrames) / holdFrames : 1;

  // Ghost stroke
  if (tipIdx > 0) {
    ctx.save();
    ctx.globalAlpha = 0.38 * holdAlpha;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i <= tipIdx; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = 4;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // Pencil emoji follows the tip during draw phase
  if (!inHold && tipIdx < points.length) {
    const cur = points[tipIdx];
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.font = '22px serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('✏️', cur.x + 3, cur.y - 3);
    ctx.restore();
  }
}

// ─── Confetti ─────────────────────────────────────────────────────────────────
const CONFETTI_COLORS = [
  '#f94144','#f3722c','#f8961e','#f9c74f',
  '#90be6d','#43aa8b','#4d908e','#577590',
  '#e040fb','#ff69b4','#00d4ff'
];

function spawnConfetti() {
  confetti = [];
  const cx = finishRect ? finishRect.x : W / 2;
  const cy = finishRect ? finishRect.y : H / 2;

  for (let i = 0; i < 130; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4; // mostly upward
    const speed = 5 + Math.random() * 14;
    confetti.push({
      x:        cx + (Math.random() - 0.5) * 80,
      y:        cy - 20,
      vx:       Math.cos(angle) * speed,
      vy:       Math.sin(angle) * speed,
      rot:      Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.28,
      color:    CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      w:        5 + Math.random() * 7,
      h:        3 + Math.random() * 5,
      life:     1.0,
      decay:    0.004 + Math.random() * 0.006
    });
  }
}

function tickConfetti() {
  for (const p of confetti) {
    p.x   += p.vx;
    p.y   += p.vy;
    p.vy  += 0.38;   // gravity
    p.vx  *= 0.992;  // air resistance
    p.rot += p.rotSpeed;
    p.life -= p.decay;
  }
  confetti = confetti.filter(p => p.life > 0);
}

function renderConfetti() {
  for (const p of confetti) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life > 0.35 ? 1 : p.life / 0.35);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}

// ─── Level Data ───────────────────────────────────────────────────────────────
// Positions are 0-1 fractions of W / H
// obs: { cf (col fraction), rf (row fraction), cols, rows }
// sp (startPoint): { xf, yf }
// fin (finishLine): { xf, yf, w, h }

const BASE_LEVELS = [
  {
    name: 'Eğitim',
    hint: '',
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.58, finOnCarRow: true },
    obs:   [],
    items: []
  },
  {
    name: 'Duvarı Aş',
    hint: '',
    sp:  { xf: 0.19, yf: 0.45, upRows: 4 },
    fin: { xf: 0.75, yf: 0.5,  upRows: 2, upPx: 54 },
    obs: [
      // Üst çatı: sol taraftan duvara kadar (ekran merkezinin 2 sırası üzerinde)
      { cf: 0.19, cfEnd: 0.41, rf: 0.34, rows: 1 },
      // Dikey duvar: tavandan aşağı 6 tile (altta 2 boşluk)
      { cf: 0.41, rfTop: 0.34, rows: 6, cols: 1 },
      // Alt yatay: duvardan sağa devam eden platform
      { cf: 0.41, cfEnd: 0.75, rf: 0.73, rows: 1 },
    ],
    items: []
  },
  {
    name: 'Hız Artışı',
    hint: '⚡ Hız güçlendiricisinden geçmek için bir yol çiz ve bitişe ulaş!',
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.55, w: 56, h: 80 },
    obs:   [{ cf: 0.48, rf: 0.82, cols: 1, rows: 4 }],
    items: [{ type: 'boost', xf: 0.70, yf: 0.70 }]
  },
  {
    name: 'Roket Fırlatma',
    hint: '🚀 Rokete çarp, takılsın — yukarı yol çiz ve uç!',
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.15, w: 56, h: 70 },
    obs:   [{ cf: 0.35, rf: 0.82, cols: 1, rows: 5 }],
    items: [{ type: 'rocket', xf: 0.60, yf: 0.62 }]
  },
  {
    name: 'Düşen Kayalar',
    hint: '🪨 Kayalar düşmeden önce bir çatı çiz, sonra bitişe ulaş!',
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.60, w: 56, h: 80 },
    obs:   [{ cf: 0.58, rfFloor: true, cols: 1, rows: 6 }],
    items: [{ type: 'balls', xf: 0.25, yf: 0.18, count: 5, radius: 54 }]
  },
  {
    name: 'Yerçekimi Ters Dönüyor',
    hint: '🔄 Yerçekimi topuna çarp — her şey ters döner! Bitiş tavanda.',
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.15, w: 56, h: 70 },
    obs:   [],
    items: [{ type: 'gravity', xf: 0.50, yf: 0.50 }]
  },
  {
    name: 'Rampalı Yol',
    hint: '🏔 Duvarın üstünden geçmek için bir rampa çiz!',
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.45, w: 56, h: 80 },
    obs:   [{ cf: 0.50, rfFloor: true, cols: 1, rows: 5 }],
    items: []
  },
  {
    name: 'Üç Engel',
    hint: '🧱 Üç farklı yükseklikte engeli aş!',
    sp:    { xf: 0.10, yf: 0.45 },
    fin:   { xf: 0.92, yf: 0.58, w: 56, h: 80 },
    obs:   [
      { cf: 0.28, rfFloor: true, cols: 1, rows: 4 },
      { cf: 0.52, rfFloor: true, cols: 1, rows: 7 },
      { cf: 0.73, rfFloor: true, cols: 1, rows: 5 },
    ],
    items: []
  },
  {
    name: 'Köprü Kur',
    hint: '🌉 İki kule arasına köprü çiz ve karşıya geç!',
    sp:    { xf: 0.12, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.58, w: 56, h: 80 },
    obs:   [
      { cf: 0.35, rfFloor: true, cols: 1, rows: 7 },
      { cf: 0.62, rfFloor: true, cols: 1, rows: 7 },
    ],
    items: []
  },
  {
    name: 'Roketli Tırmanış',
    hint: '🚀 Roketi al, hızlan ve yüksek duvarların üstünden zirveye çık!',
    sp:    { xf: 0.13, yf: 0.45 },
    fin:   { xf: 0.88, yf: 0.15, w: 56, h: 70 },
    obs:   [
      { cf: 0.38, rfFloor: true, cols: 1, rows: 5 },
      { cf: 0.63, rfFloor: true, cols: 1, rows: 8 },
    ],
    items: [{ type: 'rocket', xf: 0.51, yf: 0.62 }]
  }
];

// ─── Seeded RNG ───────────────────────────────────────────────────────────────
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ─── Procedural Level Generator ───────────────────────────────────────────────
const SP_POOL  = ['boost', 'rocket', 'balls', 'gravity'];  // hand ve bounce kaldırıldı
const SP_HINTS = {
  boost:   '⚡ Hız güçlendiricisinden geçmek için yol çiz!',
  rocket:  '🚀 Rokete çarp — bitiş en tepede!',
  balls:   '🪨 Kayalar gelmeden önce bir kalkan çiz!',
  gravity: '🔄 Yerçekimi ters döndü! Bitiş tavanda.'
};

function generateLevel(n) {
  const rng    = seededRng(n * 7919 + 3);
  const obsCnt = 1 + Math.floor(rng() * 2);   // 1-2 engel
  const obs    = [];

  for (let i = 0; i < obsCnt; i++) {
    obs.push({
      cf:      0.28 + rng() * 0.44,   // 0.28-0.72 arası
      rfFloor: true,                   // zemine yapışık, alttan geçiş yok
      cols:    1,
      rows:    5 + Math.floor(rng() * 3)  // 5-7 sıra — snap-line seviyesini kesin bloklar
    });
  }

  // Engelleri soldan sağa sırala — çakışmaları önle
  obs.sort((a, b) => a.cf - b.cf);

  // En fazla 1 item, %65 ihtimalle
  const items = [];
  if (rng() < 0.65) {
    const t       = SP_POOL[Math.floor(rng() * SP_POOL.length)];
    const lastCf  = obs.length > 0 ? obs[obs.length - 1].cf : 0.30;
    // Item her zaman son engelden sonra, finişten önce
    const itemXf  = Math.min(0.76, lastCf + 0.08 + rng() * 0.12);
    // balls üstten düşer, diğerleri arabanın yüksekliğinde
    const itemYf  = t === 'balls' ? 0.06 + rng() * 0.08 : 0.54 + rng() * 0.08;
    items.push({ type: t, xf: itemXf, yf: itemYf, count: 3 + Math.floor(rng() * 3) });
  }

  const hasTop = items.some(i => i.type === 'rocket' || i.type === 'gravity');
  const finYf  = hasTop ? 0.12 + rng() * 0.06 : 0.40 + rng() * 0.22;  // hasTop: üst köşe, normal: zemin seviyesi
  const hint   = items.length ? (SP_HINTS[items[0].type] || '🏁 Bitişe ulaş!') : '🏁 Bitişe ulaş!';

  return {
    name:  `Bölüm ${n + 1}`,
    hint,
    sp:    { xf: 0.15, yf: 0.45 },
    fin:   { xf: 0.76 + rng() * 0.12, yf: finYf, w: 56, h: 80 },
    obs,
    items
  };
}

function getLevel(n) {
  if (n < BASE_LEVELS.length) return BASE_LEVELS[n];
  const lvl = generateLevel(n);
  if (n === 12) lvl.obs = [];  // Bölüm 13: engelsiz
  return lvl;
}

// ─── Load Level ───────────────────────────────────────────────────────────────
function loadLevel(n) {
  stopSound('celebration');   // bir önceki bölümün müziğini durdur
  Composite.clear(world, false);
  drawBodies   = [];
  drawStrokes  = [];
  levelBodies  = [];
  specials     = [];
  car          = null;
  gravInverted = false;
  finished     = false;
  gameStarted  = false;
  failCooldown = 0;
  tutAnim      = null;
  confetti     = [];
  inkUsed           = 0;
  itemBonusStars    = 0;
  rocketBonusGiven  = false;
  gravityBonusGiven = false;
  boostBonusGiven   = false;
  engine.gravity.y = GRAVITY_DEF;

  const lvl = getLevel(n);

  document.getElementById('level-num').textContent = n + 1;
  document.getElementById('btn-start').textContent = '▶ BAŞLAT';

  // Fizik zemini: H'nin altındaki en yakın grid çizgisine hizala
  const PHYS_FLOOR = Math.floor(H / GRID) * GRID;  // örn. H=768 → 750

  // Ground — üst yüzeyi tam PHYS_FLOOR'da
  addEnv(Bodies.rectangle(W / 2, PHYS_FLOOR + 25, W * 4, 50, {
    isStatic: true, label: 'ground', friction: 0.6,
    collisionFilter: { category: CAT_ENV, mask: 0xFFFF }
  }));

  // Left boundary
  addEnv(Bodies.rectangle(-30, H / 2, 60, H * 3, {
    isStatic: true, label: 'lwall', friction: 0.3,
    collisionFilter: { category: CAT_ENV, mask: 0xFFFF }
  }));

  // Wall-tile obstacles
  // rfFloor: true  → tabanı PHYS_FLOOR'a sabitle, yukarı doğru rows kadar tile ekle
  // cfEnd: 0.xx    → yatay sütun sayısını otomatik hesapla (sabit cols yerine)
  const STEP = 60;
  for (const o of lvl.obs) {
    // Tile merkezi grid KARESİNİN merkezine hizalanır: n*GRID + GRID/2
    const snapGS = v => Math.floor(v / GRID) * GRID + GRID / 2;
    const ox    = snapGS(o.cf * W);
    const oy    = o.rfFloor      ? snapGS(PHYS_FLOOR - 1)
                : o.rfTop !== undefined ? snapGS(o.rfTop * H) + (o.rows - 1) * STEP
                : snapGS(o.rf * H);
    const endX  = o.cfEnd !== undefined ? snapGS(o.cfEnd * W) : null;
    const cols  = endX !== null
      ? Math.max(1, Math.round((endX - ox) / STEP) + 1)
      : o.cols;
    for (let r = 0; r < o.rows; r++) {
      for (let c = 0; c < cols; c++) {
        addEnv(Bodies.rectangle(
          ox + c * STEP,
          oy - r * STEP,
          TILE_PHY, TILE_PHY,
          {
            isStatic: true, label: 'obstacle', friction: 0.4,
            collisionFilter: { category: CAT_ENV, mask: 0xFFFF }
          }
        ));
      }
    }
  }

  // Special items
  for (const it of lvl.items) spawnItem(it);

  // Snap line: tekerleğin değdiği grid çizgisi (finOnCarRow için önce hesaplanır)
  // sp.upRows: kaç kare yukarı kaydır (varsayılan 0)
  const snapLine = Math.ceil((H / 2 + AXLE_Y + WHEEL_VR) / GRID) * GRID
                 - (lvl.sp.upRows || 0) * GRID;

  // Finish rect — direğin alt ucu grid çizgisine değsin
  let finPoleY;
  if (lvl.fin.finOnCarRow) {
    finPoleY = snapLine;                                          // arabaya aynı satır
  } else if (lvl.fin.yf < 0.2) {
    finPoleY = Math.round(lvl.fin.yf * H / GRID) * GRID;        // üst bölge
  } else {
    finPoleY = PHYS_FLOOR - (lvl.fin.upRows || 0) * GRID - (lvl.fin.upPx || 0); // zemin satırı (± kare + piksel kaydırma)
  }
  finishRect = { x: lvl.fin.xf * W, y: finPoleY - FINISH_H / 2, w: FINISH_W, h: FINISH_H };

  // Car — tekerlekler snap çizgisine
  const sx = lvl.sp.xf * W;
  const sy = Math.round(snapLine - AXLE_Y - WHEEL_VR);
  createCar(sx, sy);
  Body.setStatic(car.chassis, true);
  Body.setStatic(car.wheelL,  true);
  Body.setStatic(car.wheelR,  true);

  if (n === 0) initTutorialAnim();
}

function addEnv(b) {
  Composite.add(world, b);
  levelBodies.push(b);
}

// ─── Special Items ────────────────────────────────────────────────────────────
function spawnItem(it) {
  const x  = it.xf * W;
  const y  = it.yf * H;
  const sp = { ...it, x, y, active: true, t: 0 };

  if (it.type === 'balls') {
    sp.bodies = [];
    const cnt = it.count || 3;
    const r   = it.radius || 18;
    const gap = r * 2 + 15;   // toplar birbiriyle çakışmasın
    for (let i = 0; i < cnt; i++) {
      const b = Bodies.circle(x + (i - (cnt - 1) / 2) * gap, y, r, {
        isStatic: true,   // oyun başlayana kadar dondur, startGame'de serbest bırakılır
        label: 'ball', density: 0.006, restitution: 0.5, friction: 0.4,
        collisionFilter: { category: CAT_BALL, mask: CAT_ENV | CAT_CAR | CAT_DRAW | CAT_BALL }
      });
      Composite.add(world, b);
      sp.bodies.push(b);
      levelBodies.push(b);  // so they render in the main loop
    }
  }

  specials.push(sp);
}

function tickSpecials() {
  if (!car || !gameStarted) return;
  const cx = car.chassis.position.x;
  const cy = car.chassis.position.y;

  for (const sp of specials) {
    if (!sp.active) continue;
    sp.t++;
    const dist = Math.hypot(cx - sp.x, cy - sp.y);

    switch (sp.type) {
      case 'rocket':
        if (!sp.attached && dist < 65) {
          sp.attached = true;
          if (!rocketBonusGiven) { itemBonusStars += 2; rocketBonusGiven = true; }
          showHint('🚀 Roket Takıldı! +2 yıldız bonus!', 2000);
        }
        break;

      case 'boost':
        if (dist < 60) {
          Body.applyForce(car.chassis, car.chassis.position, { x: 0.30, y: -0.04 });
          sp.active = false;
          if (!boostBonusGiven) { itemBonusStars += 1; boostBonusGiven = true; }
          showHint('⚡ SPEED BOOST! +1 yıldız bonus!', 2000);
        }
        break;

      case 'gravity':
        if (dist < 72) {
          gravInverted = !gravInverted;
          engine.gravity.y = gravInverted ? -GRAVITY_DEF : GRAVITY_DEF;
          // Arabayı 180° çevir — tekerlekler tavana baksın
          if (car) {
            const cx = car.chassis.position.x;
            const cy = car.chassis.position.y;
            Body.setAngle(car.chassis, car.chassis.angle + Math.PI);
            // Kısıtların yeni pivot noktalarına göre tekerlekleri yerleştir
            Body.setPosition(car.wheelL, { x: cx + AXLE_FRONT, y: cy - AXLE_Y });
            Body.setPosition(car.wheelR, { x: cx - AXLE_REAR,  y: cy - AXLE_Y });
            // Hızı sıfırla — ani çevirme sonrası stabil kalsın
            Body.setVelocity(car.chassis, { x: 0, y: 0 });
            Body.setVelocity(car.wheelL,  { x: 0, y: 0 });
            Body.setVelocity(car.wheelR,  { x: 0, y: 0 });
            Body.setAngularVelocity(car.chassis, 0);
          }
          sp.active = false;
          if (!gravityBonusGiven) { itemBonusStars += 3; gravityBonusGiven = true; }
          showHint(gravInverted ? '🔄 Yerçekimi Ters Döndü! +3 yıldız bonus!' : '🔄 Yerçekimi Normale Döndü! +3 yıldız bonus!', 2000);
        }
        break;

      case 'bounce':
        if (dist < 55) {
          const vx = car.chassis.velocity.x;
          Body.setVelocity(car.chassis, { x: vx * 1.1, y: -20 });
          Body.setVelocity(car.wheelL,  { x: vx * 1.1, y: -20 });
          Body.setVelocity(car.wheelR,  { x: vx * 1.1, y: -20 });
          sp.active = false;
          showHint('🏀 BOING!', 1500);
        }
        break;

      case 'hand':
        if (!sp.punchCooldown) sp.punchCooldown = 0;
        if (sp.punchCooldown > 0) { sp.punchCooldown--; break; }
        if (dist < 220) {
          // applyForce yerine setVelocity — anlık ve güçlü geri tepme
          const vx = car.chassis.velocity.x;
          Body.setVelocity(car.chassis, { x: vx - 9, y: -3 });
          Body.setVelocity(car.wheelL,  { x: vx - 9, y: -3 });
          Body.setVelocity(car.wheelR,  { x: vx - 9, y: -3 });
          showHint('✊ PUNCH!', 800);
          sp.punchCooldown = 100;  // ~1.7 sn bekleme
          sp.punchAnim     = 28;   // animasyon frame sayısı
        }
        break;

      // 'balls' are physics bodies — no trigger needed
    }
  }
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
function startGame() {
  if (gameStarted || !car) return;
  tutAnim     = null;   // başlatınca eğitim animasyonunu durdur
  gameStarted = true;
  playSound('engineStart', 0.85);
  Body.setStatic(car.chassis, false);
  Body.setStatic(car.wheelL,  false);
  Body.setStatic(car.wheelR,  false);
  // Donmuş topları serbest bırak — artık düşmeye başlasınlar
  for (const sp of specials) {
    if (sp.type === 'balls' && sp.bodies) {
      sp.bodies.forEach(b => Body.setStatic(b, false));
    }
  }
  document.getElementById('btn-start').textContent = '■ Çalışıyor';
}

function gameTick() {
  if (!car) return;

  // Drive wheels
  if (gameStarted) {
    const rocketOn = specials.some(sp => sp.type === 'rocket' && sp.attached);
    const spd = gravInverted ? -CAR_SPEED : CAR_SPEED;
    const finalSpd = rocketOn ? spd * 1.8 : spd;
    Body.setAngularVelocity(car.wheelL, finalSpd);
    Body.setAngularVelocity(car.wheelR, finalSpd);
  }

  tickSpecials();
  tickConfetti();

  if (gameStarted && !finished) {
    checkWin();
    checkFail();
  }
}

function checkWin() {
  const { x, y } = car.chassis.position;
  const r = finishRect;
  if (!r) return;
  if (x > r.x - r.w / 2 && x < r.x + r.w / 2 &&
      y > r.y - r.h / 2 && y < r.y + r.h / 2) {
    finished = true;
    spawnConfetti();
    playSound('celebration', 0.9);

    const total   = Math.max(1, Math.min(3, getInkStars() + itemBonusStars));
    const bonuses = [];
    if (rocketBonusGiven)  bonuses.push({ label: '🚀 Roket  +2', cls: 'm-bonus-rocket'  });
    if (gravityBonusGiven) bonuses.push({ label: '🔄 Yerçekimi  +3', cls: 'm-bonus-gravity' });
    if (boostBonusGiven)   bonuses.push({ label: '⚡ Hız  +1', cls: 'm-bonus-boost'   });

    setTimeout(() => showWinModal(total, bonuses, currentLvl), 1800);
  }
}

function checkFail() {
  if (failCooldown > 0) { failCooldown--; return; }
  const { x, y } = car.chassis.position;

  // Off-screen — ters yerçekiminde üstten çıkabilir, normal yerçekiminde alttan
  const offScreen = gravInverted
    ? (y < -200 || x < -300 || x > W + 400)
    : (y > H + 200 || x < -300 || x > W + 400);
  if (offScreen) {
    failCooldown = 90;
    doReset();
    return;
  }

  // Devrilme kontrolü — ters yerçekiminde arabanın "ters" durması beklenir
  const a         = ((car.chassis.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const upsideDown = a > Math.PI * 0.55 && a < Math.PI * 1.45;
  // Normal yer çekimi: tepe üstü = fail | Ters yer çekimi: dik duran = fail
  if (gravInverted ? !upsideDown : upsideDown) {
    failCooldown = 90;
    setTimeout(doReset, 500);
  }
}

function doReset() {
  loadLevel(currentLvl);
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, W, H);

  // Background — beyaz zemin + açık gri kare ızgara
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= W; x += GRID) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = 0; y <= H; y += GRID) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();

  // Tutorial ghost animation (bölüm 1)
  renderTutorialAnim();

  // Player-drawn paths
  for (const b of drawBodies) {
    ctx.beginPath();
    ctx.moveTo(b.vertices[0].x, b.vertices[0].y);
    for (let i = 1; i < b.vertices.length; i++) {
      ctx.lineTo(b.vertices[i].x, b.vertices[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = '#111';
    ctx.fill();
  }

  // Level bodies
  for (const b of levelBodies) {
    if      (b.label === 'obstacle') renderTile(b);
    else if (b.label === 'ball')     renderBall(b);
  }

  // Special item icons / effects
  for (const sp of specials) renderSpecial(sp);

  // Finish line
  if (finishRect) renderFinish();

  // Car: body first (behind), then wheels on top
  if (car) {
    renderChassis(car.chassis);
    renderWheel(car.wheelL);
    renderWheel(car.wheelR);
  }

  // Araba üstündeki takılı roket ikonu
  if (car) {
    for (const sp of specials) {
      if (sp.type === 'rocket' && sp.attached) {
        ctx.save();
        ctx.translate(car.chassis.position.x, car.chassis.position.y);
        ctx.rotate(car.chassis.angle);
        ctx.font = '30px serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('🚀', 0, -CAR_H / 2 - 4);
        ctx.restore();
      }
    }
  }

  // Konfeti — en üst katman
  renderConfetti();

  // HUD: mürekkep çubuğu + yıldızlar (her zaman en üstte)
  renderInkBar();
}

// ── render helpers ────────────────────────────────────────────────────────────

function getInkStars() {
  const rem = Math.max(0, MAX_INK - inkUsed) / MAX_INK;
  if (rem >= 2 / 3) return 3;
  if (rem >= 1 / 3) return 2;
  if (rem >  0)     return 1;
  return 0;
}

function renderInkBar() {
  const remaining = Math.max(0, 1 - inkUsed / MAX_INK);
  const fillW     = Math.round(INK_BAR_W * remaining);

  // Arka plan track
  ctx.fillStyle = '#ddd';
  ctx.beginPath();
  ctx.roundRect(INK_BAR_X, INK_BAR_Y, INK_BAR_W, INK_BAR_H, 4);
  ctx.fill();

  // Mürekkep dolgusu — sağdan sola azalır
  if (fillW > 4) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(INK_BAR_X, INK_BAR_Y, fillW, INK_BAR_H, 4);
    ctx.clip();
    ctx.fillStyle = inkUsed >= MAX_INK ? '#c00' : '#111';
    ctx.fillRect(INK_BAR_X, INK_BAR_Y, fillW, INK_BAR_H);
    ctx.restore();
  }

  // Çubuk kenarlığı
  ctx.strokeStyle = '#333';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.roundRect(INK_BAR_X, INK_BAR_Y, INK_BAR_W, INK_BAR_H, 4);
  ctx.stroke();

  // 1/3 ve 2/3 eşik çizgileri
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth   = 1.5;
  for (const t of [1 / 3, 2 / 3]) {
    const mx = INK_BAR_X + Math.round(INK_BAR_W * t);
    ctx.beginPath();
    ctx.moveTo(mx, INK_BAR_Y + 2);
    ctx.lineTo(mx, INK_BAR_Y + INK_BAR_H - 2);
    ctx.stroke();
  }

  // Yıldız ikonları — çubuğun altında, her üçte bir bölümün ortasında
  const totalStars = Math.min(3, getInkStars() + itemBonusStars);
  const starY      = INK_BAR_Y + INK_BAR_H + 2;
  ctx.font         = '14px serif';
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'center';
  for (let i = 0; i < 3; i++) {
    const sx      = INK_BAR_X + INK_BAR_W * (i + 0.5) / 3;
    const earned  = i < totalStars;
    ctx.globalAlpha = earned ? 1.0 : 0.22;
    ctx.fillStyle   = earned ? '#f8b000' : '#888';
    ctx.fillText('★', sx, starY);
  }
  ctx.globalAlpha  = 1.0;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'alphabetic';
}

function renderTile(b) {
  ctx.save();
  // Tam piksele yuvarla — kesirli koordinatlar tile arası boşluk yaratır
  ctx.translate(Math.round(b.position.x), Math.round(b.position.y));
  ctx.rotate(b.angle);
  if (IMG.wall && IMG.wall.complete && IMG.wall.naturalWidth) {
    ctx.drawImage(IMG.wall, -TILE / 2, -TILE / 2, TILE, TILE);
  } else {
    ctx.fillStyle = '#7a4020';
    ctx.fillRect(-TILE / 2, -TILE / 2, TILE, TILE);
  }
  ctx.restore();
}

function renderBall(b) {
  const r = b.circleRadius || 18;
  ctx.save();
  ctx.translate(b.position.x, b.position.y);
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  g.addColorStop(0, '#aaa');
  g.addColorStop(1, '#333');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function renderWheel(w) {
  const d = WHEEL_VR * 2;   // visual diameter (fits the car-body arch)
  ctx.save();
  ctx.translate(w.position.x, w.position.y);
  ctx.rotate(w.angle);      // spins with physics angular velocity
  if (IMG.wheel && IMG.wheel.complete && IMG.wheel.naturalWidth) {
    // Beyaz iç dolgu
    ctx.beginPath();
    ctx.arc(0, 0, WHEEL_VR * 0.78, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.drawImage(IMG.wheel, -WHEEL_VR, -WHEEL_VR, d, d);
    // Dış çerçeve — tam tekerlek kenarına hizalı kalın halka
    ctx.beginPath();
    ctx.arc(0, 0, WHEEL_VR - 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Merkez artı işareti
    const arm = WHEEL_VR * 0.35;
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-arm, 0); ctx.lineTo(arm, 0);
    ctx.moveTo(0, -arm); ctx.lineTo(0, arm);
    ctx.stroke();
  } else {
    // Fallback tyre
    ctx.beginPath();
    ctx.arc(0, 0, WHEEL_VR, 0, Math.PI * 2);
    ctx.fillStyle = '#1c1c1c';
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, WHEEL_VR * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = '#ccc';
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * WHEEL_VR * 0.38, Math.sin(a) * WHEEL_VR * 0.38);
      ctx.lineTo(Math.cos(a) * WHEEL_VR * 0.86, Math.sin(a) * WHEEL_VR * 0.86);
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function renderChassis(c) {
  ctx.save();
  ctx.translate(c.position.x, c.position.y);
  ctx.rotate(c.angle);
  if (IMG.carBody && IMG.carBody.complete && IMG.carBody.naturalWidth) {
    // drawH = 60 so that arch centre (80% from top) falls exactly on AXLE_Y:
    //   -CAR_H/2 + 0.80 * 60 = -25 + 48 = +23 = AXLE_Y ✓
    // The extra 10px below chassis bottom reveals the wheel through the arch cutout.
    const drawH = CAR_H + 10;
    ctx.drawImage(IMG.carBody, -CAR_W / 2, -CAR_H / 2 - 5, CAR_W, drawH);
  } else {
    // Fallback: düz kırmızı dikdörtgen
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(-CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H);
    // Kabin penceresi
    ctx.fillStyle = 'rgba(180,220,255,0.7)';
    ctx.fillRect(-CAR_W * 0.15, -CAR_H / 2 + 4, CAR_W * 0.35, CAR_H * 0.5);
  }
  ctx.restore();
}

function renderFinish() {
  const { x, y, w, h } = finishRect;
  ctx.save();
  if (IMG.finish && IMG.finish.complete && IMG.finish.naturalWidth) {
    ctx.drawImage(IMG.finish, x - w / 2, y - h / 2, w, h);
  } else {
    ctx.fillStyle = 'rgba(255,215,0,0.80)';
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.font = '28px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏁', x, y);
  }
  ctx.restore();
}

const SP_ICONS  = { rocket:'🚀', boost:'⚡', gravity:'🔄', bounce:'🏀', hand:'✊', balls:'🪨' };
const SP_COLORS = { rocket:'#ff6030', boost:'#ffe000', gravity:'#60e8ff', bounce:'#ff80b0', hand:'#ffaa40', balls:'#aaaaaa' };

function renderSpecial(sp) {
  // Takılı roket: orijinal konumda değil, araba üstünde göster (render loop sonu)
  if (sp.type === 'rocket' && sp.attached) return;
  // Toplar zaten fizik cismi olarak render edilir — ayrıca ikon çizme
  if (sp.type === 'balls') return;
  if (!sp.active) return;
  const pulse = 0.86 + 0.14 * Math.sin(sp.t * 0.09);
  const col   = SP_COLORS[sp.type] || '#fff';

  ctx.save();
  ctx.translate(sp.x, sp.y);
  ctx.scale(pulse, pulse);

  // Glow circle
  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 2);
  ctx.fillStyle   = col + '28';
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth   = 2;
  ctx.stroke();

  // Icon
  ctx.font = '26px serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(SP_ICONS[sp.type] || '?', 0, 1);
  ctx.restore();

  // Hand: yumruk animasyonu — punchAnim sayacı sıfırlanana kadar çalışır
  if (sp.type === 'hand' && sp.punchAnim > 0) {
    const prog = 1 - sp.punchAnim / 28;   // 0 → 1
    const ext  = prog * 80;               // sola doğru uzanır
    ctx.save();
    ctx.globalAlpha = 1 - prog;
    ctx.font = '44px serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✊', sp.x - ext, sp.y);
    ctx.restore();
    sp.punchAnim--;
  }
}

// ─── Hint / Modal ─────────────────────────────────────────────────────────────
let hintTimer = null;

function showHint(msg, dur = 3500) {
  const el = document.getElementById('hint-box');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('visible'), dur);
}

function loadStarsData() {
  try { levelStars = JSON.parse(localStorage.getItem('levelStars') || '{}'); }
  catch(e) { levelStars = {}; }
  try { currentLvl = parseInt(localStorage.getItem('currentLvl') || '0', 10) || 0; }
  catch(e) { currentLvl = 0; }
  updateTotalStarsHUD();
}

function updateTotalStarsHUD() {
  const total = Object.values(levelStars).reduce((s, v) => s + v, 0);
  const el = document.getElementById('total-stars-num');
  if (el) el.textContent = total;
  // Giriş ekranı yıldız satırı
  const sNum = document.getElementById('splash-stars-num');
  const sRow = document.getElementById('splash-stars-row');
  if (sNum) sNum.textContent = total;
  if (sRow) sRow.style.visibility = total > 0 ? 'visible' : 'hidden';
}

function showWinModal(starsEarned, bonusItems, levelNum) {
  // Yıldız ikonlarını güncelle
  for (let i = 0; i < 3; i++) {
    const star = document.getElementById(`mstar-${i}`);
    star.classList.toggle('earned', i < starsEarned);
  }

  // Bonus pill'ları oluştur
  const bonusRow = document.getElementById('modal-bonus-row');
  bonusRow.innerHTML = bonusItems.map(b => {
    const cls = b.cls || 'm-bonus-boost';
    return `<span class="m-bonus ${cls}">${b.label}</span>`;
  }).join('');

  // Alt mesaj
  const inkS = getInkStars();
  const msgs = ['Mürekkep bitti — daha az çiz!', 'İyi gidiyorsun!', 'Harika çizim!', 'Mükemmel!'];
  document.getElementById('modal-msg').textContent = msgs[Math.min(3, inkS)];

  document.getElementById('modal-overlay').classList.remove('hidden');

  // Yıldız sesleri — CSS animasyon gecikmesiyle (0.15 / 0.32 / 0.50 sn) senkron
  const starDelays = [150, 320, 500];
  for (let i = 0; i < starsEarned; i++) {
    setTimeout(() => playSound(`star${i + 1}`, 0.8), starDelays[i]);
  }

  // Bölüm için en iyi yıldızı kaydet
  const prev = levelStars[levelNum] || 0;
  if (starsEarned > prev) {
    levelStars[levelNum] = starsEarned;
    localStorage.setItem('levelStars', JSON.stringify(levelStars));
  }
  updateTotalStarsHUD();   // her zaman HUD'ı güncelle
}

function hideModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ─── UI Bindings ──────────────────────────────────────────────────────────────
function bindUI() {
  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-reset').addEventListener('click', doReset);
  document.getElementById('btn-clear').addEventListener('click', undoLastStroke);
  // OYNA — giriş ekranını kapat
  document.getElementById('btn-play').addEventListener('click', () => {
    const splash = document.getElementById('splash');
    splash.classList.add('fade-out');
    setTimeout(() => { splash.style.display = 'none'; }, 450);
    // iOS/Safari: kullanıcı etkileşimi sonrası sesleri ön-aktifleştir
    Object.values(SFX).forEach(a => { try { a.play().catch(() => {}); a.pause(); a.currentTime = 0; } catch(e) {} });
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    hideModal();
    currentLvl++;
    localStorage.setItem('currentLvl', currentLvl);
    loadLevel(currentLvl);
  });
  window.addEventListener('resize', () => {
    resizeCanvas();
    loadLevel(currentLvl);
  });
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
function mainLoop() {
  gameTick();
  render();
  requestAnimationFrame(mainLoop);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  resizeCanvas();
  await loadImages();
  loadSounds();
  initPhysics();
  initDrawSystem();
  bindUI();
  loadStarsData();
  loadLevel(currentLvl);
  mainLoop();
}

boot();
