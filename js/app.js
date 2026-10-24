// app.js — 个人云端知识库（阅读 + 写作 + AI）
import { splitFrontmatter, renderMarkdown, stripMarkdown, stringifyFrontmatter, withTags } from './md.js';
import { GitHub, GitHubError } from './github.js';
import { files, assets, drafts, pending, meta, loadConfig, saveConfig, DEFAULT_CONFIG } from './store.js';

/* ==================== 状态 ==================== */

const state = {
  cfg: loadConfig(),
  gh: null,
  index: new Map(), // path -> { sha, size }
  alias: new Map(), // 小写文件名(不含扩展) -> path
  texts: new Map(), // path -> text
  assetUrls: new Map(),
  syncing: false,
  syncPromise: null,
  inflight: new Map(),
  lastSync: 0,
  chat: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => $('#app');

const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp)$/i;
const MD_EXT = /\.md$/i;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const baseName = (p) => String(p).split('/').pop();
const stripExt = (p) => baseName(p).replace(/\.[^.]+$/, '');
const dirName = (p) => (String(p).includes('/') ? String(p).slice(0, String(p).lastIndexOf('/')) : '');

/* ==================== 配置 ==================== */

function cfgReady() {
  return Boolean(state.cfg.owner && state.cfg.repo && state.cfg.token);
}

function applyConfig(cfg) {
  state.cfg = cfg;
  saveConfig(cfg);
  state.gh = cfgReady() ? new GitHub({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, token: cfg.token }) : null;
}

/* ==================== 同步 ==================== */

async function refreshIndex() {
  if (!state.gh) throw new Error('还没配置仓库');
  const tree = await state.gh.tree();
  state.index.clear();
  state.alias.clear();
  for (const node of tree) {
    state.index.set(node.path, { sha: node.sha, size: node.size || 0 });
  }
  for (const path of state.index.keys()) {
    const key = stripExt(path).toLowerCase();
    if (!state.alias.has(key)) state.alias.set(key, path);
  }
  state.lastSync = Date.now();
  await meta.set('lastIndex', [...state.index.keys()]);
}

async function ensureText(path) {
  if (state.texts.has(path)) return state.texts.get(path);
  if (state.inflight.has(path)) return state.inflight.get(path);
  const task = (async () => {
    const entry = state.index.get(path);
    const cached = await files.get(path);
    if (cached && entry && cached.sha === entry.sha) {
      state.texts.set(path, cached.text);
      return cached.text;
    }
    const { text, sha } = await state.gh.getText(path);
    state.texts.set(path, text);
    if (entry) entry.sha = sha;
    await files.put({ path, sha, text });
    return text;
  })();
  state.inflight.set(path, task);
  try {
    return await task;
  } finally {
    state.inflight.delete(path);
  }
}

/** 把所有文本拉一遍（用于搜索、AI、反链） */
async function syncAll(onProgress) {
  const paths = [...state.index.keys()].filter((p) => MD_EXT.test(p));
  let done = 0;
  const CONCURRENCY = 6;
  const queue = [...paths];

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      try {
        await ensureText(p);
      } catch (e) {
        console.warn('同步失败', p, e.message);
      }
      done++;
      if (onProgress) onProgress(done, paths.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/* ==================== 知识库查询 ==================== */

function dailyPaths() {
  const dir = state.cfg.dailyDir || '日得';
  return [...state.index.keys()].filter((p) => p.startsWith(dir + '/') && MD_EXT.test(p));
}

function dailyPathFor(dateStr) {
  return `${state.cfg.dailyDir || '日得'}/${dateStr}.md`;
}

function collectTags() {
  const counter = new Map();
  for (const text of state.texts.values()) {
    const { data } = splitFrontmatter(text);
    const tags = Array.isArray(data.tags) ? data.tags : data.tags ? String(data.tags).split(/[,\s]+/) : [];
    for (const t of tags) {
      const k = String(t).trim();
      if (k) counter.set(k, (counter.get(k) || 0) + 1);
    }
  }
  return [...counter.entries()].sort((a, b) => b[1] - a[1]);
}

function resolveWiki(name) {
  const key = stripExt(String(name).trim()).toLowerCase();
  const path = state.alias.get(key);
  if (!path) return { exists: false };
  return { exists: true, path, title: stripExt(path) };
}

function resolveAsset(name) {
  const raw = String(name).trim();
  if (raw.includes('/') && state.index.has(raw)) return 'asset://' + encodeURIComponent(raw);
  const key = baseName(raw).toLowerCase();
  for (const path of state.index.keys()) {
    if (IMG_EXT.test(path) && baseName(path).toLowerCase() === key) {
      return 'asset://' + encodeURIComponent(path);
    }
  }
  return null;
}

const RENDER_CTX = { resolveWiki, resolveAsset };

function renderBody(text) {
  const { body } = splitFrontmatter(text);
  return renderMarkdown(body, RENDER_CTX);
}

/** 把 asset:// 占位图换成真正的 blob 地址 */
async function hydrateImages(root) {
  const imgs = [...root.querySelectorAll('img[src^="asset://"]')];
  await Promise.all(
    imgs.map(async (img) => {
      const path = decodeURIComponent(img.getAttribute('src').slice('asset://'.length));
      try {
        img.src = await assetUrl(path);
      } catch {
        const span = document.createElement('span');
        span.className = 'md-broken';
        span.textContent = `图片加载失败：${baseName(path)}`;
        img.replaceWith(span);
      }
    }),
  );
}

async function assetUrl(path) {
  if (state.assetUrls.has(path)) return state.assetUrls.get(path);
  const cached = await assets.get(path);
  let blob = cached?.blob;
  if (!blob) {
    const res = await state.gh.getBlob(path);
    blob = res.blob;
    await assets.put({ path, blob, fetchedAt: Date.now() });
  }
  const url = URL.createObjectURL(blob);
  state.assetUrls.set(path, url);
  return url;
}

/* ==================== 保存 ==================== */

async function saveText(path, text) {
  const entry = state.index.get(path);
  try {
    const { sha } = await state.gh.putText(path, text, { sha: entry?.sha || null });
    state.index.set(path, { sha, size: text.length });
    state.texts.set(path, text);
    await files.put({ path, sha, text });
    await drafts.del(path);
    await pending.del(path);
    return { ok: true };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 409) {
      return { ok: false, conflict: true, error: '云端版本已被改动' };
    }
    if (e instanceof TypeError || !navigator.onLine) {
      await drafts.put({ path, text, at: Date.now() });
      await pending.put({ path, text, at: Date.now() });
      return { ok: false, offline: true, error: '离线，已存本地' };
    }
    throw e;
  }
}

async function flushPending() {
  if (!state.gh || !navigator.onLine) return 0;
  const items = await pending.all();
  let n = 0;
  for (const it of items) {
    try {
      await saveText(it.path, it.text);
      n++;
    } catch {
      /* 留着下次 */
    }
  }
  return n;
}

/* ==================== Toast ==================== */

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

/* ==================== 路由 ==================== */

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  return { path: p || '/', query: new URLSearchParams(q || '') };
}

let routeToken = 0;

function go(hash) {
  location.hash = hash;
}

async function route() {
  const token = ++routeToken;
  const { path, query } = parseHash();
  const root = app();
  root.innerHTML = '';
  setActiveTab(path);

  if (!cfgReady()) return viewSettings(root, { firstRun: true });

  try {
    if (path === '/' || path === '') return await viewHome(root, token);
    if (path.startsWith('/note/')) return await viewNote(root, decodeURIComponent(path.slice(6)), token);
    if (path.startsWith('/edit/')) return await viewEdit(root, decodeURIComponent(path.slice(6)));
    if (path === '/new') {
      const p = dailyPathFor(query.get('date') || todayStr());
      return await viewEdit(root, p, { isNew: !state.index.has(p) });
    }
    if (path === '/search') return await viewSearch(root, query.get('q') || '');
    if (path === '/all') return await viewAll(root);
    if (path === '/ask') return await viewAsk(root);
    if (path === '/tags') return await viewTags(root);
    if (path === '/settings') return await viewSettings(root);
    root.innerHTML = `<div class="empty">页面不存在</div>`;
  } catch (e) {
    console.error(e);
    if (token !== routeToken) return; // 已经切到别的页面了，别拿错误页盖掉
    root.innerHTML = `<div class="empty"><p>出错了：${esc(e.message)}</p>
      <button class="btn" onclick="location.reload()">刷新重试</button></div>`;
  }
}

function setActiveTab(path) {
  for (const a of document.querySelectorAll('.tabbar a')) {
    const target = a.getAttribute('data-tab');
    const on =
      (target === '/' && path === '/') ||
      (target === '/search' && path === '/search') ||
      (target === '/ask' && path === '/ask') ||
      (target === '/settings' && path === '/settings');
    a.classList.toggle('on', on);
  }
}

/* ==================== 工具 ==================== */

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dateParts(dateStr) {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { year: m[1], month: m[2], day: m[3], week: WEEK_CN[d.getDay()] };
}

function dateFromPath(path) {
  const m = baseName(path).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return Math.floor(diff / 86400e3) + ' 天前';
}

/* ==================== 视图：时间流 ==================== */

async function viewHome(root, token) {
  const cfg = state.cfg;
  const dir = cfg.dailyDir || '日得';
  const all = dailyPaths().sort().reverse();
  const filterTag = new URLSearchParams(location.hash.split('?')[1] || '').get('tag');

  let paths = all;
  if (filterTag) {
    const hits = [];
    for (const p of all) {
      const t = state.texts.get(p);
      if (!t) continue;
      const { data } = splitFrontmatter(t);
      const tags = Array.isArray(data.tags) ? data.tags : [];
      if (tags.includes(filterTag)) hits.push(p);
    }
    paths = hits;
  }

  root.innerHTML = `
    <div class="page-head">
      <h1 class="site-title">日得</h1>
      <div class="head-actions">
        <a class="ghost" href="#/all">全部</a>
        <a class="ghost" href="#/tags">标签</a>
        <a class="ghost" href="#/settings">设置</a>
      </div>
    </div>
    <p class="site-sub">${paths.length} 篇 · ${state.lastSync ? '同步于 ' + relTime(state.lastSync) : '尚未同步'}</p>
    <div id="timeline" class="timeline"></div>
    <div class="load-more-wrap"><button class="btn ghost" id="loadMore">加载更多</button></div>
  `;

  const tl = $('#timeline', root);
  let shown = 0;
  const PAGE = 8;

  async function renderMore() {
    const slice = paths.slice(shown, shown + PAGE);
    shown += slice.length;
    for (const p of slice) {
      if (token !== routeToken || !tl.isConnected) return; // 页面已经切走了
      const card = document.createElement('article');
      card.className = 'day';
      const ds = dateFromPath(p) || stripExt(p);
      const parts = dateParts(ds);
      card.innerHTML = `
        <div class="day-head">
          <a class="day-date" href="#/note/${encodeURIComponent(p)}">
            ${parts ? `<span class="d-num">${parts.month}</span><span class="d-slash">/</span><span class="d-num">${parts.day}</span>` : esc(ds)}
          </a>
          <span class="day-meta">${parts ? parts.week : ''}${parts ? ' · ' + parts.year : ''}</span>
          <a class="day-edit ghost" href="#/edit/${encodeURIComponent(p)}">写</a>
        </div>
        <div class="day-body prose"></div>
      `;
      tl.appendChild(card);
      try {
        const text = await ensureText(p);
        const { data, body } = splitFrontmatter(text);
        const bodyEl = $('.day-body', card);
        bodyEl.innerHTML = renderMarkdown(body, RENDER_CTX);
        hydrateImages(bodyEl);
        if (bodyEl.scrollHeight > bodyEl.clientHeight + 2) bodyEl.classList.add('clipped');
        const tags = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
        if (tags.length) {
          const tagRow = document.createElement('div');
          tagRow.className = 'tag-row';
          tagRow.innerHTML = tags.map((t) => `<a class="tag" href="#/?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('');
          card.appendChild(tagRow);
        }
      } catch (e) {
        $('.day-body', card).innerHTML = `<p class="muted">读取失败：${esc(e.message)}</p>`;
      }
    }
    const more = $('#loadMore');
    if (more) more.style.display = shown < paths.length ? '' : 'none';
  }

  $('#loadMore').addEventListener('click', renderMore);
  await renderMore();
  if (!paths.length) {
    const dir = cfg.dailyDir || '日得';
    tl.innerHTML = `<div class="empty"><p>还没有日记。</p>
      <a class="btn" href="#/new">写今天（${todayStr()}）</a>
      <p class="muted small">文件会存到 ${esc(dir)}/${todayStr()}.md</p></div>`;
  }
}

/* ==================== 视图：阅读 ==================== */

async function viewNote(root, path, token) {
  const text = await ensureText(path);
  if (token !== undefined && token !== routeToken) return;
  const { data, body } = splitFrontmatter(text);
  const tags = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
  const ds = dateFromPath(path);
  const parts = ds ? dateParts(ds) : null;

  root.innerHTML = `
    <div class="note-head">
      <a class="back" href="#/">←</a>
      <div class="note-title">
        ${data.title ? `<h1>${esc(data.title)}</h1>` : ''}
        ${parts ? `<div class="note-date">${parts.year} 年 ${parts.month} 月 ${parts.day} 日 · ${parts.week}</div>` : `<div class="note-date">${esc(baseName(path))}</div>`}
      </div>
      <a class="btn small" href="#/edit/${encodeURIComponent(path)}">编辑</a>
    </div>
    <article class="prose"></article>
    <div class="tag-row"></div>
    <section class="backlinks"></section>
  `;

  const article = $('.prose', root);
  article.innerHTML = renderMarkdown(body, RENDER_CTX);
  hydrateImages(article);

  if (tags.length) {
    $('.tag-row', root).innerHTML = tags
      .map((t) => `<a class="tag" href="#/?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`)
      .join('');
  }

  // 反链：谁提到了这篇
  const name = stripExt(path);
  const refs = [];
  for (const [p, t] of state.texts) {
    if (p === path) continue;
    if (t.includes('[[' + name) || t.includes('[[' + baseName(path))) refs.push(p);
  }
  if (refs.length) {
    $('.backlinks', root).innerHTML = `<h2 class="side-title">这条被提到</h2><ul class="refs">${refs
      .map((p) => `<li><a href="#/note/${encodeURIComponent(p)}">${esc(stripExt(p))}</a></li>`)
      .join('')}</ul>`;
  }
}

/* ==================== 视图：编辑 ==================== */

function dailyTemplate(dateStr) {
  return `---
tags:
  - 每日随记
date: ${dateStr}
---

# 收获


# 产出
`;
}

async function viewEdit(root, path, opts = {}) {
  const isNew = opts.isNew || !state.index.has(path);
  let initial = '';
  let restoredDraft = false;

  if (!isNew) {
    initial = await ensureText(path);
    // 上次没保存就离开的改动，优先恢复（手机上手滑返回最容易踩）
    const draft = await drafts.get(path);
    if (draft && typeof draft.text === 'string' && draft.text !== initial) {
      initial = draft.text;
      restoredDraft = true;
    }
  } else {
    const ds = dateFromPath(path) || todayStr();
    initial = dailyTemplate(ds);
    const draft = await drafts.get(path);
    if (draft && typeof draft.text === 'string') {
      initial = draft.text;
      restoredDraft = true;
    }
  }

  root.innerHTML = `
    <div class="editor-head">
      <a class="back" href="${isNew ? '#/' : '#/note/' + encodeURIComponent(path)}">←</a>
      <div class="editor-title">${esc(isNew ? '新建' : stripExt(path))}</div>
      <div class="editor-actions">
        <button class="btn ghost small" id="btnTags">标签</button>
        <button class="btn ghost small" id="btnPreview">预览</button>
        <button class="btn small" id="btnSave">保存</button>
      </div>
    </div>
    <div id="tagSuggest" class="tag-suggest hidden"></div>
    <div class="edit-tools" id="editTools">
      <button type="button" data-before="&#10;# 收获&#10;" data-after=""># 收获</button>
      <button type="button" data-before="&#10;# 产出&#10;" data-after=""># 产出</button>
      <button type="button" data-before="[[" data-after="]]">双链</button>
      <button type="button" data-before="**" data-after="**">加粗</button>
    </div>
    <div class="editor-wrap">
      <textarea id="editor" spellcheck="false"></textarea>
      <div id="preview" class="prose preview hidden"></div>
    </div>
    <div class="editor-foot">
      <span class="muted small" id="hint">直接写 Markdown，[[双链]] 和 ![[图片]] 都支持</span>
      <span class="muted small" id="counter"></span>
    </div>
  `;

  const ta = $('#editor', root);
  ta.value = initial;

  const updateCounter = () => {
    const n = ta.value.length;
    $('#counter').textContent = `${n} 字`;
  };
  updateCounter();
  if (restoredDraft) toast('已恢复上次没保存的改动');

  // 快捷插入：手机上不用来回切符号键盘
  const insertAt = (before, after) => {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const val = ta.value;
    const selected = val.slice(s, e);
    ta.value = val.slice(0, s) + before + selected + after + val.slice(e);
    const caret = s + before.length + selected.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    updateCounter();
    // 用元素自己那个 window 的 Event 构造器：跨窗口/测试环境都安全
    const view = (ta.ownerDocument && ta.ownerDocument.defaultView) || window;
    ta.dispatchEvent(new view.Event('input', { bubbles: true }));
  };

  for (const btn of root.querySelectorAll('#editTools button')) {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      insertAt(btn.dataset.before || '', btn.dataset.after || '');
    });
  }

  let dirty = false;
  ta.addEventListener('input', () => {
    dirty = true;
    updateCounter();
    clearTimeout(ta._t);
    ta._t = setTimeout(() => drafts.put({ path, text: ta.value, at: Date.now() }), 800);
  });

  const showPreview = async () => {
    const pv = $('#preview', root);
    pv.innerHTML = renderBody(ta.value);
    await hydrateImages(pv);
    ta.classList.add('hidden');
    pv.classList.remove('hidden');
    $('#btnPreview').textContent = '继续写';
    $('#btnPreview').onclick = () => {
      pv.classList.add('hidden');
      ta.classList.remove('hidden');
      $('#btnPreview').textContent = '预览';
      $('#btnPreview').onclick = showPreview;
    };
  };
  $('#btnPreview').onclick = showPreview;

  $('#btnTags').onclick = async () => {
    const panel = $('#tagSuggest', root);
    if (!panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      return;
    }
    if (!state.cfg.aiKey) {
      toast('先在设置里填 AI key', 'warn');
      return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = '<span class="muted small">正在挑标签…</span>';

    const known = collectTags().map(([t]) => t);
    try {
      const answer = await aiChat([
        {
          role: 'system',
          content:
            '你只从给定的标签表里挑选，绝不创造新词。\n标签表：' +
            known.join('、') +
            '\n只输出 1 到 3 个标签，用中文逗号分隔，不要解释，不要编号。',
        },
        { role: 'user', content: ta.value.slice(0, 3000) },
      ]);
      const picked = [
        ...new Set(
          answer
            .split(/[，,、\s]+/)
            .map((s) => s.replace(/^#/, '').trim())
            .filter((t) => known.includes(t)),
        ),
      ].slice(0, 3);

      if (!picked.length) {
        panel.innerHTML = '<span class="muted small">这篇没挑出合适的已有标签</span>';
        return;
      }
      panel.innerHTML = picked
        .map((t) => `<button class="tag-chip" data-tag="${esc(t)}">#${esc(t)}</button>`)
        .join('');
      for (const b of panel.querySelectorAll('.tag-chip')) {
        b.onclick = () => {
          ta.value = withTags(ta.value, [b.dataset.tag]);
          updateCounter();
          panel.classList.add('hidden');
          toast('已加上 ' + b.dataset.tag);
        };
      }
    } catch (e) {
      panel.innerHTML = `<span class="muted small">${esc(e.message)}</span>`;
    }
  };

  $('#btnSave').onclick = async () => {
    const btn = $('#btnSave', root);
    btn.disabled = true;
    btn.textContent = '保存中';
    const text = ta.value;
    const res = await saveText(path, text);
    btn.disabled = false;
    btn.textContent = '保存';
    if (res.ok) {
      toast('已保存');
      dirty = false;
      if (!state.index.has(path)) await refreshIndex();
      go('#/note/' + encodeURIComponent(path));
    } else if (res.offline) {
      try {
        await files.put({ path, sha: state.index.get(path)?.sha || 'local', text });
      } catch {}
      toast('离线：已存本地，联网后自动同步');
      if (!state.index.has(path)) {
        state.index.set(path, { sha: null, size: text.length });
      }
      go('#/note/' + encodeURIComponent(path));
    } else if (res.conflict) {
      toast('云端已被别处修改，请刷新后再改', 'warn');
    } else {
      toast(res.error || '保存失败', 'warn');
    }
  };

  window.onbeforeunload = dirty ? (e) => (e.returnValue = '还有未保存的修改') : null;
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

/* ==================== 视图：搜索 ==================== */

function tokenize(q) {
  const s = String(q).toLowerCase();
  const latin = s.match(/[a-z0-9_\-]+/g) || [];
  const cjk = s.replace(/[a-z0-9_\-\s]+/g, ' ').match(/[\u4e00-\u9fa5]+/g) || [];
  const grams = [];
  for (const run of cjk) {
    if (run.length === 1) grams.push(run);
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
  }
  return [...new Set([...latin, ...grams])];
}

function searchDocs(query, limit = 20) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const results = [];
  for (const [path, text] of state.texts) {
    if (!MD_EXT.test(path)) continue;
    const low = text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      let idx = 0;
      let count = 0;
      while ((idx = low.indexOf(t, idx)) !== -1 && count < 12) {
        count++;
        idx += t.length;
      }
      if (count) score += count * (t.length > 1 ? 2 : 1);
    }
    if (score > 0) {
      if (baseName(path).toLowerCase().includes(String(query).toLowerCase())) score += 20;
      results.push({ path, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function viewSearch(root, q) {
  root.innerHTML = `
    <div class="page-head"><h1 class="site-title small-title">搜索</h1></div>
    <input id="q" class="search-input" placeholder="搜标题、正文、标签…" value="${esc(q)}" autocomplete="off">
    <div id="results" class="results"></div>
  `;
  const input = $('#q', root);
  const box = $('#results', root);

  const run = () => {
    const query = input.value.trim();
    if (!query) {
      box.innerHTML = `<p class="muted small">输入关键词，在 ${[...state.texts.keys()].filter((p) => MD_EXT.test(p)).length} 篇笔记里找。</p>`;
      return;
    }
    const hits = searchDocs(query);
    if (!hits.length) {
      box.innerHTML = `<div class="empty"><p>没有找到「${esc(query)}」</p><p class="muted small">试试更短的关键词</p></div>`;
      return;
    }
    box.innerHTML = hits
      .map(({ path }) => {
        const text = state.texts.get(path) || '';
        const { body } = splitFrontmatter(text);
        const plain = stripMarkdown(body);
        const i = plain.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, i - 30);
        const snippet = (start > 0 ? '…' : '') + plain.slice(start, start + 110);
        return `<a class="hit" href="#/note/${encodeURIComponent(path)}">
          <div class="hit-title">${esc(stripExt(path))}</div>
          <div class="hit-dir">${esc(dirName(path) || '根目录')}</div>
          <div class="hit-snippet">${esc(snippet)}</div>
        </a>`;
      })
      .join('');
  };

  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(run, 120);
  });

  // 首次打开时正文还在后台拉，先等一等，免得搜出「什么都没有」
  if (state.syncPromise && !state.texts.size) {
    box.innerHTML = `<p class="muted small">正在把笔记拉到本地…</p>`;
    await state.syncPromise;
    const { path: nowPath } = parseHash();
    if (nowPath !== '/search') return;
  }

  run();
  if (!q) input.focus();
}

/* ==================== 视图：全部笔记 ==================== */

async function viewAll(root) {
  // 模板不是笔记，不列出来
  const HIDDEN_DIRS = new Set(['模板']);

  const byDir = new Map();
  for (const p of state.index.keys()) {
    if (!MD_EXT.test(p)) continue;
    const d = dirName(p) || '（根目录）';
    if (HIDDEN_DIRS.has(d)) continue;
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }
  const dirs = [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  for (const [, list] of dirs) list.sort((a, b) => a.localeCompare(b, 'zh'));

  const total = dirs.reduce((n, [, list]) => n + list.length, 0);

  root.innerHTML = `
    <div class="page-head">
      <a class="back" href="#/">←</a>
      <h1 class="site-title small-title">全部笔记</h1>
    </div>
    <p class="site-sub">${total} 篇 · ${dirs.length} 个文件夹</p>
    <div id="allList"></div>
  `;

  const box = $('#allList', root);

  if (state.syncPromise && !state.texts.size) {
    box.innerHTML = `<p class="muted small">正在把笔记拉到本地…</p>`;
    await state.syncPromise;
  }

  const { path: nowPath } = parseHash();
  if (nowPath !== '/all') return;

  box.innerHTML = '';

  for (const [dir, list] of dirs) {
    const sec = document.createElement('section');
    sec.className = 'all-group';

    const title = document.createElement('h2');
    title.className = 'group-title';
    title.innerHTML = `${esc(dir)}<span class="count">${list.length}</span>`;
    sec.appendChild(title);

    const ul = document.createElement('ul');
    ul.className = 'all-list';

    for (const p of list) {
      const text = state.texts.get(p) || '';
      const { data } = splitFrontmatter(text);
      const label = data.title ? String(data.title) : stripExt(p);
      const rawDate = data.date ? String(data.date) : dateFromPath(p) || '';
      // 模板里的 {{date}} 之类占位符不显示
      const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '';

      const li = document.createElement('li');
      li.innerHTML = `<a href="#/note/${encodeURIComponent(p)}">
        <span class="note-name">${esc(label)}</span>
        ${date ? `<span class="note-date">${esc(date)}</span>` : ''}
      </a>`;
      ul.appendChild(li);
    }

    sec.appendChild(ul);
    box.appendChild(sec);
  }
}

/* ==================== 视图：标签 ==================== */

async function viewTags(root) {
  const tags = collectTags();
  root.innerHTML = `
    <div class="page-head">
      <a class="back" href="#/">←</a>
      <h1 class="site-title small-title">标签</h1>
    </div>
    <div class="tag-cloud">
      ${tags
        .map(
          ([t, n]) =>
            `<a class="tag big" href="#/?tag=${encodeURIComponent(t)}">#${esc(t)}<span class="count">${n}</span></a>`,
        )
        .join('')}
    </div>
    <p class="muted small">标签来自你的 frontmatter。你的《标签规范》要求不临时造新词，AI 建议也只从这个表里挑。</p>
  `;
}

/* ==================== AI ==================== */

async function aiChat(messages, onDelta) {
  const { aiKey, aiModel, aiBase } = state.cfg;
  if (!aiKey) throw new Error('还没填 AI key');
  const res = await fetch(`${aiBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKey}` },
    body: JSON.stringify({ model: aiModel || 'deepseek-chat', messages, stream: Boolean(onDelta), temperature: 0.3 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(res.status === 401 ? 'AI key 无效' : `AI 返回 ${res.status} ${body.slice(0, 120)}`);
  }
  if (!onDelta) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onDelta(full);
        }
      } catch {
        /* 忽略半截 */
      }
    }
  }
  return full;
}

function retrieve(query, k = 8) {
  const hits = searchDocs(query, k * 2).slice(0, k);
  return hits.map(({ path }) => ({
    path,
    text: stripMarkdown(splitFrontmatter(state.texts.get(path) || '').body).slice(0, 1200),
  }));
}

async function viewAsk(root) {
  root.innerHTML = `
    <div class="page-head">
      <a class="back" href="#/">←</a>
      <h1 class="site-title small-title">问笔记</h1>
      <div class="head-actions"><button class="ghost" id="btnWeek">这周总结</button></div>
    </div>
    <div id="chat" class="chat"></div>
    <form id="askForm" class="ask-form">
      <input id="askInput" placeholder="问问你自己的笔记…" autocomplete="off">
      <button class="btn" type="submit">问</button>
    </form>
  `;

  const chat = $('#chat', root);
  const draw = () => {
    chat.innerHTML = state.chat
      .map(
        (m) =>
          `<div class="msg ${m.role}"><div class="bubble">${
            m.role === 'assistant' ? renderMarkdown(m.content, RENDER_CTX) : esc(m.content).replace(/\n/g, '<br>')
          }</div></div>`,
      )
      .join('');
    chat.scrollTop = chat.scrollHeight;
  };

  if (!state.chat.length) {
    chat.innerHTML = `<div class="empty"><p>它会先在你笔记里找相关段落，再回答。</p>
      <p class="muted small">比如：我这周学了什么？[[链路]]为什么…</p></div>`;
  } else draw();

  $('#askForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#askInput', root);
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    state.chat.push({ role: 'user', content: q });
    const answer = { role: 'assistant', content: '' };
    state.chat.push(answer);
    draw();

    const ctxDocs = retrieve(q);
    const ctxText = ctxDocs
      .map((d) => `### ${d.path}\n${d.text}`)
      .join('\n\n---\n\n')
      .slice(0, 12000);

    const sys = `你是用户私人笔记的助手。只依据下面提供的笔记片段回答，不要编造。
如果片段里没有答案，就直接说"笔记里没有找到"。
引用来源时用 [[文件名]] 的形式。
回答简洁，用中文。

【笔记片段】
${ctxText || '（没有检索到相关笔记）'}`;

    const messages = [
      { role: 'system', content: sys },
      ...state.chat
        .filter((m) => m.role !== 'system' && String(m.content || '').trim())
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      await aiChat(messages, (full) => {
        answer.content = full;
        draw();
      });
    } catch (err) {
      answer.content = `出错：${err.message}`;
      draw();
    }
  });

  $('#btnWeek').onclick = () => generateWeeklySummary();
}

/* ==================== 周总结 ==================== */

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

async function generateWeeklySummary() {
  const { year, week } = isoWeek();
  const days = lastNDays(7);
  const chunks = [];
  for (const d of days) {
    const p = dailyPathFor(d);
    if (state.index.has(p)) {
      const text = await ensureText(p);
      chunks.push(`## ${d}\n${splitFrontmatter(text).body}`);
    }
  }
  if (!chunks.length) return toast('这周还没有日记');

  toast('正在生成…');
  const sys = `你在帮用户整理一周的学习与产出记录。把「收获」合并成主题，不要逐条罗列；
把「产出」写成一段进展。只使用给到的材料，不补充材料里没有的内容。
最后列出三条下周建议。用 Markdown，中文，不要写"以下是"。`;
  const userMsg = `以下是这一周的记录：\n\n${chunks.join('\n\n').slice(0, 14000)}`;

  let body;
  try {
    body = await aiChat([
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ]);
  } catch (e) {
    return toast('生成失败：' + e.message, 'warn');
  }

  const outDir = state.cfg.aiOutDir || 'AI写入';
  const outPath = `${outDir}/周总结/${year}-W${String(week).padStart(2, '0')}.md`;
  const front = stringifyFrontmatter({
    tags: ['周总结'],
    date: todayStr(),
    ai: '是',
    status: '待确认',
  });
  const content = `${front}\n\n> 本文由 AI 根据 ${days[0]} ~ ${days[days.length - 1]} 的日得生成，尚未经你确认。\n\n# 本周总结\n\n${body}\n`;

  const res = await saveText(outPath, content);
  if (res.ok) {
    toast('已写入 ' + outPath);
    go('#/note/' + encodeURIComponent(outPath));
  } else {
    toast(res.error || '写入失败', 'warn');
  }
}

function lastNDays(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    out.push(todayStr(d));
  }
  return out.reverse();
}

/* ==================== 视图：设置 ==================== */

function viewSettings(root, opts = {}) {
  const c = state.cfg;
  root.innerHTML = `
    <div class="page-head">
      ${opts.firstRun ? '' : '<a class="back" href="#/">←</a>'}
      <h1 class="site-title small-title">设置</h1>
    </div>
    ${opts.firstRun ? `<p class="lede">第一次用，填下面三项就能开始。这些只存在你这台设备的浏览器里。</p>` : ''}

    <section class="field-group">
      <label class="field">
        <span>仓库</span>
        <input id="f-repo" placeholder="用户名/仓库名，例如 zhangsan/kb-notes" value="${esc(c.owner ? c.owner + '/' + c.repo : '')}">
      </label>
      <label class="field">
        <span>分支</span>
        <input id="f-branch" value="${esc(c.branch)}">
      </label>
      <label class="field">
        <span>GitHub Token</span>
        <input id="f-token" type="password" placeholder="github_pat_…" value="${esc(c.token)}">
        <small>Fine-grained token，只勾这个仓库的 Contents：Read and write</small>
      </label>
      <label class="field">
        <span>日记目录</span>
        <input id="f-dir" value="${esc(c.dailyDir)}">
      </label>
    </section>

    <section class="field-group">
      <h2 class="side-title">AI（可选）</h2>
      <label class="field">
        <span>DeepSeek Key</span>
        <input id="f-aikey" type="password" placeholder="sk-…" value="${esc(c.aiKey)}">
      </label>
      <label class="field">
        <span>模型</span>
        <input id="f-model" value="${esc(c.aiModel)}">
      </label>
    </section>

    <div class="btn-row">
      <button class="btn" id="btn-savecfg">保存并同步</button>
      <button class="btn ghost" id="btn-test">测试连接</button>
    </div>

    <section class="field-group">
      <h2 class="side-title">数据</h2>
      <div class="btn-row">
        <button class="btn ghost" id="btn-full">重新拉取全部</button>
        <button class="btn ghost" id="btn-clear">清空本地缓存</button>
      </div>
      <p class="muted small" id="stat"></p>
    </section>

    <p class="muted small footer-note">数据存在你自己的私有仓库里。关掉网页也不会丢；换设备只需重新填一次 token。</p>
  `;

  const readForm = () => {
    const repoRaw = $('#f-repo', root).value.trim();
    const [owner, repo] = repoRaw.includes('/') ? repoRaw.split('/') : ['', repoRaw];
    return {
      ...state.cfg,
      owner: owner.trim(),
      repo: (repo || '').trim(),
      branch: $('#f-branch', root).value.trim() || 'main',
      token: $('#f-token', root).value.trim(),
      dailyDir: $('#f-dir', root).value.trim() || '日得',
      aiKey: $('#f-aikey', root).value.trim(),
      aiModel: $('#f-model', root).value.trim() || 'deepseek-chat',
    };
  };

  $('#btn-savecfg').onclick = async () => {
    const btn = $('#btn-savecfg', root);
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      applyConfig(readForm());
      await refreshIndex();
      await syncAll((d, t) => (btn.textContent = `同步 ${d}/${t}`));
      btn.textContent = '保存并同步';
      btn.disabled = false;
      toast('已同步 ' + state.index.size + ' 个文件');
      go('#/');
    } catch (e) {
      btn.textContent = '保存并同步';
      btn.disabled = false;
      toast(e.message, 'warn');
    }
  };

  $('#btn-test').onclick = async () => {
    applyConfig(readForm());
    try {
      const me = await state.gh.me();
      const tree = await state.gh.tree();
      toast(`连接成功：${me.login}，仓库里 ${tree.length} 个文件`);
    } catch (e) {
      toast(e.message, 'warn');
    }
  };

  $('#btn-full').onclick = async () => {
    try {
      await files.clear();
      state.texts.clear();
      await refreshIndex();
      await syncAll((d, t) => toast(`同步 ${d}/${t}`));
      toast('已重新拉取');
    } catch (e) {
      toast(e.message, 'warn');
    }
  };

  $('#btn-clear').onclick = async () => {
    await files.clear();
    await assets.clear();
    state.texts.clear();
    state.assetUrls.clear();
    toast('本地缓存已清空，重新打开会重新拉取');
  };

  const stat = $('#stat', root);
  if (stat) {
    stat.textContent = `本地已缓存 ${state.texts.size} 篇 · 仓库共 ${state.index.size} 个文件`;
  }
}

/* ==================== 启动 ==================== */

async function boot() {
  applyConfig(state.cfg);

  window.addEventListener('hashchange', () => {
    window.onbeforeunload = null;
    route();
  });
  window.addEventListener('online', async () => {
    const n = await flushPending();
    if (n) toast(`联网了，已同步 ${n} 篇`);
  });

  if (!cfgReady()) {
    route();
    return;
  }

  app().innerHTML = `<div class="loading"><div class="spinner"></div><p>正在同步…</p></div>`;
  try {
    const last = await meta.get('lastIndex', null);
    if (Array.isArray(last)) {
      for (const p of last) state.index.set(p, { sha: null, size: 0 });
    }
    await refreshIndex();
    // 后台先把正文拉一遍（视图里按需加载时会复用这同一个 promise）
    state.syncPromise = syncAll().catch((e) => console.warn('后台同步失败', e));
    route();

    // 补传上次离线时没发出去的草稿（放在 route 之后，界面先出来）
    flushPending()
      .then((n) => {
        if (n) toast(`已补同步 ${n} 篇离线草稿`);
      })
      .catch((e) => console.warn('补同步失败', e));
  } catch (e) {
    console.error('同步失败', e);
    app().innerHTML = `<div class="empty"><p>同步失败：${esc(e.message)}</p>
      <a class="btn" href="#/settings">去设置</a></div>`;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
