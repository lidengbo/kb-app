// store.js — IndexedDB 本地缓存（离线可读、可写、可搜）
const DB_NAME = 'kb';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try {
      out = fn(s);
    } catch (e) {
      reject(e);
      return;
    }
    // 注意：查询没命中时 result 就是 undefined，不能用 !== undefined 来判断
    // 否则会把请求对象本身当成结果返回
    t.oncomplete = () => {
      if (out && typeof out === 'object' && 'result' in out) resolve(out.result);
      else resolve(out);
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ---- 文件缓存 ---- */

export const files = {
  get: (path) => tx('files', 'readonly', (s) => s.get(path)),
  put: (rec) => tx('files', 'readwrite', (s) => s.put(rec)),
  all: () => tx('files', 'readonly', (s) => s.getAll()),
  del: (path) => tx('files', 'readwrite', (s) => s.delete(path)),
  clear: () => tx('files', 'readwrite', (s) => s.clear()),
};

/* ---- 图片缓存 ---- */

export const assets = {
  get: (path) => tx('assets', 'readonly', (s) => s.get(path)),
  put: (rec) => tx('assets', 'readwrite', (s) => s.put(rec)),
  del: (path) => tx('assets', 'readwrite', (s) => s.delete(path)),
  clear: () => tx('assets', 'readwrite', (s) => s.clear()),
};

/* ---- 草稿（未保存到云端的编辑） ---- */

export const drafts = {
  get: (path) => tx('drafts', 'readonly', (s) => s.get(path)),
  put: (rec) => tx('drafts', 'readwrite', (s) => s.put(rec)),
  del: (path) => tx('drafts', 'readwrite', (s) => s.delete(path)),
  all: () => tx('drafts', 'readonly', (s) => s.getAll()),
};

/* ---- 待同步队列 ---- */

export const pending = {
  get: (path) => tx('pending', 'readonly', (s) => s.get(path)),
  put: (rec) => tx('pending', 'readwrite', (s) => s.put(rec)),
  del: (path) => tx('pending', 'readwrite', (s) => s.delete(path)),
  all: () => tx('pending', 'readonly', (s) => s.getAll()),
};

/* ---- 键值 ---- */

export const meta = {
  get: async (key, fallback = null) => {
    const rec = await tx('meta', 'readonly', (s) => s.get(key));
    return rec ? rec.value : fallback;
  },
  set: (key, value) => tx('meta', 'readwrite', (s) => s.put({ key, value })),
};

/* ---- 配置（localStorage：不在 IndexedDB，方便清缓存时不丢） ---- */

const CONFIG_KEY = 'kb.config.v1';

export const DEFAULT_CONFIG = {
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  aiKey: '',
  aiModel: 'deepseek-chat',
  aiBase: 'https://api.deepseek.com',
  aiEnabled: true,
  dailyDir: '日得',
  aiOutDir: 'AI写入',
};

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}
