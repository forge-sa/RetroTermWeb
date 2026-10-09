// Terminal arcade: every game draws characters into a text grid that lives inside the CRT.
(() => {
  'use strict';

  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const rand = (n) => Math.floor(Math.random() * n);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const KEY_DIR = {
    arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', k: 'up', j: 'down', h: 'left', l: 'right',
  };
  const keyDir = (key) => KEY_DIR[String(key).toLowerCase()];
  const isRetry = (key) => key === 'r' || key === 'R' || key === 'Enter' || key === ' ';

  // Shown in ~/Games. `size` is only for ls -l.
  const LIST = [
    { file: 'tetris.sh', game: 'tetris', size: '6.1K', about: 'falling blocks',
      keys: 'left/right move, up rotate, down soft drop, space hard drop' },
    { file: 'snake.sh', game: 'snake', size: '3.4K', about: 'eat, grow, never bite yourself',
      keys: 'arrows or wasd steer' },
    { file: 'pacman.sh', game: 'pacman', size: '7.8K', about: 'waka waka',
      keys: 'arrows or wasd move' },
    { file: 'minesweeper.sh', game: 'minesweeper', size: '5.2K', about: 'clear the field without touching a mine',
      keys: 'click open, right-click flag, arrows + space, f flag, 1/2/3 board size' },
    { file: 'flappybird.sh', game: 'flappybird', size: '3.9K', about: 'flap through the pipes',
      keys: 'space, up or click to flap' },
  ];

  const GAMES = {};

  // ---------------------------------------------------------------- engine

  function measureChEm(host) {
    const probe = el('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;line-height:1';
    probe.textContent = '0'.repeat(20);
    host.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 2000;
    probe.remove();
    return w || 0.5;
  }

  function play(name, host, { signal, coarse = false, store }) {
    const game = GAMES[name];
    if (!game) return Promise.reject(new Error(`${name}: no such game`));

    return new Promise((resolve) => {
      host.textContent = '';
      const wrap = el('div', 'g-wrap');
      const gridEl = el('div', 'g-grid');
      const hintEl = el('div', 'g-hint');
      const padEl = el('div', 'g-pad');
      wrap.append(gridEl, hintEl, padEl);
      host.appendChild(wrap);

      const chEm = measureChEm(host);
      const listeners = { key: [], tap: [], press: [], hold: [], swipe: [] };
      const stoppers = new Set();
      let cols = 0, rows = 0, cw = 2;
      let cells = [], chars = [], classes = [];
      let update = null, draw = null, raf = 0, last = 0, done = false;
      let paused = false, pausable = true;
      let summary = () => null;

      const grid = {
        get cols() { return cols; },
        get rows() { return rows; },
        clear() { chars.fill(''); classes.fill(''); },
        set(x, y, ch = '', cls = '') {
          x = Math.floor(x);
          y = Math.floor(y);
          if (x < 0 || y < 0 || x >= cols || y >= rows) return;
          chars[y * cols + x] = ch;
          classes[y * cols + x] = cls;
        },
        // Writes text `cw` characters per cell so it reads normally on wide-cell grids.
        text(x, y, str, cls = '') {
          str = String(str);
          for (let i = 0; i * cw < str.length; i++) this.set(x + i, y, str.slice(i * cw, i * cw + cw).padEnd(cw), cls);
        },
        center(y, str, cls = '', x0 = 0, w = cols) {
          this.text(x0 + Math.floor((w - Math.ceil(String(str).length / cw)) / 2), y, str, cls);
        },
        // Inverse-video message box centered on an area of the grid.
        banner(lines, { x0 = 0, w = cols, y0 = 0, h = rows } = {}) {
          const width = Math.ceil((Math.max(...lines.map((l) => l.length)) + 2) / cw);
          const all = ['', ...lines, ''];
          const top = y0 + Math.floor((h - all.length) / 2);
          const left = x0 + Math.floor((w - width) / 2);
          all.forEach((line, i) => {
            const padL = Math.floor((width * cw - line.length) / 2);
            this.text(left, top + i, ' '.repeat(padL) + line.padEnd(width * cw - padL), 'inv');
          });
        },
      };

      function setup(c, r, w = 2) {
        cols = c;
        rows = r;
        cw = w;
        gridEl.textContent = '';
        gridEl.style.setProperty('--cw', w);
        cells = [];
        for (let y = 0; y < r; y++) {
          const row = el('div', 'g-row');
          for (let x = 0; x < c; x++) {
            const span = el('span', 'g-c');
            row.appendChild(span);
            cells.push({ el: span, ch: '', cls: '' });
          }
          gridEl.appendChild(row);
        }
        chars = new Array(c * r).fill('');
        classes = new Array(c * r).fill('');
        fit();
      }

      // Largest font size that still fits the whole grid on screen.
      function fit() {
        if (!cols || done) return;
        const w = host.clientWidth;
        const h = host.clientHeight - hintEl.offsetHeight - padEl.offsetHeight - 24;
        const size = Math.floor(Math.min(w / (cols * cw * chEm), h / rows));
        gridEl.style.fontSize = `${clamp(size, 6, 44)}px`;
      }
      const ro = new ResizeObserver(fit);
      ro.observe(host);

      function flush() {
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (c.ch !== chars[i]) { c.ch = chars[i]; c.el.textContent = chars[i]; }
          if (c.cls !== classes[i]) { c.cls = classes[i]; c.el.className = classes[i] ? `g-c ${classes[i]}` : 'g-c'; }
        }
      }

      function emitKey(key, e = {}) {
        if (key === 'Escape' || key === 'q' || key === 'Q') { quit(); return; }
        if ((key === 'p' || key === 'P') && pausable) { paused = !paused; return; }
        if (paused) { if (key === ' ' || key === 'Enter') paused = false; return; }
        for (const fn of listeners.key) fn(key, e);
      }

      const onKeyDown = (e) => {
        if (done) return;
        const ctrlC = e.ctrlKey && (e.key === 'c' || e.key === 'C');
        if (((e.ctrlKey || e.metaKey || e.altKey) && !ctrlC) || /^F\d+$/.test(e.key)) return;
        e.preventDefault();
        e.stopPropagation(); // the shell must not see game keys
        if (ctrlC) quit();
        else emitKey(e.key, e);
      };
      window.addEventListener('keydown', onKeyDown, true);

      // Pointer: press (down), tap (quick up), hold (long press), swipe (drag, repeats every cell).
      let ptr = null;
      let holdT = 0;
      const cellAt = (cx, cy) => {
        const r = gridEl.getBoundingClientRect();
        return { x: Math.floor(((cx - r.left) / r.width) * cols), y: Math.floor(((cy - r.top) / r.height) * rows) };
      };
      wrap.addEventListener('pointerdown', (e) => {
        if (done || e.target.closest('.g-btn')) return;
        const cell = cellAt(e.clientX, e.clientY);
        ptr = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, cell, button: e.button, used: false, moved: false };
        try { wrap.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        if (!paused) for (const fn of listeners.press) fn(cell.x, cell.y, e.button);
        clearTimeout(holdT);
        holdT = setTimeout(() => {
          if (!ptr || ptr.moved || paused) return;
          ptr.used = true;
          for (const fn of listeners.hold) fn(cell.x, cell.y);
          if (navigator.vibrate) navigator.vibrate(15);
        }, 420);
      });
      wrap.addEventListener('pointermove', (e) => {
        if (!ptr) return;
        if (Math.hypot(e.clientX - ptr.sx, e.clientY - ptr.sy) > 10) { ptr.moved = true; clearTimeout(holdT); }
        const dx = e.clientX - ptr.x;
        const dy = e.clientY - ptr.y;
        const step = Math.max(22, gridEl.getBoundingClientRect().width / cols);
        if (Math.abs(dx) < step && Math.abs(dy) < step) return;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        ptr.x = e.clientX;
        ptr.y = e.clientY;
        ptr.used = true;
        if (!paused) for (const fn of listeners.swipe) fn(dir);
      });
      const pointerEnd = (e) => {
        clearTimeout(holdT);
        if (!ptr) return;
        const p = ptr;
        ptr = null;
        if (e.type !== 'pointerup' || p.used || p.moved) return;
        if (paused) { paused = false; return; }
        for (const fn of listeners.tap) fn(p.cell.x, p.cell.y, p.button);
      };
      wrap.addEventListener('pointerup', pointerEnd);
      wrap.addEventListener('pointercancel', pointerEnd);
      wrap.addEventListener('contextmenu', (e) => e.preventDefault());

      function hint(desktop, touch) {
        hintEl.textContent = (coarse ? touch : desktop) || '';
        fit();
      }

      // On-screen buttons for touch screens. `repeat` buttons auto-fire while held.
      function controls(list) {
        padEl.textContent = '';
        if (!coarse) return [];
        const buttons = list.map((b) => {
          const btn = el('button', 'g-btn');
          btn.type = 'button';
          btn.textContent = b.label;
          let t1 = 0, t2 = 0;
          const stop = () => { clearTimeout(t1); clearInterval(t2); stoppers.delete(stop); };
          btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            emitKey(b.key);
            if (!b.repeat) return;
            stoppers.add(stop);
            t1 = setTimeout(() => { t2 = setInterval(() => emitKey(b.key), 70); }, 220);
          });
          for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
          padEl.appendChild(btn);
          return btn;
        });
        fit();
        return buttons;
      }

      function frame(t) {
        if (done) return;
        let dt = last ? t - last : 16;
        last = t;
        if (dt > 1000) dt = 16; // came back from a hidden tab
        // Fixed small steps keep speed and collisions the same at any frame rate.
        for (let left = Math.min(dt, 250); update && !paused && left > 0; left -= 20) update(Math.min(left, 20));
        grid.clear();
        if (draw) draw();
        if (paused) grid.banner(['PAUSED', '', coarse ? 'tap to resume' : 'p to resume']);
        flush();
        raf = requestAnimationFrame(frame);
      }

      const onVisibility = () => { if (document.hidden && pausable) paused = true; };
      document.addEventListener('visibilitychange', onVisibility);

      function quit() {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        clearTimeout(holdT);
        for (const stop of stoppers) stop();
        window.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('visibilitychange', onVisibility);
        if (signal) signal.removeEventListener('abort', quit);
        ro.disconnect();
        host.textContent = '';
        let text = null;
        try { text = summary(); } catch { /* summary is optional */ }
        resolve(text);
      }
      if (signal) {
        if (signal.aborted) { quit(); return; }
        signal.addEventListener('abort', quit, { once: true });
      }

      const bestKey = (key) => `retro:best:${name}:${key}`;
      const E = {
        grid,
        coarse,
        setup,
        hint,
        controls,
        quit,
        on(type, fn) { listeners[type].push(fn); },
        loop(u, d) { update = u; draw = d; },
        setPausable(v) { pausable = v; },
        summary(fn) { summary = fn; },
        best: (key) => store.get('localStorage', bestKey(key)),
        // Saves `value` if it beats the stored best; returns true when it did.
        record(key, value, lowerIsBetter = false) {
          const prev = E.best(key);
          if (!lowerIsBetter && value <= 0) return false;
          const better = prev == null || (lowerIsBetter ? value < prev : value > prev);
          if (better) store.set('localStorage', bestKey(key), value);
          return better;
        },
      };

      try {
        game(E);
      } catch (err) {
        console.error(err);
        quit();
        return;
      }
      raf = requestAnimationFrame(frame);
    });
  }

  // ---------------------------------------------------------------- tetris

  GAMES.tetris = (E) => {
    const g = E.grid;
    const W = 10, H = 20, OX = 1, OY = 1, PX = 13;
    const SHAPES = [
      [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[1, 1], [1, 1]],
      [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
      [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
      [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
      [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
      [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    ];
    const KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0]];
    const rotate = (m) => m.map((row, y) => row.map((_, x) => m[m.length - 1 - x][y]));

    E.setup(PX + 9, H + 3, 2);
    E.hint('<- -> move   up rotate   down soft drop   space hard drop   p pause   q quit',
      'tap rotate   drag to move   buttons below');
    E.controls([
      { label: '◀', key: 'ArrowLeft', repeat: true },
      { label: '▶', key: 'ArrowRight', repeat: true },
      { label: '↻', key: 'ArrowUp' },
      { label: '▼', key: 'ArrowDown', repeat: true },
      { label: 'drop', key: ' ' },
      { label: 'p', key: 'p' },
      { label: 'q', key: 'q' },
    ]);

    let board, piece, next, bag, score, lines, level, over, overAt, newBest;
    let dropAcc, lockAcc, lockMoves, clearing, clearT;

    const nextShape = () => {
      if (!bag.length) bag = shuffle([0, 1, 2, 3, 4, 5, 6]);
      return SHAPES[bag.pop()];
    };

    function reset() {
      board = Array.from({ length: H }, () => Array(W).fill(0));
      bag = [];
      score = 0; lines = 0; level = 1;
      over = false; newBest = false; clearing = null;
      next = nextShape();
      spawn();
    }

    function fits(m, px, py) {
      for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m.length; x++) {
          if (!m[y][x]) continue;
          const bx = px + x, by = py + y;
          if (bx < 0 || bx >= W || by >= H) return false;
          if (by >= 0 && board[by][bx]) return false;
        }
      }
      return true;
    }

    function spawn() {
      const m = next;
      next = nextShape();
      piece = { m, x: Math.floor((W - m.length) / 2), y: m.length === 4 ? -1 : 0 };
      dropAcc = 0; lockAcc = 0; lockMoves = 0;
      if (!fits(piece.m, piece.x, piece.y)) gameOver();
    }

    function gameOver() {
      over = true;
      overAt = performance.now();
      piece = null;
      newBest = E.record('score', score);
    }

    // Moving or rotating a landed piece buys it more time before it locks.
    function touched() {
      if (!fits(piece.m, piece.x, piece.y + 1) && lockMoves < 15) { lockAcc = 0; lockMoves++; }
    }

    function move(dx, dy) {
      if (!fits(piece.m, piece.x + dx, piece.y + dy)) return false;
      piece.x += dx;
      piece.y += dy;
      if (dx) touched();
      return true;
    }

    function turn(dir) {
      let m = rotate(piece.m);
      if (dir < 0) m = rotate(rotate(m));
      for (const [kx, ky] of KICKS) {
        if (fits(m, piece.x + kx, piece.y + ky)) {
          piece.m = m;
          piece.x += kx;
          piece.y += ky;
          touched();
          return;
        }
      }
    }

    const landingY = () => {
      let y = piece.y;
      while (fits(piece.m, piece.x, y + 1)) y++;
      return y;
    };

    function hardDrop() {
      const y = landingY();
      score += 2 * (y - piece.y);
      piece.y = y;
      lock();
    }

    function lock() {
      const { m, x: px, y: py } = piece;
      let above = false;
      m.forEach((row, y) => row.forEach((v, x) => {
        if (!v) return;
        if (py + y < 0) above = true;
        else board[py + y][px + x] = 1;
      }));
      piece = null;
      if (above) { gameOver(); return; }
      const full = [];
      board.forEach((row, y) => { if (row.every(Boolean)) full.push(y); });
      if (full.length) { clearing = full; clearT = 0; } else spawn();
    }

    function update(dt) {
      if (over) return;
      if (clearing) {
        clearT += dt;
        if (clearT < 240) return;
        board = board.filter((_, y) => !clearing.includes(y));
        while (board.length < H) board.unshift(Array(W).fill(0));
        lines += clearing.length;
        score += [0, 100, 300, 500, 800][clearing.length] * level;
        level = 1 + Math.floor(lines / 10);
        clearing = null;
        spawn();
        return;
      }
      if (!piece) return;
      const interval = Math.max(20, 1000 * Math.pow(0.8 - (level - 1) * 0.007, level - 1));
      if (fits(piece.m, piece.x, piece.y + 1)) {
        lockAcc = 0;
        dropAcc += dt;
        while (dropAcc >= interval) {
          dropAcc -= interval;
          if (!move(0, 1)) break;
        }
      } else {
        lockAcc += dt;
        if (lockAcc >= 500) lock();
      }
    }

    function paint(m, px, py, ch, cls) {
      m.forEach((row, y) => row.forEach((v, x) => {
        if (v && py + y >= 0) g.set(OX + px + x, OY + py + y, ch, cls);
      }));
    }

    function draw() {
      const flash = clearing && Math.floor(clearT / 60) % 2 === 0;
      for (let y = 0; y < H; y++) {
        g.set(OX - 1, OY + y, '<!', 'd');
        g.set(OX + W, OY + y, '!>', 'd');
        const lit = clearing && clearing.includes(y);
        for (let x = 0; x < W; x++) {
          if (board[y][x]) g.set(OX + x, OY + y, '[]', lit && flash ? 'inv' : 'blk');
          else g.set(OX + x, OY + y, ' .', 'dd');
        }
      }
      g.set(OX - 1, OY + H, '<!', 'd');
      g.set(OX + W, OY + H, '!>', 'd');
      for (let x = 0; x < W; x++) {
        g.set(OX + x, OY + H, '==', 'd');
        g.set(OX + x, OY + H + 1, '\\/', 'd');
      }
      if (piece) {
        paint(piece.m, piece.x, landingY(), '[]', 'd');
        paint(piece.m, piece.x, piece.y, '[]', 'blk');
      }

      const stat = (y, label, value) => {
        g.text(PX, y, label, 'd');
        g.text(PX, y + 1, String(value), 'h');
      };
      stat(1, 'SCORE', score);
      stat(4, 'LINES', lines);
      stat(7, 'LEVEL', level);
      stat(10, 'HI', Math.max(E.best('score') || 0, score));
      g.text(PX, 13, 'NEXT', 'd');
      next.forEach((row, y) => row.forEach((v, x) => {
        if (v) g.set(PX + x, 15 + y - (next.length === 4 ? 1 : 0), '[]', 'blk');
      }));

      if (over) {
        g.banner(['GAME OVER', `score ${score}`, ...(newBest ? ['new high score!'] : []), '',
          E.coarse ? 'tap to retry' : 'r: retry q: quit'], { x0: OX, w: W, y0: OY, h: H });
      }
    }

    const canRetry = () => over && performance.now() - overAt > 600;

    E.on('key', (key) => {
      // Space is the drop key here, so it never restarts a finished game.
      if (over) { if (key !== ' ' && isRetry(key) && canRetry()) reset(); return; }
      if (!piece) return;
      const d = keyDir(key);
      if (d === 'left') move(-1, 0);
      else if (d === 'right') move(1, 0);
      else if (d === 'down') { if (move(0, 1)) { score += 1; dropAcc = 0; } }
      else if (d === 'up' || key === 'x' || key === 'X') turn(1);
      else if (key === 'z' || key === 'Z') turn(-1);
      else if (key === ' ') hardDrop();
    });
    E.on('swipe', (d) => {
      if (!piece) return;
      if (d === 'left') move(-1, 0);
      else if (d === 'right') move(1, 0);
      else if (d === 'down') { if (move(0, 1)) score += 1; }
      else turn(1);
    });
    E.on('tap', () => {
      if (over) { if (canRetry()) reset(); return; }
      if (piece) turn(1);
    });

    E.summary(() => `tetris: score ${score}, ${lines} lines, level ${level}, best ${E.best('score') ?? score}`);
    reset();
    E.loop(update, draw);
  };

  // ---------------------------------------------------------------- snake

  GAMES.snake = (E) => {
    const g = E.grid;
    const W = 22, H = 16;
    E.setup(W + 2, H + 3, 2);
    E.hint('arrows / wasd steer   p pause   q quit', 'swipe to steer');
    E.controls([
      { label: '◀', key: 'ArrowLeft' },
      { label: '▲', key: 'ArrowUp' },
      { label: '▼', key: 'ArrowDown' },
      { label: '▶', key: 'ArrowRight' },
      { label: 'p', key: 'p' },
      { label: 'q', key: 'q' },
    ]);

    const HEAD = { right: ' :', left: ': ', up: "''", down: '..' };
    let snake, dir, queue, food, score, over, overAt, started, acc, newBest;

    function reset() {
      const y = Math.floor(H / 2);
      snake = [[6, y], [5, y], [4, y], [3, y]];
      dir = 'right';
      queue = [];
      score = 0; acc = 0;
      over = false; started = false; newBest = false;
      placeFood();
    }

    function placeFood() {
      const free = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) if (!snake.some(([sx, sy]) => sx === x && sy === y)) free.push([x, y]);
      }
      food = free.length ? free[rand(free.length)] : null;
    }

    // Queued turns make quick double-taps (like down-then-left) register.
    function steer(d) {
      if (!d || over) return;
      started = true;
      const lastDir = queue.length ? queue[queue.length - 1] : dir;
      if (d === lastDir || d === OPPOSITE[lastDir] || queue.length >= 3) return;
      queue.push(d);
    }

    function step() {
      if (queue.length) dir = queue.shift();
      const [dx, dy] = DIRS[dir];
      const nx = snake[0][0] + dx;
      const ny = snake[0][1] + dy;
      const eating = food && nx === food[0] && ny === food[1];
      const body = eating ? snake : snake.slice(0, -1);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || body.some(([x, y]) => x === nx && y === ny)) {
        over = true;
        overAt = performance.now();
        newBest = E.record('score', score);
        return;
      }
      snake.unshift([nx, ny]);
      if (eating) { score += 10; placeFood(); } else snake.pop();
    }

    function update(dt) {
      if (over || !started) return;
      acc += dt;
      const interval = Math.max(55, 135 - (score / 10) * 3);
      while (acc >= interval && !over) { acc -= interval; step(); }
    }

    function draw() {
      g.text(0, 0, `SCORE ${score}`, 'h');
      const hi = `HI ${Math.max(E.best('score') || 0, score)}`;
      g.text(W + 2 - Math.ceil(hi.length / 2), 0, hi, 'd');
      for (let x = 0; x < W + 2; x++) { g.set(x, 1, '', 'wall'); g.set(x, H + 2, '', 'wall'); }
      for (let y = 0; y < H; y++) { g.set(0, y + 2, '', 'wall'); g.set(W + 1, y + 2, '', 'wall'); }
      if (food) g.set(food[0] + 1, food[1] + 2, '<>', 'food');
      snake.forEach(([x, y], i) => {
        if (i === 0) g.set(x + 1, y + 2, over ? 'xx' : HEAD[dir], 'snk-head');
        else g.set(x + 1, y + 2, '', 'snk');
      });
      const area = { x0: 1, w: W, y0: 2, h: H };
      if (!started && !over) g.banner(['SNAKE', '', E.coarse ? 'swipe to start' : 'press an arrow to start'], area);
      if (over) {
        g.banner(['GAME OVER', `score ${score}`, ...(newBest ? ['new high score!'] : []), '',
          E.coarse ? 'tap to retry' : 'r: retry  q: quit'], area);
      }
    }

    const canRetry = () => over && performance.now() - overAt > 600;
    E.on('key', (key) => {
      if (over) { if (isRetry(key) && canRetry()) reset(); return; }
      steer(keyDir(key));
    });
    E.on('swipe', (d) => steer(d));
    E.on('tap', () => { if (canRetry()) reset(); });

    E.summary(() => `snake: score ${score}, best ${E.best('score') ?? score}`);
    reset();
    E.loop(update, draw);
  };

  // ---------------------------------------------------------------- pacman

  const PAC_MAZE = [
    '###################',
    '#........#........#',
    '#o##.###.#.###.##o#',
    '#.................#',
    '#.##.#.#####.#.##.#',
    '#....#...#...#....#',
    '####.### # ###.####',
    '   #.#       #.#   ',
    '####.# ##-## #.####',
    '    .  #   #  .    ',
    '####.# ##### #.####',
    '   #.#       #.#   ',
    '####.# ##### #.####',
    '#........#........#',
    '#.##.###.#.###.##.#',
    '#o.#.....P.....#.o#',
    '##.#.#.#####.#.#.##',
    '#....#...#...#....#',
    '#.######.#.######.#',
    '#.................#',
    '###################',
  ];

  GAMES.pacman = (E) => {
    const g = E.grid;
    const MW = PAC_MAZE[0].length, MH = PAC_MAZE.length, OY = 1;
    const EXIT = [9, 7];
    const START = [9, 15];
    const MOUTH = { right: '<', left: '>', up: 'V', down: '^' };
    const DEATH = ['V', 'v', '-', '.', '*', ''];
    const WALL = PAC_MAZE.map((r) => [...r].map((c) => c === '#' || c === '-'));
    const open = (x, y) => y >= 0 && y < MH && !WALL[y][(x + MW) % MW];

    // Eaten ghosts follow this distance map back to the ghost house.
    const exitDist = PAC_MAZE.map(() => Array(MW).fill(Infinity));
    exitDist[EXIT[1]][EXIT[0]] = 0;
    for (const queue = [EXIT]; queue.length;) {
      const [x, y] = queue.shift();
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = (x + dx + MW) % MW, ny = y + dy;
        if (!open(nx, ny) || exitDist[ny][nx] !== Infinity) continue;
        exitDist[ny][nx] = exitDist[y][x] + 1;
        queue.push([nx, ny]);
      }
    }

    E.setup(MW, MH + 2, 2);
    E.hint('arrows / wasd move   p pause   q quit', 'swipe to move');
    E.controls([
      { label: '◀', key: 'ArrowLeft' },
      { label: '▲', key: 'ArrowUp' },
      { label: '▼', key: 'ArrowDown' },
      { label: '▶', key: 'ArrowRight' },
      { label: 'p', key: 'p' },
      { label: 'q', key: 'q' },
    ]);

    let maze, dots, pac, ghosts, score, lives, level, state, stateT, overAt, newBest;
    let frightT, combo, modeT, chase, elapsed, popups;

    function newGame() {
      score = 0; lives = 3; level = 1; newBest = false;
      newLevel();
    }

    function newLevel() {
      maze = PAC_MAZE.map((r) => [...r.replace('P', ' ')]);
      dots = maze.flat().filter((t) => t === '.' || t === 'o').length;
      resetActors();
    }

    function resetActors() {
      pac = { x: START[0], y: START[1], dir: 'left', want: null, acc: 0, mouth: true };
      ghosts = [
        { name: 'blinky', x: 9, y: 7, corner: [MW, -3], delay: 0 },
        { name: 'pinky', x: 9, y: 9, corner: [-1, -3], delay: 1500 },
        { name: 'inky', x: 8, y: 9, corner: [MW, MH + 1], delay: 4500 },
        { name: 'clyde', x: 10, y: 9, corner: [-1, MH + 1], delay: 7500 },
      ].map((gh) => ({ ...gh, state: gh.delay ? 'house' : 'normal', dir: 'left', acc: 0 }));
      frightT = 0; combo = 0; modeT = 0; chase = false; elapsed = 0; popups = [];
      state = 'ready';
      stateT = 1800;
    }

    function target(gh) {
      if (!chase) return gh.corner;
      const [dx, dy] = DIRS[pac.dir];
      switch (gh.name) {
        case 'blinky': return [pac.x, pac.y];
        case 'pinky': return [pac.x + 4 * dx, pac.y + 4 * dy];
        case 'inky': {
          const b = ghosts[0];
          return [2 * (pac.x + 2 * dx) - b.x, 2 * (pac.y + 2 * dy) - b.y];
        }
        default:
          return Math.hypot(gh.x - pac.x, gh.y - pac.y) > 8 ? [pac.x, pac.y] : gh.corner;
      }
    }

    function frighten() {
      frightT = Math.max(1500, 7000 - (level - 1) * 900);
      combo = 0;
      for (const gh of ghosts) {
        if (gh.state === 'normal') { gh.state = 'fright'; gh.dir = OPPOSITE[gh.dir]; }
      }
    }

    function collide() {
      for (const gh of ghosts) {
        if (gh.x !== pac.x || gh.y !== pac.y || gh.state === 'house' || gh.state === 'eyes') continue;
        if (gh.state === 'fright') {
          gh.state = 'eyes';
          combo++;
          const pts = 100 * 2 ** combo;
          score += pts;
          popups.push({ x: gh.x, y: gh.y, text: String(pts), t: 900 });
        } else {
          state = 'dying';
          stateT = 1500;
          lives--;
          return;
        }
      }
    }

    function stepPac() {
      if (pac.want && open(pac.x + DIRS[pac.want][0], pac.y + DIRS[pac.want][1])) pac.dir = pac.want;
      const [dx, dy] = DIRS[pac.dir];
      if (!open(pac.x + dx, pac.y + dy)) { pac.mouth = true; return; }
      pac.x = (pac.x + dx + MW) % MW;
      pac.y += dy;
      pac.mouth = !pac.mouth;
      const t = maze[pac.y][pac.x];
      if (t === '.' || t === 'o') {
        maze[pac.y][pac.x] = ' ';
        dots--;
        score += t === 'o' ? 50 : 10;
        if (t === 'o') frighten();
      }
      collide();
      if (dots === 0 && state === 'play') { state = 'clear'; stateT = 2000; }
    }

    function stepGhost(gh) {
      const moves = Object.entries(DIRS).filter(([d, [dx, dy]]) =>
        open(gh.x + dx, gh.y + dy) && (gh.state === 'eyes' || d !== OPPOSITE[gh.dir]));
      if (!moves.length) return;
      let choice;
      if (gh.state === 'eyes') {
        choice = moves.reduce((a, b) =>
          exitDist[gh.y + b[1][1]][(gh.x + b[1][0] + MW) % MW] < exitDist[gh.y + a[1][1]][(gh.x + a[1][0] + MW) % MW] ? b : a);
      } else if (gh.state === 'fright') {
        choice = moves[rand(moves.length)];
      } else {
        const [tx, ty] = target(gh);
        const dist = ([, [dx, dy]]) => (gh.x + dx - tx) ** 2 + (gh.y + dy - ty) ** 2;
        choice = moves.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      }
      const [d, [dx, dy]] = choice;
      gh.dir = d;
      gh.x = (gh.x + dx + MW) % MW;
      gh.y += dy;
      if (gh.state === 'eyes' && gh.x === EXIT[0] && gh.y === EXIT[1]) gh.state = 'normal';
    }

    function update(dt) {
      for (const p of popups) p.t -= dt;
      popups = popups.filter((p) => p.t > 0);

      if (state === 'ready' || state === 'dying' || state === 'clear') {
        stateT -= dt;
        if (stateT > 0) return;
        if (state === 'ready') state = 'play';
        else if (state === 'clear') { level++; newLevel(); }
        else if (lives > 0) resetActors();
        else { state = 'over'; overAt = performance.now(); newBest = E.record('score', score); }
        return;
      }
      if (state !== 'play') return;

      elapsed += dt;
      if (frightT > 0) {
        frightT -= dt;
        if (frightT <= 0) for (const gh of ghosts) if (gh.state === 'fright') gh.state = 'normal';
      } else {
        modeT += dt;
        const nowChase = modeT % 27000 >= 7000; // 7s scatter, 20s chase
        if (nowChase !== chase) {
          chase = nowChase;
          for (const gh of ghosts) if (gh.state === 'normal') gh.dir = OPPOSITE[gh.dir];
        }
      }
      for (const gh of ghosts) {
        if (gh.state === 'house' && elapsed >= gh.delay) Object.assign(gh, { state: 'normal', x: EXIT[0], y: EXIT[1], dir: 'left', acc: 0 });
      }

      const pacStep = Math.max(100, 150 - (level - 1) * 8);
      pac.acc += dt;
      while (pac.acc >= pacStep && state === 'play') { pac.acc -= pacStep; stepPac(); }

      for (const gh of ghosts) {
        if (gh.state === 'house') continue;
        const speed = gh.state === 'eyes' ? 55 : gh.state === 'fright' ? 250 : Math.max(110, 165 - (level - 1) * 8);
        gh.acc += dt;
        while (gh.acc >= speed && state === 'play') { gh.acc -= speed; stepGhost(gh); collide(); }
      }
    }

    function draw() {
      g.text(0, 0, `SCORE ${score}`, 'h');
      const hi = `HI ${Math.max(E.best('score') || 0, score)}`;
      g.text(MW - Math.ceil(hi.length / 2), 0, hi, 'd');

      const flash = state === 'clear' && Math.floor(stateT / 250) % 2 === 0;
      for (let y = 0; y < MH; y++) {
        for (let x = 0; x < MW; x++) {
          const t = maze[y][x];
          if (t === '#') g.set(x, y + OY, '', flash ? 'wall-hi' : 'wall');
          else if (t === '.') g.set(x, y + OY, '.', 'dot');
          else if (t === 'o') g.set(x, y + OY, 'o', 'pow');
          else if (t === '-') g.set(x, y + OY, '==', 'dd');
        }
      }

      if (state !== 'over' && !(state === 'dying' && stateT < 1100)) {
        for (const gh of ghosts) {
          if (gh.state === 'eyes') g.set(gh.x, gh.y + OY, 'oo', 'h');
          else if (gh.state === 'fright') g.set(gh.x, gh.y + OY, '~~', frightT < 2000 && Math.floor(frightT / 200) % 2 ? 'ghost' : 'ghost-f');
          else g.set(gh.x, gh.y + OY, 'oo', 'ghost');
        }
      }
      if (state !== 'over') {
        const glyph = state === 'dying'
          ? DEATH[Math.min(DEATH.length - 1, Math.floor((1500 - stateT) / 250))]
          : pac.mouth ? MOUTH[pac.dir] : 'O';
        g.set(pac.x, pac.y + OY, glyph, 'pac');
      }
      for (const p of popups) g.text(p.x, p.y + OY, p.text, 'h');

      g.text(0, MH + OY, '< '.repeat(Math.max(0, lives - (state === 'over' ? 0 : 1))), 'h');
      const lv = `LEVEL ${level}`;
      g.text(MW - Math.ceil(lv.length / 2), MH + OY, lv, 'd');

      if (state === 'ready') g.center(11 + OY, 'READY!', 'h');
      if (state === 'over') {
        g.banner(['GAME OVER', `score ${score}`, ...(newBest ? ['new high score!'] : []), '',
          E.coarse ? 'tap to retry' : 'r: retry  q: quit']);
      }
    }

    const canRetry = () => state === 'over' && performance.now() - overAt > 600;
    E.on('key', (key) => {
      if (state === 'over') { if (isRetry(key) && canRetry()) newGame(); return; }
      const d = keyDir(key);
      if (d) pac.want = d;
    });
    E.on('swipe', (d) => { if (state !== 'over') pac.want = d; });
    E.on('tap', () => { if (canRetry()) newGame(); });

    E.summary(() => `pacman: score ${score}, level ${level}, best ${E.best('score') ?? score}`);
    newGame();
    E.loop(update, draw);
  };

  // ---------------------------------------------------------------- minesweeper

  GAMES.minesweeper = (E) => {
    const g = E.grid;
    const LEVELS = {
      1: { w: 9, h: 9, mines: 10, name: 'beginner' },
      2: { w: 16, h: 16, mines: 40, name: 'intermediate' },
      3: { w: 30, h: 16, mines: 99, name: 'expert' },
    };
    E.setPausable(false);
    E.hint('click open   right-click flag   arrows + space   f flag   1/2/3 size   r new   q quit',
      'tap open   long-press flag   buttons below');
    const [flagBtn] = E.controls([
      { label: 'flag: off', key: 'm' },
      { label: 'new', key: 'r' },
      { label: 'size', key: 'n' },
      { label: 'q', key: 'q' },
    ]);

    let L, levelNo, board, cur, state, flags, opened, t0, endTime, boom, newBest, ox, oy;
    let flagMode = false;
    let showCursor = !E.coarse;

    function newGame(n = levelNo || 1) {
      levelNo = n;
      L = LEVELS[n];
      const cols = Math.max(L.w + 2, 15);
      E.setup(cols, L.h + 4, 2);
      ox = Math.floor((cols - L.w) / 2);
      oy = 2;
      board = Array.from({ length: L.h }, () => Array.from({ length: L.w }, () => ({ mine: false, n: 0, open: false, flag: false })));
      cur = { x: Math.floor(L.w / 2), y: Math.floor(L.h / 2) };
      state = 'ready';
      flags = 0; opened = 0; t0 = 0; endTime = 0; boom = null; newBest = false;
    }

    function around(x, y) {
      const out = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < L.w && ny < L.h) out.push([nx, ny]);
        }
      }
      return out;
    }

    // Mines are placed after the first click, never on or next to it.
    function plant(sx, sy) {
      const spots = [];
      for (let y = 0; y < L.h; y++) {
        for (let x = 0; x < L.w; x++) if (Math.abs(x - sx) > 1 || Math.abs(y - sy) > 1) spots.push([x, y]);
      }
      for (const [x, y] of shuffle(spots).slice(0, L.mines)) board[y][x].mine = true;
      for (let y = 0; y < L.h; y++) {
        for (let x = 0; x < L.w; x++) board[y][x].n = around(x, y).filter(([nx, ny]) => board[ny][nx].mine).length;
      }
    }

    function flood(x, y) {
      const stack = [[x, y]];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const c = board[cy][cx];
        if (c.open || c.flag) continue;
        c.open = true;
        opened++;
        if (c.n === 0) for (const [nx, ny] of around(cx, cy)) if (!board[ny][nx].open) stack.push([nx, ny]);
      }
    }

    function lose(x, y) {
      state = 'lost';
      boom = [x, y];
      endTime = performance.now();
    }

    function checkWin() {
      if (state !== 'play' || opened !== L.w * L.h - L.mines) return;
      state = 'won';
      endTime = performance.now();
      for (const row of board) for (const c of row) if (c.mine) c.flag = true;
      flags = L.mines;
      newBest = E.record(L.name, Math.floor((endTime - t0) / 1000), true);
    }

    function reveal(x, y) {
      if (state === 'won' || state === 'lost') return;
      const c = board[y][x];
      if (c.flag) return;
      if (state === 'ready') { plant(x, y); state = 'play'; t0 = performance.now(); }
      if (c.open) {
        // Chord: a number with all its flags placed opens the rest of its neighbours.
        const nb = around(x, y);
        if (!c.n || nb.filter(([nx, ny]) => board[ny][nx].flag).length !== c.n) return;
        for (const [nx, ny] of nb) {
          const d = board[ny][nx];
          if (d.flag || d.open) continue;
          if (d.mine) { lose(nx, ny); return; }
          flood(nx, ny);
        }
      } else if (c.mine) {
        lose(x, y);
        return;
      } else {
        flood(x, y);
      }
      checkWin();
    }

    function toggleFlag(x, y) {
      if (state === 'won' || state === 'lost') return;
      const c = board[y][x];
      if (c.open) return;
      c.flag = !c.flag;
      flags += c.flag ? 1 : -1;
    }

    const seconds = () => {
      if (state === 'ready') return 0;
      return Math.min(999, Math.floor(((endTime || performance.now()) - t0) / 1000));
    };

    function draw() {
      const cols = g.cols;
      const face = state === 'lost' ? 'X(' : state === 'won' ? 'B)' : ':)';
      g.text(0, 0, `* ${String(L.mines - flags).padStart(3, '0')}`, 'h');
      g.center(0, face, 'h');
      const time = `${String(seconds()).padStart(3, '0')} s`;
      g.text(cols - Math.ceil(time.length / 2), 0, time, 'h');

      for (let x = -1; x <= L.w; x++) { g.set(ox + x, oy - 1, '', 'wall'); g.set(ox + x, oy + L.h, '', 'wall'); }
      for (let y = 0; y < L.h; y++) { g.set(ox - 1, oy + y, '', 'wall'); g.set(ox + L.w, oy + y, '', 'wall'); }

      for (let y = 0; y < L.h; y++) {
        for (let x = 0; x < L.w; x++) {
          const c = board[y][x];
          let ch = '', cls = 'ms-h';
          if (c.open) {
            if (c.n) { ch = String(c.n); cls = c.n > 2 ? 'h' : ''; }
            else { ch = '.'; cls = 'dd'; }
          } else if (c.flag) {
            ch = state === 'lost' && !c.mine ? 'X' : '|>';
            cls = 'ms-f';
          } else if (state === 'lost' && c.mine) {
            ch = '*';
            cls = 'ms-h h';
          }
          if (boom && boom[0] === x && boom[1] === y) { ch = '*'; cls = 'inv'; }
          if (showCursor && cur.x === x && cur.y === y && (state === 'ready' || state === 'play')) cls += ' cur';
          g.set(ox + x, oy + y, ch, cls);
        }
      }

      let status = `${L.name}   best ${E.best(L.name) ?? '--'}${E.best(L.name) == null ? '' : 's'}`;
      if (state === 'lost') status = E.coarse ? 'BOOM!  tap the face to retry' : 'BOOM!  r: retry';
      if (state === 'won') status = newBest ? `cleared in ${seconds()}s, new best!` : `cleared in ${seconds()}s`;
      g.center(oy + L.h + 1, status, state === 'ready' || state === 'play' ? 'd' : 'h');
    }

    function boardCell(x, y) {
      const bx = x - ox, by = y - oy;
      return bx >= 0 && by >= 0 && bx < L.w && by < L.h ? [bx, by] : null;
    }

    E.on('key', (key) => {
      const d = keyDir(key);
      if (d) {
        showCursor = true;
        cur.x = clamp(cur.x + DIRS[d][0], 0, L.w - 1);
        cur.y = clamp(cur.y + DIRS[d][1], 0, L.h - 1);
      } else if (key === ' ' || key === 'Enter') { showCursor = true; reveal(cur.x, cur.y); }
      else if (key === 'f' || key === 'F') { showCursor = true; toggleFlag(cur.x, cur.y); }
      else if (key === 'r' || key === 'R') newGame();
      else if (LEVELS[key]) newGame(+key);
      else if (key === 'n') newGame(levelNo === 1 ? 2 : 1); // touch: three boards is too wide for a phone
      else if (key === 'm') {
        flagMode = !flagMode;
        if (flagBtn) flagBtn.textContent = `flag: ${flagMode ? 'on' : 'off'}`;
      }
    });
    E.on('tap', (x, y, button) => {
      if (y === 0 && Math.abs(x - g.cols / 2) <= 1.5) { newGame(); return; }
      const cell = boardCell(x, y);
      if (!cell) return;
      [cur.x, cur.y] = cell;
      if (button === 2 || flagMode) toggleFlag(...cell);
      else reveal(...cell);
    });
    E.on('hold', (x, y) => {
      const cell = boardCell(x, y);
      if (cell) toggleFlag(...cell);
    });

    E.summary(() => {
      if (state === 'won') return `minesweeper: cleared ${L.name} in ${seconds()}s, best ${E.best(L.name)}s`;
      if (state === 'lost') return `minesweeper: boom. ${opened} safe cells opened on ${L.name}`;
      return `minesweeper: left ${L.name} unfinished`;
    });
    newGame(1);
    E.loop(null, draw);
  };

  // ---------------------------------------------------------------- flappy bird

  GAMES.flappybird = (E) => {
    const g = E.grid;
    const W = 44, ROWS = 23, GROUND = 20, BX = 11, PW = 5, SPACING = 20, SPEED = 12.5;
    E.setup(W, ROWS, 1);
    E.hint('space / up / click to flap   p pause   q quit', 'tap anywhere to flap');
    E.controls([{ label: 'p', key: 'p' }, { label: 'q', key: 'q' }]);

    const stars = Array.from({ length: 26 }, () => [Math.random() * W, 1 + rand(16)]);
    let y, vy, pipes, score, state, t, deadT, scroll, newBest;

    function reset() {
      y = 9; vy = 0; pipes = []; score = 0; t = 0; deadT = 0; scroll = 0; newBest = false;
      state = 'ready';
    }

    function newPipe() {
      const size = score < 10 ? 7 : score < 25 ? 6 : 5;
      return { x: W, gap: 3 + rand(GROUND - size - 5), size, passed: false };
    }

    function hit() {
      const row = Math.round(y);
      if (row >= GROUND) return true;
      for (const p of pipes) {
        const px = Math.round(p.x);
        for (let bx = BX; bx <= BX + 1; bx++) {
          const solid = row < p.gap || row >= p.gap + p.size;
          const cap = row === p.gap - 1 || row === p.gap + p.size;
          if ((solid && bx >= px && bx < px + PW) || (cap && bx >= px - 1 && bx <= px + PW)) return true;
        }
      }
      return false;
    }

    function flap() {
      if (state === 'ready') state = 'play';
      if (state === 'play') vy = -13.5;
      else if (state === 'dead' && deadT > 600) reset();
    }

    function update(dt) {
      const s = dt / 1000;
      t += dt;
      if (state === 'ready') {
        y = 9 + Math.sin(t / 250) * 0.6;
        scroll += SPEED * s;
        return;
      }
      vy = Math.min(vy + 50 * s, 22);
      y += vy * s;
      if (state === 'dead') {
        deadT += dt;
        if (y > GROUND - 1) { y = GROUND - 1; vy = 0; }
        return;
      }
      scroll += SPEED * s;
      for (const p of pipes) p.x -= SPEED * s;
      pipes = pipes.filter((p) => p.x + PW + 1 > 0);
      if (!pipes.length || pipes[pipes.length - 1].x < W - SPACING) pipes.push(newPipe());
      for (const p of pipes) {
        if (!p.passed && p.x + PW < BX) { p.passed = true; score++; }
      }
      if (y < 1) { y = 1; vy = 0; }
      if (hit()) {
        state = 'dead';
        deadT = 0;
        newBest = E.record('score', score);
      }
    }

    function draw() {
      for (const [sx, sy] of stars) g.set((((sx - scroll * 0.15) % W) + W) % W, sy, '.', 'dd');

      for (const p of pipes) {
        const px = Math.round(p.x);
        for (let row = 1; row < GROUND; row++) {
          if (row >= p.gap && row < p.gap + p.size) continue;
          const cap = row === p.gap - 1 || row === p.gap + p.size;
          for (let x = cap ? px - 1 : px; x < (cap ? px + PW + 1 : px + PW); x++) {
            g.set(x, row, '', cap ? 'pipe-cap' : x === px + 1 ? 'pipe-hl' : 'pipe');
          }
        }
      }

      for (let x = 0; x < W; x++) {
        g.set(x, GROUND, '', 'ground');
        const k = x + Math.floor(scroll);
        g.set(x, GROUND + 1, k % 3 === 0 ? '/' : '', 'd');
        g.set(x, GROUND + 2, (k + 1) % 3 === 0 ? '/' : '', 'dd');
      }

      const row = Math.round(y);
      const wing = state === 'dead' ? '-' : ['^', '-', 'v'][Math.floor(t / 110) % 3];
      g.set(BX - 1, row, wing, 'h');
      g.set(BX, row, state === 'dead' ? 'x' : '@', 'h');
      g.set(BX + 1, row, '>', 'h');

      g.text(0, 0, `SCORE ${score}`, 'h');
      const best = `BEST ${Math.max(E.best('score') || 0, score)}`;
      g.text(W - best.length, 0, best, 'd');

      const sky = { y0: 1, h: GROUND - 1 };
      if (state === 'ready') g.banner(['FLAPPY BIRD', '', E.coarse ? 'tap to flap' : 'space to flap'], sky);
      if (state === 'dead' && deadT > 500) {
        g.banner(['GAME OVER', `score ${score}`, ...(newBest ? ['new best!'] : []), '',
          E.coarse ? 'tap to retry' : 'space: retry  q: quit'], sky);
      }
    }

    E.on('key', (key) => {
      if (key === ' ' || key === 'Enter' || keyDir(key) === 'up') flap();
      else if ((key === 'r' || key === 'R') && state === 'dead') reset();
    });
    E.on('press', () => flap());

    E.summary(() => `flappybird: score ${score}, best ${E.best('score') ?? score}`);
    reset();
    E.loop(update, draw);
  };

  window.RetroGames = { list: LIST, play };
})();
