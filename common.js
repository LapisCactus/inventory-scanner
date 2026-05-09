// ====== 定数（localStorageキー） ======
const LS_KEYS = {
  INVENTORY: 'inventory_v1',        // { code: { lastSeenDate: "YYYY-MM-DD" } }
  SHELF_LAST: 'shelfLastScan_v1'    // { shelf: "YYYY-MM-DD" }
};

// ====== 日付（ローカル日付 YYYY-MM-DD） ======
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ====== CSV読込 & パース ======
async function loadBooksCSV() {
  const res = await fetch('./books.csv', { cache: 'no-store' });
  if (!res.ok) throw new Error('CSV fetch failed');
  const text = await res.text();

  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = {
    code: header.indexOf('code'),
    title: header.indexOf('title'),
    location: header.indexOf('location')
  };

  const BOOKS = {};
  const SHELVES = {};

  for (let i = 1; i < lines.length; i++) {
    // 簡易パース（カンマ含む場合は未対応）
    const cols = lines[i].split(',');
    const code = cols[idx.code]?.trim();
    const title = cols[idx.title]?.trim();
    const location = cols[idx.location]?.trim();
    if (!code) continue;

    BOOKS[code] = { title, location };
    if (!SHELVES[location]) SHELVES[location] = [];
    SHELVES[location].push(code);
  }
  return { BOOKS, SHELVES };
}

// ====== 設定読込 ======
const DEFAULT_CONFIG = {
  graceDays: 14
};

async function loadConfigCSV() {
  try {
    const res = await fetch('./config.csv', { cache: 'no-store' });
    if (!res.ok) throw new Error('config fetch failed');
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);

    const cfg = { ...DEFAULT_CONFIG };

    for (let i = 1; i < lines.length; i++) {
      const [key, value] = lines[i].split(',');
      if (!key) continue;
      cfg[key.trim()] = isNaN(value) ? value.trim() : Number(value);
    }
    return cfg;
  } catch {
    // フォールバック
    return { ...DEFAULT_CONFIG };
  }
}

// ====== localStorage ヘルパ ======
function loadJSON(key, fallback = {}) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

// ====== URLクエリ ======
function getQuery(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}
function goTo(path, params = {}) {
  const url = new URL(path, window.location.origin + window.location.pathname.replace(/[^/]*$/, ''));
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  window.location.href = url.toString();
}

// ====== ドメインロジック ======
function diffDays(dateStr1, dateStr2) {
  if (!dateStr1 || !dateStr2) return Infinity;

  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);

  const ms = d1 - d2;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function isMissingForShelf(code, shelf, inventory, shelfLast, config) {
  const lastScan = shelfLast[shelf];
  if (!lastScan) return false;

  const rec = inventory[code];
  if (!rec) return true;

  const days = diffDays(lastScan, rec.lastSeenDate);

  return days > config.graceDays;
}

// ====== 棚卸し状態クリア ======
function clearInventory() {
  if (confirm('棚卸し状態をクリアしますか？')) {
    localStorage.removeItem(LS_KEYS.INVENTORY);
    localStorage.removeItem(LS_KEYS.SHELF_LAST);
    alert('クリアしました。');
  }
}

// ====== CSV生成 & ダウンロード ======
function generateCSV(data) {
  // data: [['header1', 'header2'], ['val1', 'val2'], ...]
  return data.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
}

function downloadCSV(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function shareCSV(csvContent, filename, title = '', text = '') {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const file = new File([blob], filename, { type: 'text/csv;charset=utf-8;' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return true;
    } catch (error) {
      if (error.name === 'AbortError') {
        return false;
      }
      console.warn('CSV share failed:', error);
    }
  }

  downloadCSV(csvContent, filename);
  return false;
}

// ====== ストレージ使用量計算 ======
function calculateStorageUsage() {
  const inventory = loadJSON(LS_KEYS.INVENTORY);
  const shelfLast = loadJSON(LS_KEYS.SHELF_LAST);
  const inventorySize = new Blob([JSON.stringify(inventory)]).size;
  const shelfLastSize = new Blob([JSON.stringify(shelfLast)]).size;
  const totalSize = inventorySize + shelfLastSize;
  return { inventorySize, shelfLastSize, totalSize };
}