// github.js — 直接读写 GitHub 私有仓库（浏览器端，无后端）
const API = 'https://api.github.com';

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export class GitHubError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.detail = detail;
  }
}

export class GitHub {
  constructor({ owner, repo, branch = 'main', token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
    this.token = token;
  }

  get ready() {
    return Boolean(this.owner && this.repo && this.token);
  }

  async request(path, { method = 'GET', body, raw = false } = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const headers = {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });

    if (res.status === 401) throw new GitHubError('Token 无效或已过期', 401);
    if (res.status === 403) {
      const remain = res.headers.get('x-ratelimit-remaining');
      throw new GitHubError(
        remain === '0' ? 'API 次数用完了，等一小时再来' : '没有权限，检查 token 是否勾了 Contents: Read and write',
        403,
      );
    }
    if (res.status === 404) throw new GitHubError('仓库或文件不存在', 404);
    if (!res.ok) throw new GitHubError(`GitHub 返回 ${res.status}`, res.status, await res.text().catch(() => ''));

    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  /** 整棵文件树（一次调用拿到全部文件与 sha） */
  async tree() {
    const data = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`,
    );
    return (data.tree || []).filter((n) => n.type === 'blob');
  }

  /** 读取文本文件 */
  async getText(path) {
    const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${this.branch}`);
    if (Array.isArray(data)) throw new GitHubError('这是一个目录，不是文件', 400);
    return { text: base64ToUtf8(data.content || ''), sha: data.sha, path: data.path };
  }

  /** 读取二进制文件（图片） */
  async getBlob(path) {
    const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${this.branch}`);
    if (Array.isArray(data)) throw new GitHubError('这是一个目录，不是文件', 400);
    const bin = atob(String(data.content || '').replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { blob: new Blob([bytes]), sha: data.sha };
  }

  /** 写入（新建或更新）。sha 为 null 表示新建 */
  async putText(path, text, { sha = null, message = null } = {}) {
    const body = {
      message: message || `更新 ${path}`,
      content: utf8ToBase64(text),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body,
    });
    return { sha: data.content.sha, path: data.content.path };
  }

  async putBlob(path, blob, { message = null } = {}) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: { message: message || `添加 ${path}`, content: btoa(bin), branch: this.branch },
    });
    return { sha: data.content.sha, path: data.content.path };
  }

  async me() {
    return this.request('/user');
  }
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}
