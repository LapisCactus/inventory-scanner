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
function isMissingForShelf(code, shelf, inventory, shelfLast) {
  const lastScan = shelfLast[shelf];
  if (!lastScan) return false; // 未実施なら欠品表示しない
  const rec = inventory[code];
  return !rec || rec.lastSeenDate !== lastScan;
}

// ====== 棚卸し状態クリア ======
function clearInventory() {
  if (confirm('棚卸し状態をクリアしますか？')) {
    localStorage.removeItem(LS_KEYS.INVENTORY);
    localStorage.removeItem(LS_KEYS.SHELF_LAST);
    alert('クリアしました。');
  }
}