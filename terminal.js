(() => {
  'use strict';

  const C = window.TERMINAL_CONFIG;
  const HOME = ['home', C.user];
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COARSE_POINTER = matchMedia('(pointer: coarse)').matches;

  const $ = (id) => document.getElementById(id);
  const crt = $('crt');
  const screen = $('screen');
  const out = $('output');
  const promptLine = $('prompt-line');
  const promptEl = $('prompt');
  const beforeEl = $('before');
  const cursorEl = $('cursor');
  const afterEl = $('after');
  const input = $('input');

  // ---------------------------------------------------------------- storage

  const store = {
    get(area, key) {
      try { return JSON.parse(window[area].getItem(key)); } catch { return null; }
    },
    set(area, key, value) {
      try { window[area].setItem(key, JSON.stringify(value)); } catch { /* private mode, quota */ }
    },
  };

  // ---------------------------------------------------------------- output

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function print(html = '', cls = '') {
    const div = document.createElement('div');
    div.className = cls ? `line ${cls}` : 'line';
    div.innerHTML = html;
    out.appendChild(div);
    scrollBottom();
    return div;
  }
  const printText = (text, cls) => print(esc(text), cls);
  const printErr = (text) => print(esc(text), 'err');

  let scrollQueued = false;
  function scrollBottom() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      screen.scrollTop = screen.scrollHeight;
    });
  }

  function spinner(label) {
    const el = print('', 'dim');
    const frames = ['|', '/', '-', '\\'];
    let i = 0;
    const tick = () => { el.textContent = `${label} ${frames[i++ % frames.length]}`; };
    tick();
    const t = setInterval(tick, 90);
    return () => { clearInterval(t); el.remove(); };
  }

  // Terminal width in characters, used to fit README tables to the screen.
  function termCols() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    probe.textContent = 'M'.repeat(100);
    out.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 100 || 10;
    probe.remove();
    return Math.max(24, Math.floor(out.clientWidth / ch) - 2);
  }

  // ---------------------------------------------------------------- filesystem

  const dir = () => ({ type: 'dir', children: Object.create(null) });
  const root = dir();
  root.children.home = dir();
  const homeNode = (root.children.home.children[C.user] = dir());
  const projectsNode = (homeNode.children.Projects = dir());
  const picturesNode = (homeNode.children.Pictures = dir());

  for (const p of C.pictures || []) {
    picturesNode.children[p.name] = { type: 'image', src: p.src, size: p.size };
  }

  let cwd = [...HOME];
  let oldCwd = [...HOME];

  function displayPath(segs) {
    const inHome = HOME.every((s, i) => segs[i] === s);
    if (inHome) return '~' + (segs.length > HOME.length ? '/' + segs.slice(HOME.length).join('/') : '');
    return '/' + segs.join('/');
  }

  function resolve(path) {
    let segs;
    let rest = path;
    if (rest === '~' || rest.startsWith('~/')) { segs = [...HOME]; rest = rest.slice(1); }
    else if (rest.startsWith('/')) segs = [];
    else segs = [...cwd];
    for (const part of rest.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') segs.pop();
      else segs.push(part);
    }
    return segs;
  }

  function nodeAt(segs) {
    let node = root;
    for (const s of segs) {
      if (node.type !== 'dir' || !Object.hasOwn(node.children, s)) return null;
      node = node.children[s];
    }
    return node;
  }

  // Returns { node, segs } or throws a bash-style error message.
  function lookup(cmd, path) {
    const segs = resolve(path);
    const node = nodeAt(segs);
    if (!node) throw new Error(`${cmd}: ${path}: No such file or directory`);
    if (path.endsWith('/') && node.type !== 'dir') throw new Error(`${cmd}: ${path}: Not a directory`);
    return { node, segs };
  }

  const sortedNames = (node) =>
    Object.keys(node.children).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  // ---------------------------------------------------------------- GitHub

  const RAW = 'https://raw.githubusercontent.com';
  const API = 'https://api.github.com';
  let projectsSource = 'github';

  async function fetchRepos() {
    const cached = store.get('sessionStorage', 'retro:repos');
    if (cached) return cached;
    const res = await fetch(`${API}/users/${encodeURIComponent(C.github)}/repos?per_page=100&sort=pushed`);
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const repos = (await res.json())
      .filter((r) => C.includeForks || !r.fork)
      .map((r) => ({
        name: r.name,
        branch: r.default_branch,
        description: r.description,
        language: r.language,
        size: r.size,
        pushed: r.pushed_at,
        url: r.html_url,
      }));
    store.set('sessionStorage', 'retro:repos', repos);
    return repos;
  }

  const projectsReady = (async () => {
    let repos;
    try {
      repos = await fetchRepos();
    } catch {
      projectsSource = 'offline';
      repos = (C.fallbackProjects || []).map((r) => ({ ...r, url: `https://github.com/${C.github}/${r.name}` }));
    }
    for (const repo of repos) projectsNode.children[`${repo.name}.git`] = { type: 'repo', repo };
    return repos;
  })();

  const readmeCache = new Map();

  function fetchReadme(repo) {
    if (!readmeCache.has(repo.name)) {
      const p = (async () => {
        const cacheKey = `retro:readme:${repo.name}`;
        const cached = store.get('sessionStorage', cacheKey);
        if (cached) return cached;

        let text = null;
        // raw.githubusercontent.com isn't rate limited, so try it first.
        const raw = await fetch(`${RAW}/${C.github}/${repo.name}/${repo.branch}/README.md`).catch(() => null);
        if (raw && raw.ok) text = await raw.text();
        else {
          // Falls back to the API, which also finds readme.md, README.rst, etc.
          const api = await fetch(`${API}/repos/${C.github}/${repo.name}/readme`, {
            headers: { Accept: 'application/vnd.github.raw' },
          });
          if (api.status === 404) throw new Error('no README in this repository');
          if (!api.ok) throw new Error(`GitHub answered ${api.status}`);
          text = await api.text();
        }
        store.set('sessionStorage', cacheKey, text);
        return text;
      })();
      p.catch(() => readmeCache.delete(repo.name));
      readmeCache.set(repo.name, p);
    }
    return readmeCache.get(repo.name);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('cannot read image'));
      img.src = src;
    });
  }

  // ---------------------------------------------------------------- markdown -> terminal

  const INLINE = new RegExp([
    /(`+)([\s\S]*?[^`])\1(?!`)/.source,                                                   // 1,2  code
    /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/.source,                  // 3,4  image
    /\[((?:!\[[^\]]*\]\([^)]*\)|[^\]])+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/.source, // 5,6 link
    /<(https?:\/\/[^>\s]+)>/.source,                                                      // 7    autolink
    /(https?:\/\/[^\s<]*[^\s<.,:;"')\]])/.source,                                         // 8    bare url
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source,                                                  // 9    bold
    /__(?=\S)([\s\S]*?\S)__/.source,                                                      // 10   bold
    /~~(?=\S)([\s\S]*?\S)~~/.source,                                                      // 11   strike
    /\*(?=[^\s*])([^*]*?[^\s*])\*/.source,                                                // 12   italic
  ].join('|'), 'g');

  function mdUrl(href, ctx, image) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return /^(https?|mailto):/i.test(href) ? href : null;
    if (href.startsWith('#')) return null;
    const base = image
      ? `${RAW}/${C.github}/${ctx.repo.name}/${ctx.repo.branch}/`
      : `https://github.com/${C.github}/${ctx.repo.name}/blob/${ctx.repo.branch}/`;
    try { return new URL(href.replace(/^\/+/, ''), base).href; } catch { return null; }
  }

  function inline(src, ctx, plain = false) {
    let html = '';
    let last = 0;
    for (const m of src.matchAll(INLINE)) {
      const before = src.slice(last, m.index);
      html += plain ? before : esc(before);
      last = m.index + m[0].length;

      if (m[2] !== undefined) {
        const code = m[2].replace(/^ (.*) $/, '$1');
        html += plain ? code : `<code>${esc(code)}</code>`;
      } else if (m[4] !== undefined) {
        const url = mdUrl(m[4], ctx, true);
        html += plain || !url
          ? `[image: ${plain ? m[3] || 'image' : esc(m[3] || 'image')}]`
          : `<span class="md-img"><img src="${esc(url)}" alt="${esc(m[3])}" loading="lazy" decoding="async"></span>`;
      } else if (m[6] !== undefined) {
        const url = mdUrl(m[6], ctx, false);
        if (plain) html += inline(m[5], ctx, true);
        else html += url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inline(m[5], ctx)}</a>` : inline(m[5], ctx);
      } else if (m[7] !== undefined || m[8] !== undefined) {
        const url = m[7] ?? m[8];
        html += plain ? url : `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
      } else if (m[9] !== undefined || m[10] !== undefined) {
        const t = m[9] ?? m[10];
        html += plain ? inline(t, ctx, true) : `<strong>${inline(t, ctx)}</strong>`;
      } else if (m[11] !== undefined) {
        html += plain ? inline(m[11], ctx, true) : `<del>${inline(m[11], ctx)}</del>`;
      } else if (m[12] !== undefined) {
        html += plain ? inline(m[12], ctx, true) : `<em>${inline(m[12], ctx)}</em>`;
      }
    }
    const rest = src.slice(last);
    return html + (plain ? rest : esc(rest));
  }

  const HTML_TAGS = /<\/?(?:p|div|span|b|i|u|strong|em|center|details|summary|sub|sup|picture|source|kbd|table|thead|tbody|tr|td|th|ul|ol|li|font|small|big|br|hr|img|a)\b[^>]*>/gi;

  // Turns the bits of inline HTML GitHub READMEs commonly use into markdown, leaving `code` alone.
  function htmlToMd(line) {
    return line.split(/(`+[^`]*`+)/).map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/gi, (_, n, t) => `${'#'.repeat(+n)} ${t}`)
        .replace(/<img\b[^>]*>/gi, (tag) => {
          const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
          const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
          return src ? `![${alt ? alt[1] : ''}](${src[1]})` : '';
        })
        .replace(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')
        .replace(/<\/?(?:b|strong)>/gi, '**')
        .replace(/<\/?(?:i|em)>/gi, '*')
        .replace(HTML_TAGS, '');
    }).join('');
  }

  const RE = {
    fence: /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/,
    heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
    tableRow: /^\s*\|.*\|\s*$/,
    li: /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/,
    quote: /^\s{0,3}>\s?(.*)$/,
  };

  function parseBlocks(md) {
    const lines = md.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const blocks = [];
    let para = null;
    let lastLi = null;

    const push = (b) => { blocks.push(b); para = null; if (b.t !== 'li') lastLi = null; };

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];

      const fence = rawLine.match(RE.fence);
      if (fence) {
        const buf = [];
        const close = fence[1];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) buf.push(lines[i++]);
        push({ t: 'code', lang: fence[2], text: buf.join('\n') });
        continue;
      }

      if (RE.tableRow.test(rawLine) && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
        const rows = [rawLine];
        i += 2;
        while (i < lines.length && RE.tableRow.test(lines[i])) rows.push(lines[i++]);
        i--;
        push({ t: 'table', rows });
        continue;
      }

      const line = htmlToMd(rawLine);
      let m;

      if (!line.trim()) {
        if (blocks.length && blocks[blocks.length - 1].t !== 'blank') push({ t: 'blank' });
        else para = null;
        continue;
      }
      if ((m = line.match(RE.heading))) { push({ t: 'h', level: m[1].length, text: m[2] }); continue; }
      if (RE.hr.test(line)) { push({ t: 'hr' }); continue; }
      if ((m = line.match(RE.quote))) {
        const prev = blocks[blocks.length - 1];
        if (prev && prev.t === 'quote' && !para) prev.lines.push(m[1]);
        else push({ t: 'quote', lines: [m[1]] });
        continue;
      }
      if ((m = line.match(RE.li))) {
        lastLi = { t: 'li', indent: m[1].replace(/\t/g, '  ').length, marker: m[2], text: m[3] };
        push(lastLi);
        continue;
      }
      // indented continuation of a list item
      if (lastLi && /^\s{2,}\S/.test(line)) { lastLi.text += ' ' + line.trim(); continue; }

      const hardBreak = / {2,}$|\\$/.test(line);
      const text = line.trim().replace(/\\$/, '');
      if (para) para.text += (para.br ? '\n' : ' ') + text;
      else { para = { t: 'p', text }; blocks.push(para); lastLi = null; }
      para.br = hardBreak;
    }
    while (blocks.length && blocks[blocks.length - 1].t === 'blank') blocks.pop();
    while (blocks.length && blocks[0].t === 'blank') blocks.shift();
    return blocks;
  }

  function wrapText(text, width) {
    const lines = [];
    for (const para of text.split('\n')) {
      let cur = '';
      for (let word of para.split(/\s+/).filter(Boolean)) {
        while ([...word].length > width) {
          if (cur) { lines.push(cur); cur = ''; }
          lines.push([...word].slice(0, width).join(''));
          word = [...word].slice(width).join('');
        }
        if (!cur) cur = word;
        else if ([...cur].length + 1 + [...word].length <= width) cur += ' ' + word;
        else { lines.push(cur); cur = word; }
      }
      lines.push(cur);
    }
    return lines.length ? lines : [''];
  }

  // Renders a markdown table as an ASCII box that fits the terminal width.
  function renderTable(rows, ctx) {
    const cells = rows.map((r) =>
      r.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|'), ctx, true)));
    const ncols = Math.max(...cells.map((r) => r.length));
    cells.forEach((r) => { while (r.length < ncols) r.push(''); });

    const widths = Array.from({ length: ncols }, (_, c) => Math.max(1, ...cells.map((r) => [...r[c]].length)));
    const budget = ctx.cols - (3 * ncols + 1);
    while (widths.reduce((a, b) => a + b, 0) > budget) {
      const max = Math.max(...widths);
      if (max <= 8) break;
      widths[widths.indexOf(max)]--;
    }

    const border = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
    const lines = [esc(border)];
    cells.forEach((row, ri) => {
      const wrapped = row.map((cell, c) => wrapText(cell, widths[c]));
      const height = Math.max(...wrapped.map((w) => w.length));
      for (let l = 0; l < height; l++) {
        const text = '| ' + wrapped.map((w, c) => pad(w[l] || '', widths[c])).join(' | ') + ' |';
        lines.push(ri === 0 ? `<span class="hl">${esc(text)}</span>` : esc(text));
      }
      if (ri === 0 || ri === cells.length - 1) lines.push(esc(border));
    });
    return `<div class="md-table">${lines.join('\n')}</div>`;
  }

  function renderMarkdown(md, ctx) {
    const html = [];
    for (const b of parseBlocks(md)) {
      switch (b.t) {
        case 'blank': html.push('<div class="line"></div>'); break;
        case 'hr': html.push('<hr class="md-hr">'); break;
        case 'p': html.push(`<div class="md-p">${inline(b.text, ctx)}</div>`); break;
        case 'code':
          html.push(`<div class="md-code">${b.lang ? `<span class="md-lang">${esc(b.lang)}</span>` : ''}<pre>${esc(b.text)}</pre></div>`);
          break;
        case 'table': html.push(renderTable(b.rows, ctx)); break;
        case 'quote': html.push(`<div class="md-quote">${b.lines.map((l) => inline(l, ctx)).join('\n')}</div>`); break;
        case 'li': {
          const bullet = /\d/.test(b.marker) ? b.marker : '*';
          html.push(`<div class="md-li" style="--indent:${b.indent}"><span class="dim">${esc(bullet)}</span> ${inline(b.text, ctx)}</div>`);
          break;
        }
        case 'h': {
          const len = Math.min([...inline(b.text, ctx, true)].length, ctx.cols);
          const body = inline(b.text, ctx);
          if (b.level === 1) html.push(`<div class="md-h md-h1">${body}\n${'='.repeat(len)}</div>`);
          else if (b.level === 2) html.push(`<div class="md-h md-h2">${body}\n${'-'.repeat(len)}</div>`);
          else html.push(`<div class="md-h"><span class="dim">${'#'.repeat(b.level)}</span> ${body}</div>`);
          break;
        }
      }
    }
    return html.join('');
  }

  // ---------------------------------------------------------------- commands

  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  function parseFlags(args, allowed) {
    const flags = new Set();
    const rest = [];
    for (const a of args) {
      if (/^-[a-zA-Z]+$/.test(a)) {
        for (const f of a.slice(1)) {
          if (!allowed.includes(f)) throw new Error(`invalid option -- '${f}'`);
          flags.add(f);
        }
      } else rest.push(a);
    }
    return { flags, rest };
  }

  const shellQuote = (s) => (/^[\w./~@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

  // Shortest way to name an absolute location from the current directory.
  function relPath(segs) {
    if (segs.length >= cwd.length && cwd.every((s, i) => segs[i] === s)) return segs.slice(cwd.length).join('/') || '.';
    if (segs.length === cwd.length - 1 && segs.every((s, i) => cwd[i] === s)) return '..';
    return displayPath(segs);
  }

  // ls entries remember where they point, so clicking them still works after a cd.
  function entryCommand(el) {
    const rel = shellQuote(relPath(resolve(el.dataset.path)));
    if (el.dataset.kind !== 'dir') return `cat ${rel}`;
    return rel === '.' ? 'ls' : `cd ${rel} && ls`;
  }

  function entryHTML(name, node, path) {
    const kind = node.type === 'dir' ? 'dir' : node.type === 'image' ? 'img' : 'file';
    const label = name + (node.type === 'dir' ? '/' : '');
    return `<span class="entry ${kind}" data-kind="${kind}" data-path="${esc(displayPath(resolve(path)))}">${esc(label)}</span>`;
  }

  function lsLong(name, node, path, cols) {
    const date = (iso) => {
      const d = iso ? new Date(iso) : new Date();
      return `${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getDate()).padStart(2)} ${d.getFullYear()}`;
    };
    const kb = (n) => (n == null ? '-' : n >= 1024 ? `${(n / 1024).toFixed(1)}M` : `${n}K`);
    let perms = '-rw-r--r--', group = 'users', size = '-', when = date(), desc = '';
    if (node.type === 'dir') { perms = 'drwxr-xr-x'; size = '4.0K'; }
    else if (node.type === 'repo') {
      group = (node.repo.language || 'text').toLowerCase();
      size = kb(node.repo.size);
      when = date(node.repo.pushed);
      desc = node.repo.description || '';
    } else if (node.type === 'image') size = node.size || '-';
    const meta = `${perms} 1 ${pad(C.user, 9)} ${pad(group, 10)} ${size.padStart(5)} ${when}  `;
    // keep each entry on one line: trim the description to whatever room is left
    const room = cols - [...meta].length - [...name].length - 4;
    if (desc && room >= 12) {
      if ([...desc].length > room) desc = [...desc].slice(0, room - 3).join('') + '...';
      desc = `  <span class="dim"># ${esc(desc)}</span>`;
    } else desc = '';
    return esc(meta) + entryHTML(name, node, path) + desc;
  }

  function joinPath(base, name) {
    if (base === '.' || base === '') return name;
    return base.endsWith('/') ? base + name : `${base}/${name}`;
  }

  const commands = {
    help: {
      usage: 'help',
      desc: 'show this list',
      run() {
        const rows = Object.entries(commands).filter(([, c]) => c.desc);
        const w = Math.max(...rows.map(([, c]) => c.usage.length)) + 3;
        print('Available commands:', 'hl');
        for (const [name, c] of rows) {
          print(`  <span class="click" data-cmd="${esc(name)}">${esc(c.usage)}</span>${' '.repeat(w - c.usage.length)}<span class="dim">${esc(c.desc)}</span>`);
        }
        print();
        printText('Tab completes names, Up/Down walks history, Ctrl+C cancels, Ctrl+L clears.', 'dim');
        printText('Click any name in ls output to open it.', 'dim');
      },
    },

    whoami: {
      usage: 'whoami',
      desc: 'who is behind this terminal',
      run() { printText(C.whoami); },
    },

    pwd: {
      usage: 'pwd',
      desc: 'where I am studying',
      run() { printText(C.pwd); },
    },

    ls: {
      usage: 'ls [-la] [dir]',
      desc: 'list files (try: ls Projects/)',
      async run(args, { signal }) {
        const { flags, rest } = parseFlags(args, ['l', 'a']);
        await abortable(projectsReady, signal);
        const targets = rest.length ? rest : ['.'];
        const cols = termCols();
        let status = 0;
        targets.forEach((path, ti) => {
          let found;
          try { found = lookup('ls', path); } catch (e) { printErr(`ls: cannot access '${path}': No such file or directory`); status = 2; return; }
          const { node } = found;
          if (targets.length > 1) { if (ti) print(); printText(`${path}:`); }

          if (node.type !== 'dir') {
            const name = path.split('/').filter(Boolean).pop();
            print(flags.has('l') ? lsLong(name, node, path, cols) : entryHTML(name, node, path));
            return;
          }
          const names = sortedNames(node);
          const items = names.map((n) => [n, node.children[n], joinPath(path, n)]);
          if (flags.has('a')) items.unshift(['.', node, path], ['..', nodeAt(resolve(joinPath(path, '..'))) || root, joinPath(path, '..')]);

          if (flags.has('l')) {
            printText(`total ${items.length * 4}`);
            for (const [n, child, p] of items) print(lsLong(n, child, p, cols));
          } else if (items.length) {
            print(items.map(([n, child, p]) => entryHTML(n, child, p)).join(''), 'ls-grid');
          }
          if (node === projectsNode && projectsSource === 'offline') {
            printText('(offline index: GitHub API unreachable, showing saved project list)', 'dim');
          }
        });
        return status;
      },
    },

    cd: {
      usage: 'cd [dir]',
      desc: 'change directory (cd .., cd ~, cd -)',
      async run(args, { signal }) {
        await abortable(projectsReady, signal);
        let path = args[0] ?? '~';
        if (args.length > 1) throw new Error('cd: too many arguments');
        if (path === '-') { path = displayPath(oldCwd); printText(path); }
        const { node, segs } = lookup('cd', path);
        if (node.type !== 'dir') throw new Error(`cd: ${path}: Not a directory`);
        oldCwd = cwd;
        cwd = segs;
        updatePrompt();
      },
    },

    cat: {
      usage: 'cat <file>',
      desc: 'read a project README or view a picture',
      async run(args, { signal }) {
        if (!args.length) throw new Error('cat: missing file operand (try: cat Projects/nopork.git)');
        await abortable(projectsReady, signal);
        let status = 0;
        for (const path of args) {
          let node;
          try { ({ node } = lookup('cat', path)); } catch (e) { printErr(e.message); status = 1; continue; }

          if (node.type === 'dir') { printErr(`cat: ${path}: Is a directory`); status = 1; continue; }

          if (node.type === 'repo') {
            const { repo } = node;
            const stop = spinner(`fetching README.md from github.com/${C.github}/${repo.name}`);
            let text;
            try { text = await abortable(fetchReadme(repo), signal); }
            catch (e) { if (e.name === 'AbortError') throw e; printErr(`cat: ${path}: ${e.message}`); status = 1; continue; }
            finally { stop(); }
            const box = print(renderMarkdown(text, { repo, cols: termCols() }), 'md');
            box.classList.remove('line');
            box.querySelectorAll('img').forEach((img) => {
              img.addEventListener('error', () => img.parentElement.replaceWith(`[image: ${img.alt || 'unavailable'}]`), { once: true });
            });
            print(`<span class="md-foot">-- <a href="${esc(repo.url)}" target="_blank" rel="noopener noreferrer">${esc(repo.url.replace(/^https:\/\//, ''))}</a> --</span>`);
          }

          if (node.type === 'image') {
            const stop = spinner(`decoding ${path}`);
            let img;
            try { img = await abortable(loadImage(node.src), signal); }
            catch (e) { if (e.name === 'AbortError') throw e; printErr(`cat: ${path}: ${e.message}`); status = 1; continue; }
            finally { stop(); }
            img.alt = path;
            const wrap = document.createElement('div');
            wrap.className = REDUCED_MOTION ? 'pic' : 'pic reveal';
            wrap.appendChild(img);
            const holder = print();
            holder.appendChild(wrap);
            printText(`${path.split('/').pop()}  ${img.naturalWidth}x${img.naturalHeight}`, 'dim');
          }
        }
        return status;
      },
    },

    open: {
      usage: 'open <file>',
      desc: 'open a project on GitHub, or a picture, in a new tab',
      async run(args, { signal }) {
        await abortable(projectsReady, signal);
        const path = args[0] ?? '.';
        const { node, segs } = lookup('open', path);
        let url;
        if (node.type === 'repo') url = node.repo.url;
        else if (node.type === 'image') url = new URL(node.src, location.href).href;
        else if (node === projectsNode || segs.length <= HOME.length) url = `https://github.com/${C.github}`;
        else throw new Error(`open: ${path}: nothing to open`);
        print(`opening <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
        window.open(url, '_blank', 'noopener');
      },
    },

    neofetch: {
      usage: 'neofetch',
      desc: 'system info',
      async run(args, { signal }) {
        const repos = await abortable(projectsReady, signal);
        const langs = [...new Set(repos.map((r) => r.language).filter(Boolean))];
        const logo = [
          '    _      ____  ',
          '   / \\    / ___| ',
          '  / _ \\   \\___ \\ ',
          ' / ___ \\   ___) |',
          '/_/   \\_\\ |____/ ',
        ];
        const up = Math.floor((Date.now() - started) / 1000);
        const title = `${C.user}@${C.host}`;
        const kv = (k, v) => `<span class="hl">${esc(k)}:</span> ${esc(v)}`;
        const info = [
          `<span class="hl">${esc(title)}</span>`,
          '-'.repeat(title.length),
          kv('Who', C.whoami),
          kv('School', C.pwd),
          kv('OS', 'HumanOS x86'),
          kv('Uptime', up < 60 ? `${up} secs` : `${Math.floor(up / 60)} mins`),
          kv('Shell', 'rsh 1.0'),
          kv('Terminal', 'cool-retro-web'),
          kv('GitHub', `github.com/${C.github}`),
          kv('Projects', String(repos.length)),
          kv('Languages', langs.join(', ') || 'n/a'),
          kv('Theme', document.documentElement.dataset.theme),
          '',
          [1, 0.8, 0.6, 0.4, 0.2].map((o) => `<span class="swatch" style="opacity:${o}"></span>`).join(''),
        ];
        print(`<div class="fetch"><pre>${esc(logo.join('\n'))}</pre><pre>${info.join('\n')}</pre></div>`);
      },
    },

    theme: {
      usage: 'theme [name]',
      desc: 'phosphor color: green, amber, white',
      run(args) {
        const themes = ['green', 'amber', 'white'];
        if (!args.length) {
          printText(`current: ${document.documentElement.dataset.theme}`);
          print(`available: ${themes.map((t) => `<span class="click" data-cmd="theme ${t}">${t}</span>`).join('  ')}`);
          return;
        }
        if (!themes.includes(args[0])) throw new Error(`theme: unknown theme '${args[0]}' (choose: ${themes.join(', ')})`);
        setTheme(args[0]);
        store.set('localStorage', 'retro:theme', args[0]);
      },
    },

    history: {
      usage: 'history',
      desc: 'show command history',
      run() {
        const w = String(history.length).length;
        history.forEach((h, i) => printText(`${String(i + 1).padStart(w + 2)}  ${h}`));
      },
    },

    echo: {
      usage: 'echo <text>',
      desc: 'print text',
      run(args) { printText(args.join(' ')); },
    },

    date: {
      usage: 'date',
      desc: 'print the date',
      run() { printText(new Date().toString().replace(/ \(.*\)$/, '')); },
    },

    clear: {
      usage: 'clear',
      desc: 'clear the screen',
      run() { out.innerHTML = ''; },
    },

    // undocumented
    sudo: { run() { printErr(`${C.user} is not in the sudoers file. This incident will be reported.`); return 1; } },
    exit: { run() { printText('logout'); printText('There is no escape. Type help instead.', 'dim'); } },
    rm: { run() { printErr('rm: permission denied: this is a read-only museum'); return 1; } },
  };

  // ---------------------------------------------------------------- shell

  function parseLine(line) {
    const cmds = [];
    let argv = [];
    let cur = '';
    let has = false;
    let quote = null;
    let op = null;
    const endArg = () => { if (has) argv.push(cur); cur = ''; has = false; };
    const endCmd = (next) => { endArg(); if (argv.length) cmds.push({ argv, op }); argv = []; op = next; };

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
        else cur += c;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; has = true; }
      else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; }
      else if (/\s/.test(c)) endArg();
      else if (c === ';') endCmd(';');
      else if (c === '&' && line[i + 1] === '&') { i++; endCmd('&&'); }
      else if (c === '|' && line[i + 1] === '|') { i++; endCmd('||'); }
      else { cur += c; has = true; }
    }
    if (quote) throw new Error('rsh: unexpected EOF while looking for matching quote');
    endCmd(null);
    return cmds;
  }

  async function runLine(line, signal) {
    let status = 0;
    for (const { argv, op } of parseLine(line)) {
      if ((op === '&&' && status !== 0) || (op === '||' && status === 0)) continue;
      const [name, ...args] = argv;
      if (!Object.hasOwn(commands, name)) {
        printErr(`${name}: command not found`);
        status = 127;
        continue;
      }
      try {
        status = (await commands[name].run(args, { signal })) || 0;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        printErr(e.message.startsWith(`${name}:`) ? e.message : `${name}: ${e.message}`);
        status = 1;
      }
    }
  }

  // ---------------------------------------------------------------- prompt & input

  const history = store.get('localStorage', 'retro:history') || [];
  let histIndex = history.length;
  let draft = '';
  let busy = true;
  let job = null;
  const started = Date.now();

  function promptHTML() {
    return `<span class="p-user">${esc(C.user)}@${esc(C.host)}</span>:<span class="p-path">${esc(displayPath(cwd))}</span>$ `;
  }

  function updatePrompt() {
    promptEl.innerHTML = promptHTML();
    document.title = `${C.user}@${C.host}: ${displayPath(cwd)}`;
  }

  function render() {
    const v = input.value;
    const s = input.selectionStart ?? v.length;
    beforeEl.textContent = v.slice(0, s);
    cursorEl.textContent = v[s] ?? ' ';
    afterEl.textContent = v.slice(s + 1);
  }

  function restartBlink() {
    cursorEl.style.animation = 'none';
    void cursorEl.offsetWidth;
    cursorEl.style.animation = '';
  }

  function setInput(value) {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    render();
  }

  function setBusy(b) {
    busy = b;
    promptLine.hidden = b;
    if (!b) { render(); scrollBottom(); }
  }

  async function submit() {
    const line = input.value;
    const echo = print(promptHTML() + esc(line));
    setInput('');
    if (line.trim()) {
      if (history[history.length - 1] !== line) history.push(line);
      if (history.length > 200) history.splice(0, history.length - 200);
      store.set('localStorage', 'retro:history', history);
    }
    histIndex = history.length;
    draft = '';

    if (!line.trim()) return;
    setBusy(true);
    job = new AbortController();
    try {
      await runLine(line, job.signal);
    } catch (e) {
      if (e.name !== 'AbortError') printErr(e.message);
    } finally {
      job = null;
      setBusy(false);
      revealOutput(echo);
    }
  }

  // If a command printed more than a screenful (a long README), show it from the top.
  function revealOutput(echo) {
    requestAnimationFrame(() => {
      if (!echo.isConnected) return;
      const top = echo.offsetTop - 8;
      if (screen.scrollHeight - top > screen.clientHeight) screen.scrollTop = top;
    });
  }

  // Types a command into the prompt and runs it, used by clickable output.
  let autotyping = false;
  async function typeAndRun(cmd) {
    if (busy || autotyping) return;
    autotyping = true;
    setInput('');
    for (const ch of cmd) {
      setInput(input.value + ch);
      if (!REDUCED_MOTION) await delay(14);
    }
    autotyping = false;
    await submit();
    if (!COARSE_POINTER) focusInput(); // don't pop up a phone keyboard over the output
  }

  function completeAt() {
    const v = input.value;
    const s = input.selectionStart ?? v.length;
    const before = v.slice(0, s);
    const word = before.match(/(\S*)$/)[1];
    const head = before.slice(0, before.length - word.length);
    const isCommand = /^\s*$|(;|&&|\|\|)\s*$/.test(head);

    let candidates;
    if (isCommand) {
      candidates = Object.keys(commands).filter((c) => commands[c].desc && c.startsWith(word)).map((c) => c + ' ');
    } else {
      const cmd = head.trim().split(/\s+/).pop();
      const slash = word.lastIndexOf('/');
      const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
      const base = slash >= 0 ? word.slice(slash + 1) : word;
      const node = nodeAt(resolve(dirPart || '.'));
      if (!node || node.type !== 'dir') return;
      let names = sortedNames(node).filter((n) => n.startsWith(base));
      if (!names.length) names = sortedNames(node).filter((n) => n.toLowerCase().startsWith(base.toLowerCase()));
      if (cmd === 'cd') names = names.filter((n) => node.children[n].type === 'dir');
      candidates = names.map((n) => dirPart + n + (node.children[n].type === 'dir' ? '/' : ' '));
    }
    if (!candidates.length) return;

    let common = candidates[0];
    for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);

    if (common.length > word.length || (candidates.length === 1 && common !== word)) {
      const next = head + common + v.slice(s);
      input.value = next;
      const pos = head.length + common.length;
      input.setSelectionRange(pos, pos);
      render();
    } else if (candidates.length > 1) {
      print(promptHTML() + esc(v));
      printText(candidates.map((c) => c.trim().split('/').filter(Boolean).pop() + (c.endsWith('/') ? '/' : '')).join('  '));
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
      if (window.getSelection().toString()) return; // let people copy
      e.preventDefault();
      if (job) { print('^C', 'dim'); job.abort(); return; }
      if (busy) return;
      print(promptHTML() + esc(input.value) + '^C');
      setInput('');
      histIndex = history.length;
      return;
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      out.innerHTML = '';
      return;
    }
    if (busy || autotyping) {
      if (!e.metaKey && !e.ctrlKey) e.preventDefault();
      return;
    }

    restartBlink();
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        submit();
        return;
      case 'Tab':
        e.preventDefault();
        completeAt();
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (histIndex === history.length) draft = input.value;
        if (histIndex > 0) setInput(history[--histIndex]);
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (histIndex < history.length) {
          histIndex++;
          setInput(histIndex === history.length ? draft : history[histIndex]);
        }
        return;
    }
    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const s = input.selectionStart;
      if (k === 'a') { e.preventDefault(); input.setSelectionRange(0, 0); }
      else if (k === 'e') { e.preventDefault(); input.setSelectionRange(input.value.length, input.value.length); }
      else if (k === 'u') { e.preventDefault(); input.value = input.value.slice(s); input.setSelectionRange(0, 0); }
      else if (k === 'k') { e.preventDefault(); input.value = input.value.slice(0, s); }
      else if (k === 'w') {
        e.preventDefault();
        const left = input.value.slice(0, s).replace(/\S+\s*$/, '');
        input.value = left + input.value.slice(s);
        input.setSelectionRange(left.length, left.length);
      }
    }
    requestAnimationFrame(render);
  });

  input.addEventListener('input', () => { restartBlink(); render(); scrollBottom(); });
  document.addEventListener('selectionchange', () => { if (document.activeElement === input) render(); });
  input.addEventListener('focus', () => crt.classList.remove('blurred'));
  input.addEventListener('blur', () => crt.classList.add('blurred'));

  function focusInput() {
    input.focus({ preventScroll: true });
  }

  screen.addEventListener('click', (e) => {
    const entry = e.target.closest('[data-path]');
    if (entry) { typeAndRun(entryCommand(entry)); return; }
    const target = e.target.closest('[data-cmd]');
    if (target) { typeAndRun(target.dataset.cmd); return; }
    if (e.target.closest('a')) return;
    if (window.getSelection().toString()) return;
    focusInput();
  });

  // Typing anywhere goes to the terminal.
  document.addEventListener('keydown', (e) => {
    if (document.activeElement !== input && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) focusInput();
  });

  if (window.visualViewport) visualViewport.addEventListener('resize', scrollBottom);

  // ---------------------------------------------------------------- theme

  function setTheme(name) {
    document.documentElement.dataset.theme = name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg-edge').trim() || '#050805';
  }
  setTheme(store.get('localStorage', 'retro:theme') || C.theme || 'green');

  // ---------------------------------------------------------------- boot

  async function boot() {
    let skip = REDUCED_MOTION;
    const skipper = () => { skip = true; };
    window.addEventListener('keydown', skipper, { once: true });
    screen.addEventListener('pointerdown', skipper, { once: true });
    const wait = (ms) => (skip ? Promise.resolve() : delay(ms));

    if (!skip) {
      crt.classList.add('booting');
      setTimeout(() => crt.classList.remove('booting'), 700);
      await wait(380);
    }

    const ok = (msg) => print(`[  <span class="hl">OK</span>  ] ${esc(msg)}`);
    printText('RetroBIOS v2.6  (C) 1984 altynkhan systems', 'dim');
    await wait(90);
    printText('Memory test: 640K OK', 'dim');
    await wait(90);
    ok(`Mounted /home/${C.user}`);
    await wait(70);
    ok('Started phosphor-glow.service');
    await wait(70);

    const repos = await Promise.race([projectsReady, delay(2500).then(() => null)]);
    if (repos && projectsSource === 'github') ok(`Synced ${repos.length} repositories from github.com/${C.github}`);
    else print(`[ <span class="hl">WARN</span> ] GitHub unreachable, using offline project index`);
    await wait(120);

    print();
    const now = new Date();
    printText(`Last login: ${now.toDateString()} ${now.toTimeString().slice(0, 8)} on tty1`);
    print(`Type <span class="click hl" data-cmd="help">help</span> to see available commands.`);
    print();

    window.removeEventListener('keydown', skipper);
    updatePrompt();
    setBusy(false);
    focusInput();
    if (document.activeElement !== input) crt.classList.add('blurred');
  }

  boot();
})();
