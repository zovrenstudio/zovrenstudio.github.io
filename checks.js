/* Zovren Studio — deterministic CSV checks (pure, no DOM, no network).
 *
 * Loaded by index.html in the browser AND require()-able in Node for tests.
 * Every check is deterministic: the same input always yields the same findings,
 * and each finding points to a specific row (or column). Nothing is guessed.
 */
(function (root) {
  'use strict';

  // Robust CSV parser: handles quoted fields, embedded commas, escaped quotes,
  // and both \n and \r\n line endings. Returns an array of row arrays.
  function parseCSV(text) {
    const rows = [];
    let cur = '';
    let row = [];
    let inQ = false;
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQ = true;
      } else if (c === ',') {
        row.push(cur); cur = '';
      } else if (c === '\n') {
        row.push(cur); rows.push(row); row = []; cur = '';
      } else if (c !== '\r') {
        cur += c;
      }
    }
    if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].trim() === '') {
      rows.pop();
    }
    return rows;
  }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function isNum(v) {
    if (v === '' || v == null) return false;
    return !isNaN(Number(v)) && isFinite(Number(v));
  }

  // Detect a likely ID / date / amount / quantity column by header name.
  function detectCols(headers) {
    const c = { id: null, date: null, amount: null, qty: null };
    (headers || []).forEach(function (h, i) {
      const n = norm(h);
      if (!n) return;
      if (c.id === null && (n === 'id' || n === 'orderid' || n === 'transactionid' ||
          n === 'ref' || n === 'reference' || n === 'invoiceno' || n === 'invoicenumber' ||
          n === 'orderno' || n.endsWith('id') || n.endsWith('number') || n.endsWith('no'))) {
        c.id = i;
      }
      if (c.date === null && (n.indexOf('date') !== -1 || n.indexOf('tarih') !== -1)) c.date = i;
      if (c.amount === null && (n.indexOf('amount') !== -1 || n.indexOf('debit') !== -1 ||
          n.indexOf('credit') !== -1 || n.indexOf('total') !== -1 || n.indexOf('value') !== -1 ||
          n.indexOf('balance') !== -1)) {
        c.amount = i;
      }
      if (c.qty === null && (n.indexOf('qty') !== -1 || n.indexOf('quantity') !== -1 ||
          n.indexOf('units') !== -1 || n.indexOf('count') !== -1)) {
        c.qty = i;
      }
    });
    return c;
  }

  // Quantile with linear interpolation (numpy "type 7" default) — the standard
  // method, so IQR outlier flags match what a statistician would expect.
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (base + 1 < sorted.length) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  // Strict date check: YYYY-MM-DD / YYYY/MM/DD are validated day-of-month
  // (so "2024-02-30" is rejected), other formats fall back to Date.parse.
  function isRealDate(v) {
    const s = String(v).trim();
    if (!s) return false;
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const slash = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const mm = m || slash;
    if (mm) {
      const y = Number(mm[1]), mo = Number(mm[2]), d = Number(mm[3]);
      if (mo < 1 || mo > 12) return false;
      const dim = new Date(y, mo, 0).getDate(); // days in that month
      return d >= 1 && d <= dim;
    }
    return !isNaN(Date.parse(s));
  }

  // Core: run all deterministic checks and return row-referenced findings.
  // Returns { headers, rows, findings } where findings have
  // { row (1-based data row, or null for column-level), col, kind, msg }.
  function checkCSV(text) {
    const rows = parseCSV(text);
    if (rows.length === 0) return { headers: [], rows: [], findings: [] };
    const headers = rows[0];
    const data = rows.slice(1);
    const cols = detectCols(headers);
    const findings = [];

    // 1) exact duplicate rows
    const seen = {};
    data.forEach(function (r, i) {
      const key = r.join('\u0001');
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        findings.push({ row: i + 1, col: '—', kind: 'dup', msg: 'exact duplicate of row ' + seen[key] });
      } else {
        seen[key] = i + 1;
      }
    });

    // 2) duplicate id (case-insensitive, whitespace-trimmed)
    if (cols.id !== null) {
      const idseen = {};
      data.forEach(function (r, i) {
        const v = String(r[cols.id] || '').trim();
        if (!v) return;
        const k = v.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(idseen, k)) {
          findings.push({ row: i + 1, col: headers[cols.id], kind: 'dup', msg: 'duplicate id "' + v + '" (first at row ' + idseen[k] + ')' });
        } else {
          idseen[k] = i + 1;
        }
      });
    }

    // 3) missing values per column
    headers.forEach(function (h, ci) {
      let miss = 0;
      data.forEach(function (r) { if (String(r[ci] || '').trim() === '') miss++; });
      if (miss > 0) {
        findings.push({ row: null, col: h, kind: 'miss', msg: miss + ' of ' + data.length + ' rows empty in this column' });
      }
    });

    // 4) unrecognized dates
    if (cols.date !== null) {
      data.forEach(function (r, i) {
        const v = String(r[cols.date] || '').trim();
        if (v && !isRealDate(v)) {
          findings.push({ row: i + 1, col: headers[cols.date], kind: 'bad', msg: 'unrecognized date "' + v + '"' });
        }
      });
    }

    // 5) non-numeric amounts
    if (cols.amount !== null) {
      data.forEach(function (r, i) {
        const v = String(r[cols.amount] || '').trim();
        if (v !== '' && !isNum(v)) {
          findings.push({ row: i + 1, col: headers[cols.amount], kind: 'bad', msg: 'not a number: "' + v + '"' });
        }
      });
    }

    // 6) zero / negative quantity
    if (cols.qty !== null) {
      data.forEach(function (r, i) {
        const v = String(r[cols.qty] || '').trim();
        if (v !== '' && isNum(v) && Number(v) <= 0) {
          findings.push({ row: i + 1, col: headers[cols.qty], kind: 'bad', msg: 'quantity ' + v + ' is zero or negative' });
        }
      });
    }

    // 7) amount outliers via interquartile range (flag for review, not a hard error)
    if (cols.amount !== null) {
      const vals = [];
      data.forEach(function (r, i) {
        const v = String(r[cols.amount] || '').trim();
        if (v !== '' && isNum(v)) vals.push({ i: i + 1, v: Number(v) });
      });
      if (vals.length >= 4) {
        const s = vals.map(function (x) { return x.v; }).sort(function (a, b) { return a - b; });
        const q1 = quantile(s, 0.25);
        const q3 = quantile(s, 0.75);
        const iqr = q3 - q1;
        const lo = q1 - 1.5 * iqr;
        const hi = q3 + 1.5 * iqr;
        if (iqr > 0) {
          vals.forEach(function (x) {
            if (x.v < lo || x.v > hi) {
              findings.push({ row: x.i, col: headers[cols.amount], kind: 'warn', msg: 'outlier ' + x.v + ' (outside ' + lo.toFixed(2) + '..' + hi.toFixed(2) + ')' });
            }
          });
        }
      }
    }

    return { headers: headers, rows: data, findings: findings };
  }

  const api = { parseCSV: parseCSV, norm: norm, isNum: isNum, isRealDate: isRealDate, detectCols: detectCols, checkCSV: checkCSV };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.ZovrenChecks = api; }
})(typeof window !== 'undefined' ? window : globalThis);
