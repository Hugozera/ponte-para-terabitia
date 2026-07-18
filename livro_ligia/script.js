"use strict";

/* ============================================================
   Livro 3D fÃ­sico â€” todo movimento Ã© integrado por molas
   (semi-implÃ­cito, 60fps via requestAnimationFrame).
   A folha que vira Ã© segmentada e dobra como papel real.
   ============================================================ */

const stage = document.querySelector("#stage");
const book = document.querySelector("#book");
const leaf = document.querySelector("#leaf");
const frontBoard = document.querySelector("#frontBoard");
const rightPaper = document.querySelector("#rightPaper");
const leftPaper = document.querySelector("#leftPaper");
const rightBlock = document.querySelector("#rightBlock");
const prev = document.querySelector("#prev");
const next = document.querySelector("#next");
const label = document.querySelector("#pageLabel");
const leftPage = document.querySelector("#leftPage");
const rightPage = document.querySelector("#rightPage");
const leftNum = document.querySelector("#leftNum");
const rightNum = document.querySelector("#rightNum");
const appEl = document.querySelector(".app");
const bookmarkLabel = document.querySelector("#bookmarkLabel");

let TOTAL_PAGES = 120;
let TOTAL_SPREADS = TOTAL_PAGES / 2;
const SEGS = 6;            // segmentos da folha (dobra real)
const BLOCK_MAX = 30;      // espessura Ãºtil do miolo em px
const BLOCK_MIN = 2;

const params = new URLSearchParams(window.location.search);
const STORAGE_KEY = "livro-ligia-reading-state-v1";

function readSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      spread: clamp(Number(data.spread) || 0, 0, TOTAL_SPREADS - 1),
      open: Boolean(data.open)
    };
  } catch {
    return null;
  }
}

function saveReadingState(open = openS.target > 0.5) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      spread,
      open,
      page: spread * 2 + 1,
      savedAt: Date.now()
    }));
  } catch {
    /* localStorage can be unavailable in private/locked contexts. */
  }
}

/* ---------------- conteudo ---------------- */

function pageLimitsForViewport() {
  const width = window.innerWidth || 1200;
  if (width <= 560) return { target: 210, max: 265 };
  if (width <= 820) return { target: 350, max: 430 };
  if (width <= 1200) return { target: 420, max: 500 };
  return { target: 460, max: 540 };
}

const PAGE_LIMITS = pageLimitsForViewport();
const PAGE_TARGET_CHARS = PAGE_LIMITS.target;
const PAGE_MAX_CHARS = PAGE_LIMITS.max;

let bookSections = [];

function splitIntoReadablePieces(text, maxChars) {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const pieces = [];
  let current = "";

  sentences.forEach((sentence) => {
    const clean = sentence.trim();
    if (!clean) return;
    const next = current ? `${current} ${clean}` : clean;
    if (next.length <= maxChars) {
      current = next;
      return;
    }
    if (current) pieces.push(current);
    current = clean;
  });

  if (current) pieces.push(current);
  return pieces;
}

function pageLength(lines) {
  return lines.join(" ").length;
}

function pushSection(section, pages) {
  let current = [section.title];
  if (section.subtitle) current.push(section.subtitle);

  section.paragraphs.forEach((paragraph) => {
    splitIntoReadablePieces(paragraph, PAGE_TARGET_CHARS).forEach((piece) => {
      const wouldFit = pageLength(current) + piece.length <= PAGE_MAX_CHARS;
      if (wouldFit) {
        current.push(piece);
      } else {
        pages.push(current);
        current = [piece];
      }
    });
  });

  if (current.length) pages.push(current);
}

function buildBookPages() {
  const pages = [];
  bookSections.forEach((section) => pushSection(section, pages));
  if (pages.length % 2 !== 0) pages.push([""]);
  return pages;
}

let bookPages = [];

/* trilha do Capitulo 3: comeca a tocar quando a pagina dele abrir */
const CHAPTER_SONG_SRC = "assets/Alice In Chains - Nutshell (Lyrics) - Stay Retro (320k).mp3";
let chapterSongPage = -1;

function pageContent(pageIndex) {
  return bookPages[pageIndex] || [""];
}

function spreadContent(index) {
  const leftIndex = index * 2;
  return {
    left: pageContent(leftIndex),
    right: pageContent(leftIndex + 1)
  };
}
function fillText(container, lines) {
  container.replaceChildren();
  lines.forEach((line, index) => {
    const p = document.createElement("p");
    if (index === 0 && line.length < 30) {
      const strong = document.createElement("strong");
      strong.textContent = line;
      p.append(strong);
    } else {
      p.textContent = line;
    }
    container.append(p);
  });
}

/* ---------------- estado fÃ­sico ---------------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rad = d => d * Math.PI / 180;

const POSE_CLOSED = { rx: 12, ry: -26 };
const POSE_OPEN = { rx: 10, ry: -9 };

const cam = {
  rx: POSE_CLOSED.rx, ry: POSE_CLOSED.ry, dolly: 0,
  trx: POSE_CLOSED.rx, tryy: POSE_CLOSED.ry, tdolly: 0,
  fling: 0,
  dragging: false, lastX: 0, lastY: 0, moved: 0,
  pinch: 0
};

const openS = { v: 0, vel: 0, target: 0 };

const leafS = {
  active: false, dir: 1, mode: "idle",      // idle | peel | drag | auto | frozen
  theta: 0, vel: 0, target: 0,
  bend: 0, bendVel: 0, bendTarget: 0,
  cancelOnDone: false,
  pressT: 0, pressX: 0, pressY: 0, pressMoved: 0,
  p0: 0, grabW: 1, pullY: 0, pointerId: -1
};

let spread = 0;
let muted = false;
let soundOn = true;

/* ---------------- folha segmentada ---------------- */

let pageW = 0, segW = 0;
const segEls = [], facesF = [], facesB = [], pagesF = [], pagesB = [];

function buildLeaf() {
  let parent = leaf;
  for (let i = 0; i < SEGS; i += 1) {
    const seg = document.createElement("div");
    seg.className = "seg";

    const ff = document.createElement("div");
    ff.className = "seg-face front";
    const pf = document.createElement("div");
    pf.className = "leaf-page side-front";
    pf.innerHTML = '<div class="paper-inner"><div class="rule">âŒ</div><div class="page-text"></div><span class="page-num"></span></div>';
    ff.append(pf);

    const fb = document.createElement("div");
    fb.className = "seg-face back";
    const pb = document.createElement("div");
    pb.className = "leaf-page side-back";
    pb.innerHTML = '<div class="paper-inner"><div class="rule">âŒ</div><div class="page-text"></div><span class="page-num"></span></div>';
    fb.append(pb);

    seg.append(ff, fb);
    parent.append(seg);
    segEls.push(seg); facesF.push(ff); facesB.push(fb); pagesF.push(pf); pagesB.push(pb);
    parent = seg;
  }
}

function sizeLeaf() {
  pageW = rightBlock.offsetWidth;
  segW = pageW / SEGS;
  for (let i = 0; i < SEGS; i += 1) {
    segEls[i].style.width = `${segW + 0.6}px`;
    segEls[i].style.left = i === 0 ? "0px" : `${segW}px`;
    pagesF[i].style.width = `${pageW}px`;
    pagesF[i].style.left = `${-i * segW}px`;
    pagesB[i].style.width = `${pageW}px`;
    pagesB[i].style.left = `${-(pageW - (i + 1) * segW)}px`;
  }
}

function setLeafContent(frontLines, frontNum, backLines, backNum) {
  for (let i = 0; i < SEGS; i += 1) {
    fillText(pagesF[i].querySelector(".page-text"), frontLines);
    pagesF[i].querySelector(".page-num").textContent = `~ ${frontNum} ~`;
    fillText(pagesB[i].querySelector(".page-text"), backLines);
    pagesB[i].querySelector(".page-num").textContent = `~ ${backNum} ~`;
  }
}

/* ---------------- espessuras e conteÃºdo estÃ¡tico ---------------- */

function thicknessAt(s) {
  const p = TOTAL_SPREADS > 1 ? s / (TOTAL_SPREADS - 1) : 0;
  return {
    rt: BLOCK_MIN + (BLOCK_MAX - BLOCK_MIN * 2) * (1 - p),
    lt: BLOCK_MIN + (BLOCK_MAX - BLOCK_MIN * 2) * p
  };
}

function renderStatics(s) {
  const content = spreadContent(s);
  fillText(leftPage, content.left);
  fillText(rightPage, content.right);
  leftNum.textContent = `~ ${s * 2 + 1} ~`;
  rightNum.textContent = `~ ${s * 2 + 2} ~`;
}

function renderLabel() {
  label.textContent = openS.target < 0.5
    ? "Capa"
    : `${spread * 2 + 1}-${spread * 2 + 2} / ${TOTAL_PAGES}`;
  updateBookmark();
  updateChapterSong();
}

function updateBookmark() {
  const page = spread * 2 + 1;
  const progress = TOTAL_SPREADS > 1 ? spread / (TOTAL_SPREADS - 1) : 0;
  const top = 12 + progress * 68;
  setVar(stage, "--bookmark-top", `${top.toFixed(1)}%`);
  if (bookmarkLabel) bookmarkLabel.textContent = String(page);
}

/* ---------------- escrita de estilos (com cache) ---------------- */

const varCache = new Map();
function setVar(el, name, value) {
  const key = name;
  if (varCache.get(key) === value) return;
  varCache.set(key, value);
  el.style.setProperty(name, value);
}

function applyThickness() {
  const t = thicknessAt(spread);
  setVar(stage, "--rt", `${t.rt.toFixed(2)}px`);
  setVar(stage, "--lt", `${t.lt.toFixed(2)}px`);
}

/* ---------------- molas ---------------- */

function springTo(s, target, omega, zeta, dt, vKey = "vel", xKey = "v") {
  const k = omega * omega;
  const c = 2 * zeta * omega;
  s[vKey] += (k * (target - s[xKey]) - c * s[vKey]) * dt;
  s[xKey] += s[vKey] * dt;
}

/* ---------------- laÃ§o principal ---------------- */

let lastT = 0;

function tick(now) {
  const dt = clamp((now - lastT) / 1000, 0.001, 1 / 30);
  lastT = now;
  step(dt);
  requestAnimationFrame(tick);
}

function step(dt) {
  /* cÃ¢mera: perseguiÃ§Ã£o suavizada + inÃ©rcia de giro */
  if (!cam.dragging && Math.abs(cam.fling) > 0.02) {
    cam.tryy += cam.fling * dt * 60;
    cam.fling *= Math.exp(-2.6 * dt);
  }
  const chase = 1 - Math.exp(-11 * dt);
  cam.rx += (cam.trx - cam.rx) * chase;
  cam.ry += (cam.tryy - cam.ry) * chase;
  cam.dolly += (cam.tdolly - cam.dolly) * (1 - Math.exp(-8 * dt));

  setVar(stage, "--rx", `${cam.rx.toFixed(2)}deg`);
  setVar(stage, "--ry", `${cam.ry.toFixed(2)}deg`);
  setVar(stage, "--dolly", `${cam.dolly.toFixed(1)}px`);
  setVar(stage, "--sheen", `${clamp(-cam.ry * 2.2, -160, 160).toFixed(1)}px`);
  setVar(stage, "--sh-s", (1 + cam.dolly / 1500).toFixed(3));
  setVar(stage, "--sh-o", clamp(0.85 + cam.dolly / 2200, 0.35, 1).toFixed(2));

  /* abertura da capa */
  springTo(openS, openS.target, 5.6, 0.86, dt);
  const openV = clamp(openS.v, 0, 1);
  setVar(stage, "--open", openV.toFixed(4));
  if (openS.target === 0 && openS.v < 0.002 && Math.abs(openS.vel) < 0.02 && openS.v !== 0) {
    openS.v = 0; openS.vel = 0;
  }

  /* folha em movimento */
  if (leafS.active && leafS.mode !== "frozen") {
    const omega = leafS.mode === "auto" ? 6.8 : 16;
    const zeta = leafS.mode === "auto" ? 0.9 : 1.05;
    springTo(leafS, leafS.target, omega, zeta, dt, "vel", "theta");

    const p = clamp(-leafS.theta / 180, 0, 1);

    /* dobra: alvo depende do modo (arrasto = lag posicional; auto = velocidade) */
    if (leafS.mode === "peel") {
      leafS.bendTarget = leafS.dir > 0 ? 20 : -20;
    } else if (leafS.mode === "drag") {
      leafS.bendTarget =
        clamp((leafS.target - leafS.theta) * 0.4, -32, 32) +
        Math.sin(p * Math.PI) * 7 +
        leafS.pullY;
    } else {
      leafS.bendTarget = clamp(-leafS.vel * 0.055, -30, 30) + Math.sin(p * Math.PI) * 4;
    }
    springTo(leafS, leafS.bendTarget, 13, 0.62, dt, "bendVel", "bend");

    /* nunca deixar a ponta afundar nos blocos */
    const bendR = clamp(leafS.bend, -184 - leafS.theta, 8 - leafS.theta);

    const t = thicknessAt(spread);
    const zBase = lerp(t.rt, t.lt, p) + 1 + Math.sin(p * Math.PI) * 10;
    leaf.style.transform = `translateZ(${zBase.toFixed(2)}px) rotateY(${leafS.theta.toFixed(3)}deg)`;

    const bendPer = bendR / (SEGS - 1);
    for (let i = 1; i < SEGS; i += 1) {
      segEls[i].style.transform = `rotateY(${bendPer.toFixed(3)}deg)`;
    }

    /* sombreamento por segmento + sombras projetadas */
    for (let i = 0; i < SEGS; i += 1) {
      const a = leafS.theta + bendPer * i;
      const shF = clamp(-Math.sin(rad(a)) * 0.5, 0, 0.75);
      const shB = clamp(-Math.sin(rad(a + 180)) * 0.45, 0, 0.7);
      facesF[i].style.setProperty("--sh", shF.toFixed(3));
      facesB[i].style.setProperty("--sh", shB.toFixed(3));
    }
    setVar(stage, "--cast-r", (Math.sin(p * Math.PI) * (1 - p) * 1.1).toFixed(3));
    setVar(stage, "--cast-l", (Math.sin(p * Math.PI) * p * 1.0).toFixed(3));

    /* pouso da folha */
    if (leafS.mode === "auto" &&
        Math.abs(leafS.theta - leafS.target) < 0.4 &&
        Math.abs(leafS.vel) < 6) {
      finishFlip();
    }
  }

  /* trilha do capitulo final: entra e sai com fade suave */
  if (songS.el) {
    const target = songS.on ? SONG_VOLUME : 0;
    songS.level += (target - songS.level) * (1 - Math.exp(-1.4 * dt));
    songS.el.volume = clamp(songS.level, 0, 1);
    if (!songS.on && songS.level < 0.01 && !songS.el.paused) songS.el.pause();
  }

  if (params.get("debug") === "1") {
    document.body.dataset.dbg =
      `active=${leafS.active} mode=${leafS.mode} theta=${leafS.theta.toFixed(1)} vel=${leafS.vel.toFixed(1)} open=${openS.v.toFixed(2)} spread=${spread}`;
  }
}

/* ---------------- virada de pÃ¡gina ---------------- */

function startFlip(dir, mode) {
  if (leafS.active) return false;
  if (openS.target < 0.5 || openS.v < 0.85) return false;

  if (dir > 0 && spread >= TOTAL_SPREADS - 1) return false;
  if (dir < 0 && spread <= 0) return false;

  const cur = spreadContent(spread);
  leafS.active = true;
  leafS.dir = dir;
  leafS.mode = mode;
  leafS.cancelOnDone = false;
  leafS.bend = 0; leafS.bendVel = 0; leafS.pullY = 0;

  if (dir > 0) {
    const nxt = spreadContent(spread + 1);
    fillText(rightPage, nxt.right);
    rightNum.textContent = `~ ${(spread + 1) * 2 + 2} ~`;
    setLeafContent(cur.right, spread * 2 + 2, nxt.left, (spread + 1) * 2 + 1);
    leafS.theta = 0; leafS.vel = 0;
    leafS.target = mode === "peel" ? -15 : -180;
  } else {
    const prv = spreadContent(spread - 1);
    fillText(leftPage, prv.left);
    leftNum.textContent = `~ ${(spread - 1) * 2 + 1} ~`;
    setLeafContent(prv.right, (spread - 1) * 2 + 2, cur.left, spread * 2 + 1);
    leafS.theta = -180; leafS.vel = 0;
    leafS.target = mode === "peel" ? -165 : 0;
  }

  leaf.classList.add("active");
  playRustle(0.7);
  return true;
}

function finishFlip() {
  const landedLeft = leafS.theta < -90;
  leafS.active = false;
  leafS.mode = "idle";
  leaf.classList.remove("active");
  setVar(stage, "--cast-r", "0");
  setVar(stage, "--cast-l", "0");

  if (leafS.cancelOnDone) {
    renderStatics(spread);           // desfaz a prÃ©-troca de conteÃºdo
  } else if (leafS.dir > 0 && landedLeft) {
    spread += 1;
    renderStatics(spread);
    playRustle(0.35);
  } else if (leafS.dir < 0 && !landedLeft) {
    spread -= 1;
    renderStatics(spread);
    playRustle(0.35);
  } else {
    renderStatics(spread);           // voltou para onde estava
  }

  applyThickness();
  renderLabel();
  saveReadingState(true);
}

function flip(dir) {
  if (openS.target < 0.5) {
    if (dir > 0) setOpen(true);
    return;
  }
  if (dir < 0 && spread === 0) {
    setOpen(false);
    return;
  }
  if (leafS.active && leafS.mode === "auto") return;
  if (leafS.active) return;
  if (startFlip(dir, "auto")) {
    leafS.target = dir > 0 ? -180 : 0;
  }
}

/* ---------------- abrir / fechar ---------------- */

function setOpen(open) {
  if (!bookReady || leafS.active) return;
  openS.target = open ? 1 : 0;
  if (open) {
    renderStatics(spread);
    applyThickness();
    cam.trx = POSE_OPEN.rx; cam.tryy = POSE_OPEN.ry;
  } else {
    cam.trx = POSE_CLOSED.rx; cam.tryy = POSE_CLOSED.ry;
  }
  renderLabel();
  saveReadingState(open);
  playCover(open);
}

/* ---------------- interaÃ§Ã£o com as pÃ¡ginas ---------------- */

function pagePointerDown(event, dir) {
  if (openS.target < 0.5 || openS.v < 0.85) return;
  if (leafS.active && leafS.mode !== "auto") return;

  /* pegar a folha no ar durante uma virada automÃ¡tica */
  if (leafS.active && leafS.mode === "auto") {
    leafS.mode = "drag";
  } else if (!startFlip(dir, "peel")) {
    return;
  }

  leafS.pressT = performance.now();
  leafS.pressX = event.clientX;
  leafS.pressY = event.clientY;
  leafS.pressMoved = 0;
  leafS.pointerId = event.pointerId;
  leafS.grabW = rightBlock.getBoundingClientRect().width || pageW;
  leafS.p0 = (1 - Math.cos(rad(-leafS.theta))) / 2;

  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function pagePointerMove(event) {
  if (!leafS.active || leafS.pointerId !== event.pointerId) return;
  if (leafS.mode !== "peel" && leafS.mode !== "drag") return;

  const dx = event.clientX - leafS.pressX;
  const dy = event.clientY - leafS.pressY;
  leafS.pressMoved = Math.max(leafS.pressMoved, Math.abs(dx) + Math.abs(dy));

  if (leafS.mode === "peel" && leafS.pressMoved > 7) leafS.mode = "drag";

  if (leafS.mode === "drag") {
    const p = clamp(leafS.p0 + (-dx) / (leafS.grabW * 1.06), 0, 1);
    leafS.target = -(Math.acos(1 - 2 * p) * 180 / Math.PI);
    leafS.pullY = clamp(dy * 0.09, -12, 18) * (leafS.dir > 0 ? 1 : -1);
  }
}

function pagePointerUp(event) {
  if (!leafS.active || leafS.pointerId !== event.pointerId) return;
  if (leafS.mode !== "peel" && leafS.mode !== "drag") return;

  const held = performance.now() - leafS.pressT;
  const quickClick = held < 280 && leafS.pressMoved < 7;
  leafS.pointerId = -1;
  leafS.pullY = 0;

  let goLeft;                        // pousar Ã  esquerda = pÃ¡gina virada
  if (quickClick) {
    goLeft = leafS.dir > 0;          // 1 clique = movimento completo
  } else if (leafS.vel < -160) {
    goLeft = true;
  } else if (leafS.vel > 160) {
    goLeft = false;
  } else {
    goLeft = leafS.theta < -88;
  }

  leafS.mode = "auto";
  leafS.target = goLeft ? -180 : 0;
  leafS.cancelOnDone = (leafS.dir > 0 && !goLeft) || (leafS.dir < 0 && goLeft);
  if (!quickClick) playRustle(0.45);
}

/* ---------------- Ã³rbita da cÃ¢mera ---------------- */

const pointers = new Map();

stage.addEventListener("pointerdown", (event) => {
  updateChapterSong();
  if (event.target.closest("button, .block-top, .front-board")) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    cam.pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    cam.dragging = false;
    return;
  }

  cam.dragging = true;
  cam.lastX = event.clientX;
  cam.lastY = event.clientY;
  cam.moved = 0;
  cam.fling = 0;
  stage.classList.add("dragging");
  stage.setPointerCapture(event.pointerId);
});

stage.addEventListener("pointermove", (event) => {
  const p = pointers.get(event.pointerId);
  if (p) { p.x = event.clientX; p.y = event.clientY; }

  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    cam.tdolly = clamp(cam.tdolly + (d - cam.pinch) * 1.6, -640, 430);
    cam.pinch = d;
    return;
  }

  if (!cam.dragging) return;
  const dx = event.clientX - cam.lastX;
  const dy = event.clientY - cam.lastY;
  cam.moved += Math.abs(dx) + Math.abs(dy);
  cam.tryy += dx * 0.30;
  cam.trx = clamp(cam.trx - dy * 0.18, -38, 48);
  cam.fling = dx * 0.30;
  cam.lastX = event.clientX;
  cam.lastY = event.clientY;
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) cam.pinch = 0;
  cam.dragging = false;
  stage.classList.remove("dragging");
}

stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);

stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  cam.tdolly = clamp(cam.tdolly + (event.deltaY > 0 ? -58 : 58), -640, 430);
}, { passive: false });

/* ---------------- capa, botÃµes, teclado ---------------- */

frontBoard.addEventListener("click", () => {
  if (cam.moved > 8) return;
  setOpen(openS.target < 0.5);
});

frontBoard.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setOpen(openS.target < 0.5);
  }
});

rightPaper.addEventListener("pointerdown", e => pagePointerDown(e, 1));
rightPaper.addEventListener("pointermove", pagePointerMove);
rightPaper.addEventListener("pointerup", pagePointerUp);
rightPaper.addEventListener("pointercancel", pagePointerUp);
rightPaper.addEventListener("keydown", (event) => {
  if (event.key === "Enter") flip(1);
});

leftPaper.addEventListener("pointerdown", e => pagePointerDown(e, -1));
leftPaper.addEventListener("pointermove", pagePointerMove);
leftPaper.addEventListener("pointerup", pagePointerUp);
leftPaper.addEventListener("pointercancel", pagePointerUp);

prev.addEventListener("click", () => flip(-1));
next.addEventListener("click", () => flip(1));

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;

    if (action === "reset") {
      const pose = openS.target > 0.5 ? POSE_OPEN : POSE_CLOSED;
      cam.trx = pose.rx;
      cam.tryy = pose.ry;
      cam.tdolly = 0;
      cam.fling = 0;
      playTick(260);
    }

    if (action === "zoom") {
      cam.tdolly = cam.tdolly < 150 ? 300 : 0;
      button.classList.toggle("active", cam.tdolly > 150);
      playTick(310);
    }

    if (action === "details") {
      const on = appEl.classList.toggle("details");
      button.classList.toggle("active", on);
      cam.tdolly = on ? 360 : 0;
      playTick(380);
    }

    if (action === "sound") {
      soundOn = !soundOn;
      button.classList.toggle("active", soundOn);
      const icon = button.querySelector("i, svg");
      if (icon) {
        icon.setAttribute("data-lucide", soundOn ? "volume-2" : "volume-x");
        if (window.lucide) window.lucide.createIcons();
      }
      if (soundOn) playTick(500);
      updateChapterSong();
    }
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") flip(1);
  if (event.key === "ArrowLeft") flip(-1);
  if (event.key.toLowerCase() === "o") setOpen(openS.target < 0.5);
});

window.addEventListener("resize", sizeLeaf);

/* ---------------- Ã¡udio (um Ãºnico contexto) ---------------- */

let audioCtx = null;

function ctx() {
  if (!soundOn || muted) return null;
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    muted = true;
    return null;
  }
}

function playTick(freq) {
  const c = ctx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "triangle";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.03, c.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.06);
  o.connect(g); g.connect(c.destination);
  o.start(); o.stop(c.currentTime + 0.08);
}

function playRustle(strength) {
  const c = ctx();
  if (!c) return;
  const dur = 0.22;
  const buffer = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    const env = Math.pow(1 - i / data.length, 1.4);
    data[i] = (Math.random() * 2 - 1) * env * 0.04 * strength;
  }
  const src = c.createBufferSource();
  const filter = c.createBiquadFilter();
  const g = c.createGain();
  filter.type = "bandpass";
  filter.frequency.value = 1600 + Math.random() * 700;
  filter.Q.value = 0.7;
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.linearRampToValueAtTime(0.5, c.currentTime + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  src.buffer = buffer;
  src.connect(filter); filter.connect(g); g.connect(c.destination);
  src.start();
}

/* ---------------- trilha do Capitulo 3 ---------------- */

const SONG_VOLUME = 0.55;
const songS = { el: null, on: false, level: 0 };

function chapterSongWanted() {
  return soundOn &&
    chapterSongPage >= 0 &&
    openS.target > 0.5 &&
    spread * 2 + 1 >= chapterSongPage;
}

function updateChapterSong() {
  songS.on = chapterSongWanted();
  if (!songS.on) return;
  if (!songS.el) {
    songS.el = new Audio(CHAPTER_SONG_SRC);
    songS.el.loop = true;
    songS.el.preload = "auto";
    songS.el.volume = 0;
  }
  if (songS.el.paused) {
    const attempt = songS.el.play();
    /* autoplay pode ser bloqueado antes do primeiro toque; tentamos de novo no proximo gesto */
    if (attempt && attempt.catch) attempt.catch(() => {});
  }
}

function playCover(opening) {
  const c = ctx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(opening ? 130 : 95, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(opening ? 70 : 50, c.currentTime + 0.3);
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.06, c.currentTime + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.34);
  o.connect(g); g.connect(c.destination);
  o.start(); o.stop(c.currentTime + 0.4);
  playRustle(0.5);
}

/* ---------------- inicializaÃ§Ã£o ---------------- */

if (window.lucide) {
  window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

buildLeaf();
sizeLeaf();
renderStatics(0);
applyThickness();
renderLabel();

requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(tick); });

let bookReady = false;

/* ---------------- conteudo protegido ----------------
   O texto do livro chega decifrado pelo portao (index.html).
   Sem a frase secreta, nada abaixo recebe conteudo. */

function startBook(sections) {
  if (bookReady) return;
  bookSections = sections;
  bookPages = buildBookPages();
  TOTAL_PAGES = bookPages.length;
  TOTAL_SPREADS = TOTAL_PAGES / 2;
  chapterSongPage = bookPages.findIndex((page) => page[0] === "Capitulo 3");
  bookReady = true;

  renderStatics(0);
  applyThickness();
  renderLabel();

  const savedState = readSavedState();
  if (savedState &&
      !params.has("open") &&
      !params.has("autoopen") &&
      !params.has("action") &&
      !params.has("s")) {
    spread = savedState.spread;
    openS.v = savedState.open ? 1 : 0;
    openS.vel = 0;
    openS.target = savedState.open ? 1 : 0;
    renderStatics(spread);
    applyThickness();
    renderLabel();
    if (savedState.open) {
      cam.rx = cam.trx = POSE_OPEN.rx;
      cam.ry = cam.tryy = POSE_OPEN.ry;
    }
  }

  /* parÃ¢metros de URL para testes e capturas */
  if (params.get("open") === "1" || params.get("view") === "open" || params.has("spread") || params.get("fps") === "1" || params.get("flip") === "1") {
    openS.v = 1; openS.vel = 0; openS.target = 1;
    spread = clamp(Number(params.get("s") || params.get("spread")) || 0, 0, TOTAL_SPREADS - 1);
    renderStatics(spread);
    applyThickness();
    renderLabel();
    cam.rx = cam.trx = POSE_OPEN.rx;
    cam.ry = cam.tryy = POSE_OPEN.ry;
  }

  if (params.has("ry")) { cam.ry = cam.tryy = Number(params.get("ry")) || 0; }
  if (params.has("rx")) { cam.rx = cam.trx = Number(params.get("rx")) || 0; }
  if (params.has("dolly")) { cam.dolly = cam.tdolly = Number(params.get("dolly")) || 0; }

  if (params.has("leaf")) {
    const angle = clamp(Number(params.get("leaf")) || 0, -180, 0);
    const cur = spreadContent(spread);
    const nxt = spreadContent(Math.min(spread + 1, TOTAL_SPREADS - 1));
    setLeafContent(cur.right, spread * 2 + 2, nxt.left, (spread + 1) * 2 + 1);
    fillText(rightPage, nxt.right);
    rightNum.textContent = `~ ${(spread + 1) * 2 + 2} ~`;
    leafS.active = true;
    leafS.mode = "frozen";
    leafS.theta = angle;
    leaf.classList.add("active");
    const bend = Number(params.get("bend")) || 0;
    const bendPer = bend / (SEGS - 1);
    const t = thicknessAt(spread);
    const p = clamp(-angle / 180, 0, 1);
    leaf.style.transform = `translateZ(${(lerp(t.rt, t.lt, p) + 1 + Math.sin(p * Math.PI) * 10).toFixed(2)}px) rotateY(${angle}deg)`;
    for (let i = 1; i < SEGS; i += 1) {
      segEls[i].style.transform = `rotateY(${bendPer.toFixed(3)}deg)`;
    }
  }

  if (params.get("autoopen") === "1") {
    window.setTimeout(() => setOpen(true), 200);
  }

  /* aÃ§Ã£o sÃ­ncrona + avanÃ§o determinÃ­stico da simulaÃ§Ã£o (para capturas de teste) */
  const action = params.get("action");
  if (action === "open") setOpen(true);
  if (action === "close") setOpen(false);
  if (action === "flip") flip(1);
  if (action === "flipback") flip(-1);

  const fastForward = Number(params.get("t")) || 0;
  if (fastForward > 0) {
    const steps = Math.round(fastForward / (1000 / 60));
    for (let i = 0; i < steps; i += 1) step(1 / 60);
  }

  if (params.get("flip") === "1") {
    window.setTimeout(() => flip(1), 300);
  }

  if (params.get("fps") === "1") {
    const probe = document.createElement("div");
    probe.id = "fpsProbe";
    probe.hidden = true;
    document.body.append(probe);

    let frames = 0;
    let startedAt = 0;

    function sampleFrame(time) {
      if (!startedAt) {
        startedAt = time;
        window.setTimeout(() => flip(1), 80);
      }
      frames += 1;
      const elapsed = time - startedAt;
      if (elapsed < 1250) {
        requestAnimationFrame(sampleFrame);
        return;
      }
      const fps = Math.round((frames / elapsed) * 1000);
      probe.dataset.fps = String(fps);
      probe.textContent = String(fps);
    }

    requestAnimationFrame(sampleFrame);
  }
}

window.livroStart = startBook;
if (window.__livroSections) startBook(window.__livroSections);
