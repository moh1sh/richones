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
};
const FALLBACK_COLOR = "#9ca3af";

// Categories offered in the quick-add tile picker. Kept fixed and small on
// purpose so the Home screen stays fast and scroll-free, regardless of how
// many extra categories come in through CSV imports.
const CURATED_CATEGORIES = Object.keys(CATEGORY_COLORS);

// Colors auto-assigned to categories discovered via CSV import that don't
// match any curated category (e.g. "Uncategorized", or an unmapped label).
const AUTO_PALETTE = ["#0ea5e9", "#84cc16", "#f59e0b", "#8b5cf6", "#14b8a6", "#f43f5e", "#6366f1"];

function ensureCategoryColor(cat) {
  if (CATEGORY_COLORS[cat]) return;
  const existing = store.customCategoryColors[cat];
  if (existing) {
    CATEGORY_COLORS[cat] = existing;
    return;
  }
  const usedCount = Object.keys(store.customCategoryColors).length;
  const color = AUTO_PALETTE[usedCount % AUTO_PALETTE.length];
  CATEGORY_COLORS[cat] = color;
  store.customCategoryColors[cat] = color;
}

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
});

function deleteExpense(id) {
  store.expenses = store.expenses.filter((x) => x.id !== id);
  saveStore();
  renderExpenses();
}

function renderExpenses() {
  const expenses = [...store.expenses].sort((a, b) => b.date.localeCompare(a.date));
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

  const tbody = document.getElementById("expense-tbody");
  tbody.innerHTML = "";
  document.getElementById("expense-empty").style.display = expenses.length ? "none" : "block";

  expenses.slice(0, 50).forEach((x) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${x.date}</td>
      <td>${x.category}</td>
      <td>${x.note || ""}</td>
      <td class="num">${fmtMoney(x.amount)}</td>
      <td><button class="row-delete" data-id="${x.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".row-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });
}

// ---------- income ----------

const incomeForm = document.getElementById("income-form");
document.getElementById("inc-date").value = todayStr();

incomeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const date = document.getElementById("inc-date").value;
  const type = document.getElementById("inc-type").value;
  const amount = Math.round(parseFloat(document.getElementById("inc-amount").value));
  const note = document.getElementById("inc-note").value.trim();
  if (!date || isNaN(amount)) return;

  store.income.push({ id: uid(), date, type, amount, note });
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

  const tbody = document.getElementById("income-tbody");
  tbody.innerHTML = "";
  document.getElementById("income-empty").style.display = income.length ? "none" : "block";

  income.slice(0, 50).forEach((x) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${x.date}</td>
      <td>${x.type}</td>
      <td>${x.note || ""}</td>
      <td class="num">${fmtMoney(x.amount)}</td>
      <td><button class="row-delete" data-id="${x.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".row-delete").forEach((btn) => {
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

  const tbody = document.getElementById("ledger-tbody");
  tbody.innerHTML = "";
  document.getElementById("ledger-empty").style.display = entries.length ? "none" : "block";

  entries.slice(0, 50).forEach((x) => {
    const signed = x.direction === "i_paid" ? x.amount : -x.amount;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${x.date}</td>
      <td>${x.person}</td>
      <td>${x.note || ""}</td>
      <td class="num" style="color:${signed >= 0 ? "var(--positive)" : "var(--negative)"}">${signed >= 0 ? "+" : ""}${fmtMoney(signed)}</td>
      <td><button class="row-delete" data-id="${x.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".row-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteLedgerEntry(btn.dataset.id));
  });
}

// ---------- monthly status ----------

function renderStatus() {
  const income = document.getElementById("ledger-income-month");
  const emiEl = document.getElementById("ledger-emi-month");
  const netEl = document.getElementById("ledger-net-month");

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

  const tbody = document.getElementById("status-tbody");
  tbody.innerHTML = "";
  document.getElementById("status-empty").style.display = sorted.length ? "none" : "block";

  sorted.forEach((period) => {
    const inc = store.income.filter((x) => periodOf(x.date) === period).reduce((s, x) => s + x.amount, 0);
    const emi = store.emiPayments.filter((x) => periodOf(x.date) === period).reduce((s, x) => s + x.amount, 0);
    const net = inc - emi;
    const label = new Date(period + "-01").toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${label}</td>
      <td class="num">${fmtMoney(inc)}</td>
      <td class="num">${fmtMoney(emi)}</td>
      <td class="num" style="color:${net >= 0 ? "var(--positive)" : "var(--negative)"}">${fmtMoney(net)}</td>
    `;
    tbody.appendChild(tr);
  });
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
    row.innerHTML = `
      <div>
        <div class="balance-person">${rule.name} <span class="badge ${rule.kind === "emi" ? "emi" : ""}">${rule.kind === "emi" ? "EMI" : rule.subtype}</span></div>
        <div class="balance-sub">${fmtMoney(rule.amount)} · ${rule.day === "end" ? "end" : "start"} of month · ${overdue ? "posts on next visit" : "next: " + next}</div>
      </div>
      <button class="row-delete" data-id="${rule.id}">Delete</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".row-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteRecurring(btn.dataset.id));
  });
}

function renderEmiHistory() {
  const payments = [...store.emiPayments].sort((a, b) => b.date.localeCompare(a.date));
  const tbody = document.getElementById("emi-tbody");
  tbody.innerHTML = "";
  document.getElementById("emi-empty").style.display = payments.length ? "none" : "block";

  payments.slice(0, 50).forEach((x) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${x.date}</td>
      <td>${x.name}</td>
      <td class="num">${fmtMoney(x.amount)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------- backup & transfer ----------

document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `richones-backup-${todayStr()}.json`;
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

// ---------- CSV import (historical data from other apps) ----------

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

const CSV_CATEGORY_RULES = [
  { match: /food|dining|restaurant|grocer/i, category: "Food" },
  { match: /car|fuel|petrol|diesel|transport|taxi|\buber\b|\bola\b|parking/i, category: "Transport" },
  { match: /famil|personal|shopping|cloth/i, category: "Personal" },
  { match: /health|medical|doctor|pharmac|gym|fitness/i, category: "Health" },
  { match: /utilit|bill|electric|water|internet|recharge|phone/i, category: "Utilities" },
  { match: /habit|subscription|hobby/i, category: "Habits" },
  { match: /credit card/i, category: "Credit Card" },
];

function mapCsvCategory(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "Uncategorized";
  for (const rule of CSV_CATEGORY_RULES) {
    if (rule.match.test(trimmed)) return rule.category;
  }
  return trimmed;
}

document.getElementById("csv-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let rows = parseCSV(reader.result).filter((r) => r.length >= 5 && r[0]);
    if (rows.length && isNaN(Date.parse(rows[0][0]))) rows = rows.slice(1);

    const newExpenses = [];
    const newIncome = [];
    const categoryCounts = {};
    let minDate = null, maxDate = null;

    rows.forEach((r) => {
      const d = new Date(r[0]);
      if (isNaN(d.getTime())) return;
      const dateStr = d.toISOString().slice(0, 10);
      const rawAmount = parseFloat(r[4]);
      const amount = Math.round(Math.abs(rawAmount || 0));
      if (!amount) return;
      const note = (r[6] || "").trim();

      if (!minDate || dateStr < minDate) minDate = dateStr;
      if (!maxDate || dateStr > maxDate) maxDate = dateStr;

      if (rawAmount > 0) {
        newIncome.push({ id: uid(), date: dateStr, type: "other", amount, note: note || "Imported" });
      } else {
        const category = mapCsvCategory(r[3]);
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        newExpenses.push({ id: uid(), date: dateStr, amount, category, note });
      }
    });

    if (!newExpenses.length && !newIncome.length) {
      alert("Couldn't find any valid rows in that file.");
      e.target.value = "";
      return;
    }

    const summary = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join("\n");

    const confirmed = confirm(
      `Import ${newExpenses.length} expenses and ${newIncome.length} income entries?\n` +
      `Date range: ${minDate} to ${maxDate}\n\n` +
      `Categories:\n${summary}\n\n` +
      `This adds to your existing data — it won't replace anything.`
    );
    if (!confirmed) {
      e.target.value = "";
      return;
    }

    newExpenses.forEach((x) => {
      ensureCategoryColor(x.category);
      store.expenses.push(x);
    });
    newIncome.forEach((x) => store.income.push(x));
    saveStore();
    renderAll();
    e.target.value = "";
  };
  reader.readAsText(file);
});

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
