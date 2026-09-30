/* CSV統合ツール共通処理。既存のlocalStorageには一切アクセスしない。 */
(() => {
  'use strict';

  const STORAGE_KEY = 'barcodeMergeSession_v1';
  const RESULT_HEADERS = ['code', 'name', 'shelf', '◯☓', 'date_seen', 'shelf_history', 'sources'];
  const MASTER_HEADERS = ['code', 'title', 'location'];
  const INPUT_HEADERS = ['code', 'name', 'shelf', 'date_seen'];

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const source = String(text).replace(/^\uFEFF/, '');

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (char === '"') {
        if (quoted && source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        row.push(field.trim());
        field = '';
      } else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && source[i + 1] === '\n') i += 1;
        row.push(field.trim());
        if (row.some(cell => cell !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += char;
      }
    }
    if (quoted) throw new Error('CSVの引用符が閉じられていません。');
    if (field !== '' || row.length > 0) {
      row.push(field.trim());
      if (row.some(cell => cell !== '')) rows.push(row);
    }
    if (!rows.length) return { header: [], rows: [] };

    const header = rows[0].map(value => value.replace(/^\uFEFF/, '').trim());
    return { header, rows: rows.slice(1).map(values => values) };
  }

  function csvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function toCSV(rows) {
    return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
  }

  function validDate(value) {
    if (!value || value === '-') return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
  }

  function dayWindow(days, endDate = localToday()) {
    const end = validDate(endDate);
    const count = Number(days);
    if (!end || !Number.isInteger(count) || count < 1 || count > 3650) {
      throw new Error('日数は1〜3650日の整数で指定してください。');
    }
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - count + 1);
    return { start: start.toISOString().slice(0, 10), end };
  }

  function localToday() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function inWindow(date, window) {
    return Boolean(date && date >= window.start && date <= window.end);
  }

  function sourceLabel(index) {
    let value = index + 1;
    let label = '';
    while (value > 0) {
      value -= 1;
      label = String.fromCodePoint(0x2460 + (value % 20)) + label;
      value = Math.floor(value / 20);
    }
    return label;
  }

  async function readMaster(path, requiredHeaders) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path} を読み込めません（HTTP ${response.status}）。`);
    const { header, rows } = parseCSV(await response.text());
    const indexes = Object.fromEntries(requiredHeaders.map(name => [name, header.indexOf(name)]));
    const missing = requiredHeaders.filter(name => indexes[name] < 0);
    if (missing.length) throw new Error(`${path} の列が不足しています: ${missing.join(', ')}`);
    return rows.map(values => Object.fromEntries(requiredHeaders.map(name => [name, values[indexes[name]] || ''])));
  }

  async function loadMasterData() {
    const [books, shelves] = await Promise.all([
      readMaster('../books.csv', MASTER_HEADERS),
      readMaster('../shelves.csv', ['shelf', 'label'])
    ]);
    const byCode = new Map();
    let duplicateMasterCodes = 0;
    books.forEach(book => {
      if (!book.code) return;
      if (byCode.has(book.code)) duplicateMasterCodes += 1;
      // 棚卸し画面の既存読み込みと同じく、重複コードは後の行を採用する。
      byCode.set(book.code, { code: book.code, name: book.title, shelf: book.location });
    });
    const shelfNames = new Set(shelves.map(item => item.shelf).filter(Boolean));
    return { books: byCode, shelfNames, duplicateMasterCodes };
  }

  async function mergeFiles(files, masterData) {
    if (!files?.length) throw new Error('棚卸しCSVを1つ以上選択してください。');
    const records = new Map();
    masterData.books.forEach(book => records.set(book.code, {
      code: book.code,
      name: book.name,
      shelf: book.shelf,
      date_seen: '',
      shelf_history: [],
      sources: [],
      uploaded: false
    }));

    const sources = [];
    const unknownCodes = new Set();
    const unknownShelves = new Set();
    let inputRowCount = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      const source = { label: sourceLabel(fileIndex), name: file.name, rows: 0 };
      const { header, rows } = parseCSV(await file.text());
      const indexes = Object.fromEntries(INPUT_HEADERS.map(name => [name, header.indexOf(name)]));
      const missing = INPUT_HEADERS.filter(name => indexes[name] < 0);
      if (missing.length) throw new Error(`${file.name}: 必須列がありません (${missing.join(', ')})`);
      if (!rows.length) throw new Error(`${file.name}: データ行がありません。`);

      for (let lineIndex = 0; lineIndex < rows.length; lineIndex += 1) {
        const values = rows[lineIndex];
        if (values.length !== header.length) {
          throw new Error(`${file.name} ${lineIndex + 2}行目: 列数がヘッダーと一致しません。`);
        }
        const code = (values[indexes.code] || '').trim();
        if (!code) throw new Error(`${file.name} ${lineIndex + 2}行目: code が空です。`);
        const name = (values[indexes.name] || '').trim();
        const shelf = (values[indexes.shelf] || '').trim();
        const rawDate = (values[indexes.date_seen] || '').trim();
        const date = validDate(rawDate);
        if (date === null) throw new Error(`${file.name} ${lineIndex + 2}行目: date_seen「${rawDate}」は yyyy-mm-dd 形式ではありません。`);
        if (!masterData.books.has(code)) unknownCodes.add(code);
        if (shelf && masterData.shelfNames.size && !masterData.shelfNames.has(shelf)) unknownShelves.add(shelf);

        let record = records.get(code);
        if (!record) {
          record = { code, name, shelf, date_seen: '', shelf_history: [], sources: [], uploaded: false };
          records.set(code, record);
        }
        if (shelf && date && !record.shelf_history.some(item => item.shelf === shelf && item.date === date)) {
          record.shelf_history.push({ shelf, date });
        }
        if (!record.sources.includes(fileIndex)) record.sources.push(fileIndex);

        const shouldUpdate = !record.uploaded
          || (date && (!record.date_seen || date >= record.date_seen))
          || (!record.date_seen && !date);
        if (shouldUpdate) {
          if (name) record.name = name;
          if (shelf) record.shelf = shelf;
          if (date) record.date_seen = date;
        }
        record.uploaded = true;
        source.rows += 1;
        inputRowCount += 1;
      }
      sources.push(source);
    }

    const merged = [...records.values()].sort((a, b) => a.code.localeCompare(b.code, 'ja', { numeric: true }));
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      sources,
      records: merged,
      stats: {
        masterBookCount: masterData.books.size,
        mergedBookCount: merged.length,
        inputRowCount,
        unknownCodes: [...unknownCodes].sort(),
        unknownShelves: [...unknownShelves].sort(),
        duplicateMasterCodes: masterData.duplicateMasterCodes
      }
    };
  }

  function recordsInWindow(data, days, endDate = localToday()) {
    const window = dayWindow(days, endDate);
    return { window, records: data.records.filter(record => inWindow(record.date_seen, window)) };
  }

  function shelfCounts(data, days, endDate = localToday()) {
    const { window, records } = recordsInWindow(data, days, endDate);
    const counts = new Map();
    records.forEach(record => {
      const shelf = record.shelf || '棚指定なし';
      counts.set(shelf, (counts.get(shelf) || 0) + 1);
    });
    return { window, counts: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja', { numeric: true })), scannedCount: records.length };
  }

  function unscannedRecords(data, days, endDate = localToday()) {
    const window = dayWindow(days, endDate);
    return { window, records: data.records.filter(record => !inWindow(record.date_seen, window)) };
  }

  function exportRows(data) {
    return [RESULT_HEADERS, ...data.records.map(record => [
      record.code,
      record.name,
      record.shelf,
      record.date_seen ? '◯' : '☓',
      record.date_seen || '-',
      record.shelf_history.map(item => `${item.shelf}@${item.date}`).join(' | '),
      record.sources.map(index => `${data.sources[index]?.label || ''} ${data.sources[index]?.name || ''}`.trim()).join(' | ')
    ])];
  }

  function unscannedCSV(data, days, endDate = localToday()) {
    const { window, records } = unscannedRecords(data, days, endDate);
    const rows = [['code', 'name', 'shelf', 'date_seen', 'shelf_history', 'sources'], ...records.map(record => [
      record.code,
      record.name,
      record.shelf,
      record.date_seen || '-',
      record.shelf_history.map(item => `${item.shelf}@${item.date}`).join(' | '),
      record.sources.map(index => `${data.sources[index]?.label || ''} ${data.sources[index]?.name || ''}`).join(' | ')
    ])];
    return { csv: toCSV(rows), window, count: records.length };
  }

  function saveSession(data) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new Error('統合結果をこのタブに保持できませんでした。CSVの数を減らして再試行してください。');
    }
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data?.version === 1 && Array.isArray(data.records) && Array.isArray(data.sources) ? data : null;
    } catch {
      return null;
    }
  }

  function downloadCSV(csv, filename) {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  window.MergeTool = {
    parseCSV, toCSV, validDate, dayWindow, localToday, inWindow, sourceLabel,
    loadMasterData, mergeFiles, recordsInWindow, shelfCounts, unscannedRecords,
    exportRows, unscannedCSV, saveSession, loadSession, downloadCSV, escapeHTML
  };
})();
