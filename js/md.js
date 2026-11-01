// md.js — 极简 Markdown + Obsidian 语法渲染器（零依赖）
// 支持：frontmatter、标题、加粗/斜体/删除线、行内代码、代码块、
//       有序/无序（嵌套）列表、引用、分隔线、表格、
//       [[双链]]、[[目标|别名]]、![[嵌入]]、![](图片)

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ESC_MAP[c]);
}

/* ---------------- frontmatter ---------------- */

export function splitFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { data: {}, body: src, hasFrontmatter: false };
  return {
    data: parseYamlLite(m[1]),
    body: src.slice(m[0].length),
    hasFrontmatter: true,
  };
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

export function parseYamlLite(text) {
  const data = {};
  const lines = String(text).split('\n');
  let curKey = null;
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const listItem = raw.match(/^\s*-\s+(.*)$/);
    if (listItem && curKey) {
      if (!Array.isArray(data[curKey])) data[curKey] = [];
      data[curKey].push(unquote(listItem[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    curKey = key;
    if (val === '') {
      data[key] = [];
      continue;
    }
    if (/^\[.*\]$/.test(val)) {
      const inner = val.slice(1, -1).trim();
      data[key] = inner ? inner.split(',').map((s) => unquote(s)) : [];
    } else {
      data[key] = unquote(val);
    }
  }
  // 空数组还原成空字符串更自然
  for (const k of Object.keys(data)) {
    if (Array.isArray(data[k]) && data[k].length === 0) data[k] = '';
  }
  return data;
}

export function stringifyFrontmatter(data) {
  const out = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      if (!v.length) {
        out.push(`${k}:`);
        continue;
      }
      out.push(`${k}:`);
      for (const item of v) out.push(`  - ${item}`);
    } else {
      out.push(`${k}: ${v ?? ''}`.trimEnd());
    }
  }
  out.push('---');
  return out.join('\n');
}

/* ---------------- inline ---------------- */

function inline(text, ctx) {
  const codes = [];
  let s = escapeHtml(text);

  // 行内代码先摘出来，避免内部被其它规则破坏
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 图片（标准语法）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    const url = ctx.resolveAsset ? ctx.resolveAsset(src) : src;
    if (!url) return `<span class="md-broken" title="图片未找到">${alt || src}</span>`;
    return `<img src="${url}" alt="${alt}" loading="lazy">`;
  });

  // 嵌入 ![[...]]（图片或笔记）
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_m, inner) => {
    const name = inner.split('|')[0].trim();
    const url = ctx.resolveAsset ? ctx.resolveAsset(name) : null;
    if (url) return `<img src="${url}" alt="${name}" loading="lazy">`;
    const hit = ctx.resolveWiki ? ctx.resolveWiki(name) : null;
    if (hit && hit.exists) {
      return `<a class="md-embed" href="#/note/${encodeURIComponent(hit.path)}">${escapeHtml(hit.title || name)}</a>`;
    }
    return `<span class="md-broken" title="未找到：${escapeHtml(name)}">${escapeHtml(name)}</span>`;
  });

  // 双链 [[目标]] / [[目标|别名]]
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, inner) => {
    const [targetRaw, aliasRaw] = inner.split('|');
    const target = targetRaw.split('#')[0].trim();
    const label = (aliasRaw || targetRaw).trim();
    const hit = ctx.resolveWiki ? ctx.resolveWiki(target) : null;
    if (hit && hit.exists) {
      return `<a class="md-wikilink" href="#/note/${encodeURIComponent(hit.path)}">${escapeHtml(label)}</a>`;
    }
    return `<span class="md-wikilink md-broken" title="尚未创建：${escapeHtml(target)}">${escapeHtml(label)}</span>`;
  });

  // 普通链接 [文字](地址)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '#';
    const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${safe}"${ext}>${label}</a>`;
  });

  // 强调
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');

  // 还原代码
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, n) => `<code>${codes[Number(n)]}</code>`);
  return s;
}

/* ---------------- block ---------------- */

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function renderTable(header, sep, rows, ctx) {
  const hs = splitRow(header);
  const aligns = splitRow(sep).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  });
  const th = hs
    .map((h, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(h, ctx)}</th>`)
    .join('');
  const body = rows
    .map((r) => {
      const cs = splitRow(r);
      while (cs.length < hs.length) cs.push('');
      return `<tr>${cs
        .slice(0, hs.length)
        .map((c, i) => `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(c, ctx)}</td>`)
        .join('')}</tr>`;
    })
    .join('');
  return `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderList(items, ctx) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      html += `<${tag}><li>`;
      stack.push({ indent: it.indent, tag });
    } else {
      html += `</li><li>`;
    }
    html += inline(it.text, ctx);
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

export function renderMarkdown(body, ctx = {}) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // 代码块
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      out.push(
        `<pre class="md-code"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(
          buf.join('\n'),
        )}</code></pre>`,
      );
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim(), ctx)}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = line;
      const sep = lines[i + 1];
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(lines[i]);
        i++;
      }
      out.push(renderTable(header, sep, rows, ctx));
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), ctx)}</blockquote>`);
      continue;
    }

    // 列表
    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = lines[i].match(LIST_RE);
        items.push({
          indent: m[1].replace(/\t/g, '    ').length,
          ordered: /^\d/.test(m[2]),
          text: m[3],
        });
        i++;
      }
      out.push(renderList(items, ctx));
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join('\n'), ctx).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('\n');
}

/* ---------------- 工具 ---------------- */

/** 去掉标记，得到纯文本，用于搜索与摘要 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[([^\]]+)\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从正文里取第一个自然段做预览 */
export function excerpt(body, len = 90) {
  const plain = stripMarkdown(body);
  return plain.length > len ? plain.slice(0, len) + '…' : plain;
}

/**
 * 往一篇笔记里追加标签，保留原有 frontmatter 的键顺序（tags 放回第一位）
 */
export function withTags(text, newTags) {
  const { data, body, hasFrontmatter } = splitFrontmatter(text);
  const cur = Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [];
  const merged = [...new Set([...cur, ...newTags.map((t) => String(t).trim()).filter(Boolean)])];
  const { tags: _drop, ...rest } = data;
  const front = stringifyFrontmatter({ tags: merged, ...rest });
  if (!hasFrontmatter) return front + '\n\n' + text;
  return front + '\n' + (body.startsWith('\n') ? body : '\n' + body);
}

