// ---------- storage ----------

const STORE_KEY = "finance-dashboard-v1";

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { expenses: [], income: [], ledger: [], recurring: [], emiPayments: [], customCategoryColors: {} };
    const parsed = JSON.parse(raw);
    return {
      expenses: parsed.expenses || [],
      income: parsed.income || [],
      ledger: parsed.ledger || [],
      recurring: parsed.recurring || [],
      emiPayments: parsed.emiPayments || [],
      customCategoryColors: parsed.customCategoryColors || {},
    };
  } catch (e) {
    console.error("Failed to load store, starting fresh", e);
    return { expenses: [], income: [], ledger: [], recurring: [], emiPayments: [], customCategoryColors: {} };
  }
}

function saveStore() {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

let store = loadStore();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtMoney(n) {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "-" : "";
  return sign + "₹" + Math.abs(rounded).toLocaleString("en-IN");
}

let toastTimer;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  updateToastPosition();
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 30000);
}

// Keeps the toast above the iOS keyboard: fixed-position elements stay
// pinned to the layout viewport, which the keyboard covers, so we track
// the visual viewport (the part actually visible) and offset manually.
function updateToastPosition() {
  const el = document.getElementById("toast");
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  el.style.bottom = keyboardHeight > 60 ? (keyboardHeight + 12) + "px" : "";
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateToastPosition);
  window.visualViewport.addEventListener("scroll", updateToastPosition);
}

document.getElementById("toast").addEventListener("click", () => {
  clearTimeout(toastTimer);
  document.getElementById("toast").classList.remove("show");
});

// Shrinks a value's font-size just enough to fit on one line, however many
// digits it has, instead of the browser wrapping mid-number. Falls back to
// CSS overflow-wrap only if it can't fit even at the minimum size.
function fitValueText(el) {
  el.style.fontSize = "";
  const baseSize = parseFloat(getComputedStyle(el).fontSize);
  const minSize = 12;
  el.style.whiteSpace = "nowrap";
  let size = baseSize;
  while (el.scrollWidth > el.clientWidth + 1 && size > minSize) {
    size -= 1;
    el.style.fontSize = size + "px";
  }
  el.style.whiteSpace = "";
}

function fitAllValueText() {
  document
    .querySelectorAll(".card-value, .balance-summary-value, .home-month-total, .month-stat-value")
    .forEach(fitValueText);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isThisMonth(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function isWithinDays(dateStr, days) {
  const d = new Date(dateStr).getTime();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return d >= cutoff;
}

function periodOf(dateStr) {
  return dateStr.slice(0, 7);
}

function nextPeriodStr(period) {
  let [y, m] = period.split("-").map(Number);
  m++;
  if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function daysInMonth(year, month1indexed) {
  return new Date(year, month1indexed, 0).getDate();
}

function scheduledDateForPeriod(rule, period) {
  const [y, m] = period.split("-").map(Number);
  if (rule.day === "end") {
    const d = daysInMonth(y, m);
    return `${period}-${String(d).padStart(2, "0")}`;
  }
  return `${period}-01`;
}

function monthsBetween(startPeriod, endPeriod) {
  const [sy, sm] = startPeriod.split("-").map(Number);
  const [ey, em] = endPeriod.split("-").map(Number);
  const out = [];
  let y = sy, m = sm;
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 1200) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
    guard++;
  }
  return out;
}

// ---------- recurring engine ----------

function runRecurringEngine() {
  const today = todayStr();
  const currentPeriod = periodOf(today);
  let changed = false;

  store.recurring.forEach((rule) => {
    rule.postedPeriods = rule.postedPeriods || [];
    const periods = monthsBetween(rule.startMonth, currentPeriod);
    periods.forEach((period) => {
      if (rule.postedPeriods.includes(period)) return;
      const schedDate = scheduledDateForPeriod(rule, period);
      if (schedDate > today) return;

      if (rule.kind === "income") {
        store.income.push({
          id: uid(), date: schedDate, type: rule.subtype || "other",
          amount: rule.amount, note: rule.name, recurringId: rule.id, period,
        });
      } else if (rule.kind === "emi") {
        store.emiPayments.push({
          id: uid(), name: rule.name, date: schedDate,
          amount: rule.amount, recurringId: rule.id, period,
        });
      }
      rule.postedPeriods.push(period);
      changed = true;
    });
  });

  if (changed) saveStore();
}

function getNextOccurrence(rule) {
  let period = rule.startMonth;
  const posted = rule.postedPeriods || [];
  let guard = 0;
  while (posted.includes(period) && guard < 1200) {
    period = nextPeriodStr(period);
    guard++;
  }
  return scheduledDateForPeriod(rule, period);
}

// ---------- bottom nav ----------

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.view).classList.add("active");
    // Values were sized while this tab was display:none (clientWidth reads 0 then),
    // so the shrink-to-fit never actually ran. Re-measure now that it's visible.
    fitAllValueText();
  });
});

// ---------- collapsible "add" sections ----------

document.querySelectorAll(".section-toggle").forEach((btn) => {
  const target = document.getElementById(btn.dataset.target);
  btn.addEventListener("click", () => {
    const isHidden = target.hasAttribute("hidden");
    if (isHidden) {
      target.removeAttribute("hidden");
      btn.classList.add("open");
      const firstInput = target.querySelector("input, select");
      if (firstInput) firstInput.focus();
    } else {
      target.setAttribute("hidden", "");
      btn.classList.remove("open");
    }
  });
});

function collapseSection(wrapId) {
  const wrap = document.getElementById(wrapId);
  wrap.setAttribute("hidden", "");
  const toggle = document.querySelector(`.section-toggle[data-target="${wrapId}"]`);
  if (toggle) toggle.classList.remove("open");
}

// ---------- charts (vanilla SVG, no dependencies) ----------

const CATEGORY_COLORS = {
  Food: "#3b82f6",
  Utilities: "#10b981",
  Personal: "#f97316",
  Health: "#ec4899",
  Transport: "#a855f7",
  Habits: "#eab308",
  "Credit Card": "#06b6d4",
  Office: "#475569",
};
const FALLBACK_COLOR = "#9ca3af";

// Categories offered in the quick-add tile picker. Kept fixed and small on
// purpose so the Home screen stays fast and scroll-free.
const CURATED_CATEGORIES = Object.keys(CATEGORY_COLORS);

// Restores any custom category colors from a previously-imported backup.
function applyCustomCategoryColors() {
  Object.entries(store.customCategoryColors || {}).forEach(([cat, color]) => {
    CATEGORY_COLORS[cat] = color;
  });
}

const CATEGORY_ICONS = {
  Food: '<path d="M7 2v8M7 2c-1.5 0-2 1-2 2v4c0 1 .5 2 2 2M7 10v12M17 2v20M17 2c-2 0-3 1.5-3 4s1 4 3 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  Utilities: '<path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
  Personal: '<circle cx="12" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  Health: '<path d="M12 20s-7-4.35-9.5-8.8C1 8 2.8 4.5 6.3 4.5c1.9 0 3.4 1.1 4.2 2.6.8-1.5 2.3-2.6 4.2-2.6 3.5 0 5.3 3.5 3.8 6.7C19 15.65 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
  Transport: '<path d="M4 16V10a2 2 0 0 1 2-2h3l2-3h2l2 3h3a2 2 0 0 1 2 2v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7.5" cy="18" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="18" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  Habits: '<path d="M17 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 6H8a5 5 0 0 0-5 5v1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 22l-4-4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 18h13a5 5 0 0 0 5-5v-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  "Credit Card": '<rect x="2.5" y="5.5" width="19" height="13" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 9.5h19" stroke="currentColor" stroke-width="1.6"/><path d="M6 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  Office: '<rect x="3" y="7" width="18" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 7V5.3a1.8 1.8 0 0 1 1.8-1.8h3.4a1.8 1.8 0 0 1 1.8 1.8V7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 12.5h18" stroke="currentColor" stroke-width="1.6"/>',
};

function categoryIconSvg(name) {
  const inner = CATEGORY_ICONS[name] || CATEGORY_ICONS.Personal;
  return `<svg viewBox="0 0 24 24" width="22" height="22">${inner}</svg>`;
}

function renderDonut(byCat) {
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const size = 78, thickness = 13, r = (size - thickness) / 2, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;

  let circles = "";
  if (total <= 0) {
    circles = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e7e9f2" stroke-width="${thickness}" />`;
  } else {
    let offset = 0;
    entries.forEach(([cat, val]) => {
      const frac = val / total;
      const len = frac * c;
      const color = CATEGORY_COLORS[cat] || FALLBACK_COLOR;
      circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"><title>${cat}: ${fmtMoney(val)}</title></circle>`;
      offset += len;
    });
  }

  const donutEl = document.getElementById("donut-chart");
  donutEl.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${circles}</svg>`;

  const legendEl = document.getElementById("donut-legend");
  if (!entries.length) {
    legendEl.innerHTML = `<div class="empty-state" style="display:block">No expenses yet.</div>`;
    return;
  }
  legendEl.innerHTML = entries.map(([cat, val]) => {
    const pct = total ? Math.round((val / total) * 100) : 0;
    const color = CATEGORY_COLORS[cat] || FALLBACK_COLOR;
    return `<div class="legend-row">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-label">${cat}</span>
      <span class="legend-pct">${pct}%</span>
      <span class="legend-amt">${fmtMoney(val)}</span>
    </div>`;
  }).join("");
}

function renderMiniTrend(expenses) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const total = expenses.filter((x) => x.date === dateStr).reduce((s, x) => s + x.amount, 0);
    days.push({ date: dateStr, total, label: d.toLocaleDateString(undefined, { weekday: "narrow" }) });
  }

  const windowTotal = days.reduce((s, d) => s + d.total, 0);
  if (windowTotal === 0) {
    document.getElementById("mini-trend").innerHTML =
      '<div class="trend-empty">No expenses in the last 7 days</div>';
    return;
  }

  const w = 260, h = 42, gap = 6;
  const max = Math.max(1, ...days.map((d) => d.total));
  const barW = (w - gap * (days.length - 1)) / days.length;

  const bars = days.map((d, i) => {
    const bh = (d.total / max) * (h - 2);
    const x = i * (barW + gap);
    const y = h - bh;
    const color = d.total > 0 ? "var(--accent)" : "#e7e9f2";
    const label = new Date(d.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, 3).toFixed(1)}" rx="3" fill="${color}"><title>${label}: ${fmtMoney(d.total)}</title></rect>`;
  }).join("");

  document.getElementById("mini-trend").innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}

function renderTrend(expenses) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const total = expenses.filter((x) => x.date === dateStr).reduce((s, x) => s + x.amount, 0);
    days.push({ date: dateStr, total });
  }

  const windowTotal = days.reduce((s, d) => s + d.total, 0);
  if (windowTotal === 0) {
    document.getElementById("trend-chart").innerHTML =
      '<div class="trend-empty">No expenses in the last 14 days</div>';
    return;
  }

  const w = 500, h = 110, gap = 4;
  const max = Math.max(1, ...days.map((d) => d.total));
  const barW = (w - gap * (days.length - 1)) / days.length;

  const bars = days.map((d, i) => {
    const bh = (d.total / max) * (h - 4);
    const x = i * (barW + gap);
    const y = h - bh;
    const label = new Date(d.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" rx="2" fill="var(--accent)"><title>${label}: ${fmtMoney(d.total)}</title></rect>`;
  }).join("");

  document.getElementById("trend-chart").innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}

function lastNMonths(n) {
  const months = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString(undefined, { month: "short" }),
      total: 0,
    });
  }
  return months;
}

function renderMonthlyTrend(expenses) {
  const months = lastNMonths(6);
  expenses.forEach((x) => {
    const m = months.find((mo) => mo.period === periodOf(x.date));
    if (m) m.total += x.amount;
  });

  const container = document.getElementById("monthly-trend-chart");
  const windowTotal = months.reduce((s, m) => s + m.total, 0);
  if (windowTotal === 0) {
    container.innerHTML = '<div class="trend-empty">No expenses in the last 6 months</div>';
    return;
  }

  const w = 320, h = 130, gap = 10, labelH = 16;
  const max = Math.max(1, ...months.map((m) => m.total));
  const barW = (w - gap * (months.length - 1)) / months.length;

  const bars = months.map((m, i) => {
    const bh = (m.total / max) * (h - labelH - 6);
    const x = i * (barW + gap);
    const y = h - labelH - bh;
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" rx="4" fill="var(--accent)"><title>${m.label}: ${fmtMoney(m.total)}</title></rect>
      <text x="${(x + barW / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle" font-size="10" fill="var(--text-dim)">${m.label}</text>`;
  }).join("");

  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="140">${bars}</svg>`;
}

function renderSpendHeatmap(expenses) {
  const weeks = 12;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysBack = (weeks - 1) * 7 + today.getDay();
  const start = new Date(today);
  start.setDate(start.getDate() - daysBack);

  const byDate = {};
  expenses.forEach((x) => { byDate[x.date] = (byDate[x.date] || 0) + x.amount; });

  const days = [];
  let max = 1;
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const future = d > today;
    const total = future ? null : (byDate[dateStr] || 0);
    if (total !== null && total > max) max = total;
    days.push({ date: dateStr, total, dow: d.getDay(), week: Math.floor(i / 7), future });
  }

  const levelColor = (total) => {
    if (total === null) return "transparent";
    if (total <= 0) return "#e7e9f2";
    const ratio = total / max;
    if (ratio > 0.75) return "#1d3fd6";
    if (ratio > 0.5) return "#4361ee";
    if (ratio > 0.25) return "#7c93f5";
    return "#b8c4fa";
  };

  const cells = days.map((d) => {
    const style = `grid-column:${d.week + 1};grid-row:${d.dow + 1};background:${levelColor(d.total)}`;
    const tooltip = d.future ? "" : ` title="${d.date}: ${fmtMoney(d.total)}"`;
    return `<div class="heatmap-cell" style="${style}"${tooltip}></div>`;
  }).join("");

  document.getElementById("spend-heatmap").innerHTML =
    `<div class="heatmap-grid" style="grid-template-columns: repeat(${weeks}, 1fr);">${cells}</div>`;
}

function renderCategoryTrend(expenses) {
  const select = document.getElementById("category-trend-select");
  const cats = [...new Set(expenses.map((x) => x.category))].sort();

  if (!cats.length) {
    select.innerHTML = "";
    document.getElementById("category-trend-chart").innerHTML =
      '<div class="trend-empty">No expenses yet</div>';
    return;
  }

  const byCatTotal = {};
  expenses.forEach((x) => { byCatTotal[x.category] = (byCatTotal[x.category] || 0) + x.amount; });
  const defaultCat = Object.entries(byCatTotal).sort((a, b) => b[1] - a[1])[0][0];
  const chosen = cats.includes(select.value) ? select.value : defaultCat;

  select.innerHTML = cats.map((c) => `<option value="${c}" ${c === chosen ? "selected" : ""}>${c}</option>`).join("");
  drawCategoryTrendChart(expenses, chosen);
}

function drawCategoryTrendChart(expenses, category) {
  const months = lastNMonths(6);
  expenses.filter((x) => x.category === category).forEach((x) => {
    const m = months.find((mo) => mo.period === periodOf(x.date));
    if (m) m.total += x.amount;
  });

  const container = document.getElementById("category-trend-chart");
  const windowTotal = months.reduce((s, m) => s + m.total, 0);
  if (windowTotal === 0) {
    container.innerHTML = `<div class="trend-empty">No ${category} expenses in the last 6 months</div>`;
    return;
  }

  const w = 320, h = 120, padX = 12, padY = 16;
  const max = Math.max(1, ...months.map((m) => m.total));
  const stepX = (w - padX * 2) / (months.length - 1);
  const color = CATEGORY_COLORS[category] || FALLBACK_COLOR;

  const points = months.map((m, i) => ({
    x: padX + i * stepX,
    y: h - padY - (m.total / max) * (h - padY * 2 - 8),
    m,
  }));

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const dots = points.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${color}"><title>${p.m.label}: ${fmtMoney(p.m.total)}</title></circle>`
  ).join("");
  const labels = points.map((p) =>
    `<text x="${p.x.toFixed(1)}" y="${h - 1}" text-anchor="middle" font-size="10" fill="var(--text-dim)">${p.m.label}</text>`
  ).join("");

  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="130">
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}
  </svg>`;
}

document.getElementById("category-trend-select").addEventListener("change", (e) => {
  drawCategoryTrendChart(store.expenses, e.target.value);
});

// ---------- expenses: category grid + quick add ----------

let quickCategory = CURATED_CATEGORIES[0];

function renderCategoryGrid() {
  const grid = document.getElementById("category-grid");
  grid.innerHTML = CURATED_CATEGORIES.map((cat) => {
    const color = CATEGORY_COLORS[cat];
    const selected = cat === quickCategory;
    return `<button type="button" class="category-tile${selected ? " selected" : ""}" data-cat="${cat}">
      <span class="tile-icon" style="background:${color}22; color:${color}; ${selected ? `border:1.5px solid ${color}` : ""}">${categoryIconSvg(cat)}</span>
      <span class="tile-label">${cat}</span>
    </button>`;
  }).join("");

  grid.querySelectorAll(".category-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      quickCategory = tile.dataset.cat;
      renderCategoryGrid();
    });
  });
}

const expenseForm = document.getElementById("expense-form");
const expenseAmountInput = document.getElementById("exp-amount");
const expenseConfirmBtn = document.getElementById("key-confirm");

expenseAmountInput.addEventListener("input", () => {
  expenseConfirmBtn.disabled = !(parseFloat(expenseAmountInput.value) > 0);
});

// ---------- note autocomplete + category memory ----------

let noteHistoryMap = {};

function updateNoteHistory(sortedDescExpenses) {
  noteHistoryMap = {};
  sortedDescExpenses.forEach((x) => {
    const trimmed = (x.note || "").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!(key in noteHistoryMap)) noteHistoryMap[key] = x.category;
  });
}

document.getElementById("exp-note").addEventListener("input", (e) => {
  const key = e.target.value.trim().toLowerCase();
  if (!key) return;
  const cat = noteHistoryMap[key];
  if (cat && CURATED_CATEGORIES.includes(cat) && cat !== quickCategory) {
    quickCategory = cat;
    renderCategoryGrid();
  }
});

expenseForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = Math.round(parseFloat(expenseAmountInput.value));
  if (isNaN(amount) || amount <= 0) return;
  const note = document.getElementById("exp-note").value.trim();

  store.expenses.push({ id: uid(), date: todayStr(), amount, category: quickCategory, note });
  saveStore();
  expenseForm.reset();
  expenseConfirmBtn.disabled = true;
  expenseAmountInput.focus();
  renderExpenses();
  showToast("Expense saved");
});

function deleteExpense(id) {
  store.expenses = store.expenses.filter((x) => x.id !== id);
  saveStore();
  renderExpenses();
}

function renderExpenses() {
  const expenses = [...store.expenses].sort((a, b) => b.date.localeCompare(a.date));
  updateNoteHistory(expenses);
  const monthExpenses = expenses.filter((x) => isThisMonth(x.date));

  const monthTotal = monthExpenses.reduce((s, x) => s + x.amount, 0);
  const d30Total = expenses.filter((x) => isWithinDays(x.date, 30)).reduce((s, x) => s + x.amount, 0);
  const allTotal = expenses.reduce((s, x) => s + x.amount, 0);

  document.getElementById("exp-month-total").textContent = fmtMoney(monthTotal);
  document.getElementById("exp-30d-total").textContent = fmtMoney(d30Total);
  document.getElementById("exp-all-total").textContent = fmtMoney(allTotal);

  const allByCat = {};
  expenses.forEach((x) => { allByCat[x.category] = (allByCat[x.category] || 0) + x.amount; });
  const catEntries = Object.entries(allByCat).sort((a, b) => b[1] - a[1]);
  document.getElementById("exp-top-category").textContent = catEntries.length ? catEntries[0][0] : "—";

  const monthByCat = {};
  monthExpenses.forEach((x) => { monthByCat[x.category] = (monthByCat[x.category] || 0) + x.amount; });

  renderDonut(monthByCat);
  renderMiniTrend(expenses);
  renderTrend(expenses);
  renderMonthlyTrend(expenses);
  renderSpendHeatmap(expenses);
  renderCategoryTrend(expenses);

  renderExpenseRows("expense-tbody", "expense-empty", expenses, 50);
  renderExpenseRows("home-recent-tbody", "home-recent-empty", expenses, 5);
  fitAllValueText();
}

function renderExpenseRows(listId, emptyId, expenses, limit) {
  const list = document.getElementById(listId);
  list.innerHTML = "";
  document.getElementById(emptyId).style.display = expenses.length ? "none" : "block";

  expenses.slice(0, limit).forEach((x) => {
    const color = CATEGORY_COLORS[x.category] || FALLBACK_COLOR;
    const row = document.createElement("div");
    row.className = "txn-row";
    row.dataset.id = x.id;
    row.innerHTML = `
      <span class="txn-dot" style="background:${color}"></span>
      <div class="txn-main">
        <div class="txn-title txn-editable" data-id="${x.id}" title="Tap to change category">${x.category}</div>
        <div class="txn-sub">${x.note ? x.note + " · " : ""}${x.date}</div>
      </div>
      <div class="txn-amount negative">${fmtMoney(x.amount)}</div>
      <button class="txn-edit-btn" data-id="${x.id}" aria-label="Edit">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="txn-delete" data-id="${x.id}" aria-label="Delete">×</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".txn-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });
  list.querySelectorAll(".txn-editable").forEach((el) => {
    el.addEventListener("click", () => openCategoryEditor(el));
  });
  list.querySelectorAll(".txn-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openExpenseEditor(btn.closest(".txn-row"), btn.dataset.id));
  });
}

function openExpenseEditor(rowEl, id) {
  const expense = store.expenses.find((x) => x.id === id);
  if (!expense) return;

  const categoryOptions = Object.keys(CATEGORY_COLORS)
    .map((c) => `<option value="${c}" ${c === expense.category ? "selected" : ""}>${c}</option>`)
    .join("");

  rowEl.innerHTML = `
    <div class="txn-edit-form">
      <div class="txn-edit-grid">
        <input type="date" class="txn-edit-date" value="${expense.date}">
        <input type="number" class="txn-edit-amount" value="${expense.amount}" step="1" min="1">
      </div>
      <select class="txn-edit-category">${categoryOptions}</select>
      <input type="text" class="txn-edit-note" value="${expense.note || ""}" placeholder="Note (optional)">
      <div class="txn-edit-actions">
        <button type="button" class="btn-secondary txn-edit-cancel">Cancel</button>
        <button type="button" class="btn-primary txn-edit-save">Save</button>
      </div>
    </div>
  `;

  rowEl.querySelector(".txn-edit-cancel").addEventListener("click", () => renderExpenses());
  rowEl.querySelector(".txn-edit-save").addEventListener("click", () => {
    const date = rowEl.querySelector(".txn-edit-date").value;
    const amount = Math.round(parseFloat(rowEl.querySelector(".txn-edit-amount").value));
    const category = rowEl.querySelector(".txn-edit-category").value;
    const note = rowEl.querySelector(".txn-edit-note").value.trim();
    if (!date || isNaN(amount) || amount <= 0) return;

    expense.date = date;
    expense.amount = amount;
    expense.category = category;
    expense.note = note;
    saveStore();
    renderAll();
  });
}

function openCategoryEditor(titleEl) {
  const id = titleEl.dataset.id;
  const expense = store.expenses.find((x) => x.id === id);
  if (!expense) return;

  const select = document.createElement("select");
  select.className = "txn-edit-select";
  Object.keys(CATEGORY_COLORS).forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    if (cat === expense.category) opt.selected = true;
    select.appendChild(opt);
  });

  const finish = () => renderExpenses();
  select.addEventListener("change", () => {
    expense.category = select.value;
    saveStore();
    renderAll();
  });
  select.addEventListener("blur", finish, { once: true });

  titleEl.replaceWith(select);
  select.focus();
}

// ---------- income ----------

const incomeForm = document.getElementById("income-form");
document.getElementById("inc-date").value = todayStr();

incomeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const date = document.getElementById("inc-date").value;
  const amount = Math.round(parseFloat(document.getElementById("inc-amount").value));
  const note = document.getElementById("inc-note").value.trim();
  if (!date || isNaN(amount)) return;

  store.income.push({ id: uid(), date, type: "interest", amount, note });
  saveStore();
  incomeForm.reset();
  document.getElementById("inc-date").value = todayStr();
  collapseSection("income-form-wrap");
  renderIncome();
  renderStatus();
});

function deleteIncome(id) {
  store.income = store.income.filter((x) => x.id !== id);
  saveStore();
  renderIncome();
  renderStatus();
}

function renderIncome() {
  const income = [...store.income].sort((a, b) => b.date.localeCompare(a.date));

  const list = document.getElementById("income-tbody");
  list.innerHTML = "";
  document.getElementById("income-empty").style.display = income.length ? "none" : "block";

  income.slice(0, 50).forEach((x) => {
    const row = document.createElement("div");
    row.className = "txn-row";
    row.innerHTML = `
      <span class="txn-dot" style="background:var(--positive)"></span>
      <div class="txn-main">
        <div class="txn-title">${x.type}</div>
        <div class="txn-sub">${x.note ? x.note + " · " : ""}${x.date}</div>
      </div>
      <div class="txn-amount positive">${fmtMoney(x.amount)}</div>
      <button class="txn-delete" data-id="${x.id}" aria-label="Delete">×</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".txn-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteIncome(btn.dataset.id));
  });
}

// ---------- ledger (loans) ----------

const ledgerForm = document.getElementById("ledger-form");
document.getElementById("ldg-date").value = todayStr();

ledgerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const person = document.getElementById("ldg-person").value.trim();
  const date = document.getElementById("ldg-date").value;
  const direction = document.getElementById("ldg-direction").value;
  const amount = Math.round(parseFloat(document.getElementById("ldg-amount").value));
  const note = document.getElementById("ldg-note").value.trim();
  if (!person || !date || isNaN(amount)) return;

  store.ledger.push({ id: uid(), person, date, direction, amount, note });
  saveStore();
  ledgerForm.reset();
  document.getElementById("ldg-date").value = todayStr();
  collapseSection("ledger-form-wrap");
  renderLedger();
});

function deleteLedgerEntry(id) {
  store.ledger = store.ledger.filter((x) => x.id !== id);
  saveStore();
  renderLedger();
}

function renderLedger() {
  const entries = [...store.ledger].sort((a, b) => b.date.localeCompare(a.date));

  const people = [...new Set(store.ledger.map((x) => x.person))];
  const peopleList = document.getElementById("people-list");
  peopleList.innerHTML = people.map((p) => `<option value="${p}"></option>`).join("");

  const balances = {};
  entries.forEach((x) => {
    balances[x.person] = balances[x.person] || 0;
    balances[x.person] += x.direction === "i_paid" ? x.amount : -x.amount;
  });

  let totalOwedToMe = 0;
  let totalIOwe = 0;
  Object.values(balances).forEach((b) => {
    if (b > 0) totalOwedToMe += b;
    if (b < 0) totalIOwe += -b;
  });

  document.getElementById("net-owed-to-me").textContent = fmtMoney(totalOwedToMe);
  document.getElementById("net-i-owe").textContent = fmtMoney(totalIOwe);

  const balancesList = document.getElementById("balances-list");
  balancesList.innerHTML = "";
  const balanceEntries = Object.entries(balances).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  document.getElementById("balances-empty").style.display = balanceEntries.length ? "none" : "block";

  balanceEntries.forEach(([person, bal]) => {
    const row = document.createElement("div");
    row.className = "balance-row";
    const cls = bal > 0 ? "positive" : bal < 0 ? "negative" : "zero";
    const label = bal > 0 ? "owes you" : bal < 0 ? "you owe" : "settled";
    row.innerHTML = `
      <div>
        <div class="balance-person">${person}</div>
        <div class="balance-sub">${label}</div>
      </div>
      <div class="balance-amount ${cls}">${fmtMoney(Math.abs(bal))}</div>
    `;
    balancesList.appendChild(row);
  });

  const list = document.getElementById("ledger-tbody");
  list.innerHTML = "";
  document.getElementById("ledger-empty").style.display = entries.length ? "none" : "block";

  entries.slice(0, 50).forEach((x) => {
    const signed = x.direction === "i_paid" ? x.amount : -x.amount;
    const cls = signed >= 0 ? "positive" : "negative";
    const row = document.createElement("div");
    row.className = "txn-row";
    row.innerHTML = `
      <span class="txn-dot" style="background:var(--${cls === "positive" ? "positive" : "negative"})"></span>
      <div class="txn-main">
        <div class="txn-title">${x.person}</div>
        <div class="txn-sub">${x.note ? x.note + " · " : ""}${x.date}</div>
      </div>
      <div class="txn-amount ${cls}">${signed >= 0 ? "+" : ""}${fmtMoney(signed)}</div>
      <button class="txn-delete" data-id="${x.id}" aria-label="Delete">×</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".txn-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteLedgerEntry(btn.dataset.id));
  });
}

// ---------- monthly status ----------

function renderStatus() {
  const income = document.getElementById("ledger-income-month");
  const emiEl = document.getElementById("ledger-emi-month");
  const netEl = document.getElementById("ledger-net-month");

  const cashBalance = store.income.filter((x) => !x.recurringId).reduce((s, x) => s + x.amount, 0);
  document.getElementById("cash-balance").textContent = fmtMoney(cashBalance);

  const incomeMonth = store.income.filter((x) => isThisMonth(x.date)).reduce((s, x) => s + x.amount, 0);
  const emiMonth = store.emiPayments.filter((x) => isThisMonth(x.date)).reduce((s, x) => s + x.amount, 0);
  const netMonth = incomeMonth - emiMonth;

  income.textContent = fmtMoney(incomeMonth);
  emiEl.textContent = fmtMoney(emiMonth);
  netEl.textContent = fmtMoney(netMonth);
  netEl.classList.remove("positive", "negative");
  netEl.classList.add(netMonth >= 0 ? "positive" : "negative");

  const periods = new Set([
    ...store.income.map((x) => periodOf(x.date)),
    ...store.emiPayments.map((x) => periodOf(x.date)),
  ]);
  const sorted = [...periods].sort().reverse().slice(0, 12);

  const list = document.getElementById("status-tbody");
  list.innerHTML = "";
  document.getElementById("status-empty").style.display = sorted.length ? "none" : "block";

  sorted.forEach((period) => {
    const inc = store.income.filter((x) => periodOf(x.date) === period).reduce((s, x) => s + x.amount, 0);
    const emi = store.emiPayments.filter((x) => periodOf(x.date) === period).reduce((s, x) => s + x.amount, 0);
    const net = inc - emi;
    const label = new Date(period + "-01").toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const netCls = net >= 0 ? "positive" : "negative";
    const row = document.createElement("div");
    row.className = "month-row";
    row.innerHTML = `
      <div class="month-row-title">${label}</div>
      <div class="month-row-stats">
        <div class="month-stat">
          <div class="month-stat-label">Income</div>
          <div class="month-stat-value positive">${fmtMoney(inc)}</div>
        </div>
        <div class="month-stat">
          <div class="month-stat-label">EMI outgo</div>
          <div class="month-stat-value negative">${fmtMoney(emi)}</div>
        </div>
        <div class="month-stat">
          <div class="month-stat-label">Net</div>
          <div class="month-stat-value ${netCls}">${fmtMoney(net)}</div>
        </div>
      </div>
    `;
    list.appendChild(row);
  });
  fitAllValueText();
}

// ---------- recurring items ----------

const recurringForm = document.getElementById("recurring-form");
document.getElementById("rec-start-month").value = periodOf(todayStr());

document.getElementById("rec-kind").addEventListener("change", (e) => {
  document.getElementById("rec-subtype-row").style.display = e.target.value === "income" ? "flex" : "none";
});

recurringForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("rec-name").value.trim();
  const kind = document.getElementById("rec-kind").value;
  const subtype = document.getElementById("rec-subtype").value;
  const amount = Math.round(parseFloat(document.getElementById("rec-amount").value));
  const day = document.getElementById("rec-day").value;
  const startMonth = document.getElementById("rec-start-month").value;
  if (!name || isNaN(amount) || !startMonth) return;

  store.recurring.push({
    id: uid(), name, kind, subtype: kind === "income" ? subtype : undefined,
    amount, day, startMonth, postedPeriods: [],
  });
  saveStore();
  runRecurringEngine();
  recurringForm.reset();
  document.getElementById("rec-start-month").value = periodOf(todayStr());
  document.getElementById("rec-subtype-row").style.display = "flex";
  collapseSection("recurring-form-wrap");
  renderAll();
});

function deleteRecurring(id) {
  store.recurring = store.recurring.filter((x) => x.id !== id);
  saveStore();
  renderRecurring();
}

function renderRecurring() {
  const rules = [...store.recurring].sort((a, b) => getNextOccurrence(a).localeCompare(getNextOccurrence(b)));
  const list = document.getElementById("recurring-list");
  list.innerHTML = "";
  document.getElementById("recurring-empty").style.display = rules.length ? "none" : "block";

  rules.forEach((rule) => {
    const next = getNextOccurrence(rule);
    const overdue = next <= todayStr();
    const row = document.createElement("div");
    row.className = "balance-row";
    row.dataset.id = rule.id;
    row.innerHTML = `
      <div>
        <div class="balance-person">${rule.name} <span class="badge ${rule.kind === "emi" ? "emi" : ""}">${rule.kind === "emi" ? "EMI" : rule.subtype}</span></div>
        <div class="balance-sub">${fmtMoney(rule.amount)} · ${rule.day === "end" ? "end" : "start"} of month · ${overdue ? "posts on next visit" : "next: " + next}</div>
      </div>
      <div class="recurring-row-actions">
        <button class="txn-edit-btn" data-id="${rule.id}" aria-label="Edit">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="row-delete" data-id="${rule.id}">Delete</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".row-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteRecurring(btn.dataset.id));
  });
  list.querySelectorAll(".txn-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openRecurringEditor(btn.closest(".balance-row"), btn.dataset.id));
  });
}

function openRecurringEditor(rowEl, id) {
  const rule = store.recurring.find((r) => r.id === id);
  if (!rule) return;

  rowEl.innerHTML = `
    <div class="txn-edit-form">
      <input type="text" class="rec-edit-name" value="${rule.name}" placeholder="Name">
      <div class="txn-edit-grid">
        <select class="rec-edit-kind">
          <option value="income" ${rule.kind === "income" ? "selected" : ""}>Income</option>
          <option value="emi" ${rule.kind === "emi" ? "selected" : ""}>EMI / Loan payment</option>
        </select>
        <select class="rec-edit-subtype" ${rule.kind === "income" ? "" : "hidden"}>
          <option value="salary" ${rule.subtype === "salary" ? "selected" : ""}>Salary</option>
          <option value="interest" ${rule.subtype === "interest" ? "selected" : ""}>Interest</option>
          <option value="business" ${rule.subtype === "business" ? "selected" : ""}>Business</option>
          <option value="other" ${rule.subtype === "other" ? "selected" : ""}>Other</option>
        </select>
      </div>
      <div class="txn-edit-grid">
        <input type="number" class="rec-edit-amount" value="${rule.amount}" step="1" min="0">
        <select class="rec-edit-day">
          <option value="start" ${rule.day === "start" ? "selected" : ""}>Start of month</option>
          <option value="end" ${rule.day === "end" ? "selected" : ""}>End of month</option>
        </select>
      </div>
      <input type="month" class="rec-edit-start" value="${rule.startMonth}">
      <div class="txn-edit-actions">
        <button type="button" class="btn-secondary rec-edit-cancel">Cancel</button>
        <button type="button" class="btn-primary rec-edit-save">Save</button>
      </div>
    </div>
  `;

  const kindSelect = rowEl.querySelector(".rec-edit-kind");
  const subtypeSelect = rowEl.querySelector(".rec-edit-subtype");
  kindSelect.addEventListener("change", () => {
    subtypeSelect.hidden = kindSelect.value !== "income";
  });

  rowEl.querySelector(".rec-edit-cancel").addEventListener("click", () => renderRecurring());
  rowEl.querySelector(".rec-edit-save").addEventListener("click", () => {
    const name = rowEl.querySelector(".rec-edit-name").value.trim();
    const kind = kindSelect.value;
    const amount = Math.round(parseFloat(rowEl.querySelector(".rec-edit-amount").value));
    const day = rowEl.querySelector(".rec-edit-day").value;
    const startMonth = rowEl.querySelector(".rec-edit-start").value;
    if (!name || isNaN(amount) || !startMonth) return;

    rule.name = name;
    rule.kind = kind;
    rule.subtype = kind === "income" ? subtypeSelect.value : undefined;
    rule.amount = amount;
    rule.day = day;
    rule.startMonth = startMonth;
    saveStore();
    runRecurringEngine();
    renderAll();
  });
}

function renderEmiHistory() {
  const payments = [...store.emiPayments].sort((a, b) => b.date.localeCompare(a.date));
  const list = document.getElementById("emi-tbody");
  list.innerHTML = "";
  document.getElementById("emi-empty").style.display = payments.length ? "none" : "block";

  payments.slice(0, 50).forEach((x) => {
    const row = document.createElement("div");
    row.className = "txn-row";
    row.innerHTML = `
      <span class="txn-dot" style="background:var(--negative)"></span>
      <div class="txn-main">
        <div class="txn-title">${x.name}</div>
        <div class="txn-sub">${x.date}</div>
      </div>
      <div class="txn-amount negative">${fmtMoney(x.amount)}</div>
    `;
    list.appendChild(row);
  });
}

// ---------- backup & transfer ----------

document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `expenser-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let imported;
    try {
      imported = JSON.parse(reader.result);
    } catch (err) {
      alert("That file isn't valid backup data.");
      e.target.value = "";
      return;
    }

    const confirmed = confirm(
      "This replaces everything currently in the app with the imported backup. Continue?"
    );
    if (!confirmed) {
      e.target.value = "";
      return;
    }

    store = {
      expenses: imported.expenses || [],
      income: imported.income || [],
      ledger: imported.ledger || [],
      recurring: imported.recurring || [],
      emiPayments: imported.emiPayments || [],
      customCategoryColors: imported.customCategoryColors || {},
    };
    saveStore();
    applyCustomCategoryColors();
    runRecurringEngine();
    renderAll();
    e.target.value = "";
  };
  reader.readAsText(file);
});

// ---------- privacy toggle ----------

const PRIVACY_KEY = "expenser-privacy-mode";

const EYE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c7 0 10.5 7 10.5 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.4 8.6 1.5 12 1.5 12S5 19 12 19a10.6 10.6 0 0 0 4.2-.9"/><path d="M9.5 9.8a3 3 0 0 0 4.2 4.2"/></svg>';

const privacyToggle = document.getElementById("privacy-toggle");

function setPrivacyMode(on) {
  document.body.classList.toggle("privacy-mode", on);
  privacyToggle.classList.toggle("active", on);
  privacyToggle.innerHTML = on ? EYE_OFF_ICON : EYE_ICON;
  privacyToggle.setAttribute("aria-label", on ? "Show amounts" : "Hide amounts");
  localStorage.setItem(PRIVACY_KEY, on ? "1" : "0");
}

privacyToggle.addEventListener("click", () => {
  setPrivacyMode(!document.body.classList.contains("privacy-mode"));
});

setPrivacyMode(localStorage.getItem(PRIVACY_KEY) === "1");

// ---------- init ----------

function renderAll() {
  renderCategoryGrid();
  renderExpenses();
  renderIncome();
  renderLedger();
  renderStatus();
  renderRecurring();
  renderEmiHistory();
}

applyCustomCategoryColors();
runRecurringEngine();
renderAll();
