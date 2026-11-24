"use strict";

const byId = id => document.getElementById(id);
const setText = (id, value) => { byId(id).textContent = value; };
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dayMs = 24 * 60 * 60 * 1000;
const syncWarningMs = 45 * 60 * 1000;
const pageSize = 12;
const capperFields = ["v1", "g"];
const capperNames = { v1: "Outlaw", g: "Ghost" };
const resultNames = {
  positive: "Positive",
  negative: "Negative",
  flat: "Flat",
  unclassified: "Unclassified",
  inactive: "Inactive"
};

function units(value, suffix = "u") {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return sign + (Math.abs(value) / 100).toFixed(2) + suffix;
}

function signOf(value) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "flat";
}

function resultOf(value, activity) {
  if (value) return signOf(value);
  if (activity.includes(true)) return "flat";
  return activity.every(flag => flag === false) ? "inactive" : "unclassified";
}

function formatPeriod(first, last) {
  const start = shortDate.format(first);
  const end = shortDate.format(last);
  if (first.getTime() === last.getTime()) return end + ", " + last.getUTCFullYear();
  const startYear = first.getUTCFullYear() === last.getUTCFullYear() ? "" : ", " + first.getUTCFullYear();
  return start + startYear + " – " + end + ", " + last.getUTCFullYear();
}

function prepareDays(raw) {
  let year = SEASON_YEAR;
  let previousMonth = 0;
  let cumulative = 0;
  return raw.map(row => {
    const [month, day] = row.d.split("/").map(Number);
    if (month < previousMonth) year++;
    previousMonth = month;
    const date = row.date ? new Date(row.date + "T00:00:00Z") : new Date(Date.UTC(year, month - 1, day));
    const values = Object.fromEntries(capperFields.map(field => [field, Math.round(row[field] * 100)]));
    const activity = Object.fromEntries(capperFields.map(field => [
      field, values[field] !== 0 ? true : row.active?.[field]
    ]));
    const net = values.v1 + values.g;
    cumulative += net;
    return { date, values, activity, net, cumulative, result: resultOf(net, Object.values(activity)) };
  });
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function ledgerHref(filters = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return "#ledger" + (query ? "?" + query : "");
}

function countResults(results) {
  const counts = Object.fromEntries(Object.keys(resultNames).map(key => [key, 0]));
  results.forEach(result => { counts[result]++; });
  return counts;
}

function positiveRate(counts) {
  const active = counts.positive + counts.negative + counts.flat;
  const low = (100 * counts.positive / (active + counts.unclassified)).toFixed(1);
  const high = (100 * counts.positive / active).toFixed(1);
  return {
    active,
    text: !active ? "—" : low === high ? high + "%" : low + "–" + high + "%",
    provisional: counts.unclassified > 0
  };
}

function summarizePeriods(days, period) {
  const groups = new Map();
  for (const day of days) {
    const start = period === "weekly"
      ? new Date(+days[0].date + Math.floor((day.date - days[0].date) / (7 * dayMs)) * 7 * dayMs)
      : new Date(Date.UTC(day.date.getUTCFullYear(), day.date.getUTCMonth(), 1));
    const key = +start;
    const group = groups.get(key) ?? { key, date: start, first: day.date, last: day.date, value: 0 };
    group.last = day.date;
    group.value += day.net;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    label: period === "monthly"
      ? monthName.format(group.date) + " " + group.date.getUTCFullYear()
      : formatPeriod(group.first, group.last)
  }));
}

function findExtremes(days) {
  let peak = { cumulative: 0, date: null };
  let drawdown = { value: 0, date: null };
  let longest = 0;
  let streak = 0;
  let previousDate = null;
  for (const day of days) {
    if (day.cumulative > peak.cumulative) peak = day;
    const decline = peak.cumulative - day.cumulative;
    if (decline > drawdown.value) drawdown = { value: decline, date: day.date };
    if (day.result === "positive") {
      streak = day.date - previousDate === dayMs ? streak + 1 : 1;
      longest = Math.max(longest, streak);
    } else {
      streak = 0;
    }
    previousDate = day.date;
  }
  return { peak, drawdown, longest };
}

function renderSummary(days, months, extremes) {
  const { peak, drawdown, longest } = extremes;
  const total = days.at(-1).cumulative;
  const best = months.reduce((top, month) => month.value > top.value ? month : top);
  const counts = countResults(days.map(day => day.result));
  const rate = positiveRate(counts);
  const period = formatPeriod(days[0].date, days.at(-1).date);

  setText("season-period", period);
  setText("results-through", fullDate.format(days.at(-1).date));
  setText("ledger-period", period + " · Newest first");
  const hero = byId("hero-net");
  hero.classList.add(signOf(total));
  hero.textContent = units(total, "");
  const suffix = document.createElement("small");
  suffix.textContent = "u";
  hero.append(suffix);
  hero.setAttribute("aria-label", units(total, " units"));

  setText("peak", units(peak.cumulative));
  setText("peak-date", peak.date ? shortDate.format(peak.date) : "Season start");
  setText("drawdown", units(-drawdown.value));
  setText("drawdown-date", drawdown.date ? shortDate.format(drawdown.date) : "No decline");
  setText("best-month", units(best.value));
  setText("best-month-date", monthName.format(best.date));
  setText("logged-days", days.length);
  byId("date-count").hidden = false;
  setText("day-scope", "Combined daily results");
  setText("positive-range", rate.text);
  setText("positive-detail", rate.provisional
    ? "Provisional · " + counts.unclassified + " unclassified dates"
    : counts.positive + " of " + rate.active + " active days");
  setText("positive-streak", longest + (longest === 1 ? " day" : " days"));
  setText("method-data", rate.provisional
    ? "The published ledger gives daily net units. On " + counts.unclassified + " dates, both cappers show zero with no activity status. The range counts all of those dates as active at the low end and excludes all of them at the high end. The master ledger is needed for a single verified percentage."
    : "The published ledger records " + rate.active + " active dates for this period. Positive Days % is based on daily net units.");

  for (const [result, count] of Object.entries(counts)) {
    if (result === "inactive" && count === 0) continue;
    if (count) {
      const segment = document.createElement("span");
      segment.className = result;
      segment.style.flexGrow = count;
      byId("day-band").append(segment);
    }
    const row = document.createElement("div");
    row.innerHTML = `<dt><i class="key-dot ${result}" aria-hidden="true"></i>${resultNames[result]}</dt><dd>${count}</dd>`;
    byId("day-split").append(row);
  }
}

function renderRecent(days) {
  byId("recent-grid").innerHTML = days.slice(-4).reverse().map(day => `
    <a class="recent-result" href="${ledgerHref({ date: dateKey(day.date) })}">
      <time datetime="${dateKey(day.date)}">${shortDate.format(day.date)}</time>
      <strong class="${day.result}">${units(day.net)}</strong>
      <span>${resultNames[day.result]}</span>
    </a>`).join("");
}

function svgNode(parent, tag, attributes, label) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (label !== undefined) node.textContent = label;
  parent.append(node);
  return node;
}

function pointsPath(points) {
  return points.map(({ x, y }, i) => (i === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2)).join(" ");
}

function chartStep(value) {
  const power = 10 ** Math.floor(Math.log10(Math.max(100, value)));
  return [1, 2, 2.5, 5, 10].find(step => step * power >= value) * power;
}

function setUpChart(days, weeks, months, extremes) {
  const frame = byId("chart-frame");
  const svg = byId("performance-chart");
  const readout = byId("chart-readout");
  const ledgerLink = byId("chart-ledger-link");
  const buttons = [...document.querySelectorAll("[data-view]")];
  const season = days.map(day => ({ date: day.date, label: shortDate.format(day.date), value: day.cumulative, net: day.net }));
  const views = {
    season: { name: "Cumulative", details: "Running total", series: season },
    weekly: { name: "Weekly", details: "Net per 7-day period", series: weeks },
    monthly: { name: "Monthly", details: "Net per calendar month", series: months }
  };
  let view = "season";
  let selected = null;
  let chart = null;

  function renderSelection() {
    if (!chart) return;
    chart.overlay.replaceChildren();
    svg.querySelector(".bar.selected")?.classList.remove("selected");
    const current = views[view].series[selected ?? views[view].series.length - 1];
    readout.replaceChildren(document.createTextNode(current.label));
    const value = document.createElement("strong");
    value.className = signOf(current.value);
    value.textContent = units(current.value);
    readout.append(value);
    const filters = view === "season" ? { date: dateKey(current.date) }
      : view === "monthly" ? { month: dateKey(current.date).slice(0, 7) }
      : { from: dateKey(current.first), to: dateKey(current.last) };
    ledgerLink.href = ledgerHref(filters);
    ledgerLink.firstChild.textContent = view === "season" ? "View date " : view === "monthly" ? "View month " : "View week ";
    if (selected === null) return;
    const point = chart.points[selected];
    svgNode(chart.overlay, "line", { x1: point.x, x2: point.x, y1: chart.top, y2: chart.bottom, class: "chart-selection" });
    if (view === "season") {
      const net = document.createElement("span");
      net.textContent = " · Day " + units(current.net);
      readout.append(net);
      svgNode(chart.overlay, "circle", { cx: point.x, cy: point.y, r: 5, fill: "var(--gold)", class: "chart-marker" });
    } else {
      chart.bars[selected].classList.add("selected");
    }
  }

  function draw() {
    const width = Math.round(frame.clientWidth);
    const height = Math.round(frame.clientHeight);
    if (!width || !height) return;
    const { series, details, name } = views[view];
    const area = view === "season";
    const top = 13;
    const bottom = height - 25;
    const left = width < 500 ? 38 : 45;
    const right = width - (area ? 16 : 6);
    const values = series.map(entry => entry.value);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const step = chartStep(Math.max(100, max - min) / 5);
    const low = Math.floor(min / step) * step;
    const high = Math.ceil(max / step) * step || step;
    const y = value => bottom - (value - low) / (high - low) * (bottom - top);
    const base = y(0);
    const bin = (right - left) / series.length;
    const startDate = +series[0].date - dayMs;
    const duration = +series.at(-1).date - startDate;
    const x = (entry, i) => area
      ? left + (+entry.date - startDate) / duration * (right - left)
      : left + (i + 0.5) * bin;
    const points = series.map((entry, i) => ({ x: x(entry, i), y: y(entry.value) }));
    const bars = [];

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();
    frame.setAttribute("aria-label", name + " performance chart");
    byId("chart-description").innerHTML = `<i class="key-line"></i> ${details} <small>· units</small>`;

    for (let tick = low; tick <= high; tick += step) {
      const row = y(tick);
      svgNode(svg, "line", { x1: left, x2: right, y1: row, y2: row, class: tick === 0 ? "chart-grid chart-zero" : "chart-grid" });
      svgNode(svg, "text", { x: left - 8, y: row + 4, class: "axis-label", "text-anchor": "end" }, tick / 100);
    }

    if (area) {
      const gradient = svgNode(svgNode(svg, "defs", {}), "linearGradient", { id: "chart-fill", x1: 0, x2: 0, y1: 0, y2: 1 });
      svgNode(gradient, "stop", { offset: "0%", "stop-color": "#ad7dd5", "stop-opacity": ".32" });
      svgNode(gradient, "stop", { offset: "100%", "stop-color": "#6d458d", "stop-opacity": ".03" });
      const line = pointsPath([{ x: left, y: base }, ...points]);
      svgNode(svg, "path", { d: line + ` L${right},${base} L${left},${base} Z`, fill: "url(#chart-fill)" });
      svgNode(svg, "path", { d: line, class: "chart-curve" });
      const end = points.at(-1);
      svgNode(svg, "circle", { cx: end.x, cy: end.y, r: 4.4, fill: "var(--gold)", class: "chart-marker" });
      for (const [date, color] of [[extremes.peak.date, "var(--gold)"], [extremes.drawdown.date, "var(--purple)"]]) {
        const i = days.findIndex(day => day.date === date);
        if (i < 0 || i === points.length - 1) continue;
        svgNode(svg, "circle", { cx: points[i].x, cy: points[i].y, r: 3.5, fill: "var(--panel)", stroke: color, "stroke-width": 1.5 });
      }
    } else {
      const barWidth = Math.min(45, bin * 0.58);
      points.forEach((point, i) => {
        bars.push(svgNode(svg, "rect", {
          x: point.x - barWidth / 2, y: Math.min(point.y, base), width: barWidth,
          height: Math.max(2, Math.abs(point.y - base)), rx: Math.min(3, barWidth / 4),
          class: "bar " + signOf(values[i])
        }));
      });
    }

    const labels = area
      ? series.flatMap((entry, i) => i === 0 || entry.date.getUTCMonth() !== series[i - 1].date.getUTCMonth() ? [i] : [])
      : series.map((_, i) => i);
    const interval = Math.max(1, Math.ceil(labels.length / (width < 500 ? 6 : 10)));
    const monthShort = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
    labels.filter((_, i) => i % interval === 0).forEach(i => {
      const label = view === "weekly" ? shortDate.format(series[i].date) : monthShort.format(series[i].date);
      svgNode(svg, "text", { x: points[i].x, y: height - 5, class: "axis-label", "text-anchor": "middle" }, label);
    });

    chart = { points, top, bottom, bars, overlay: svgNode(svg, "g", { "pointer-events": "none" }) };
    renderSelection();
  }

  function selectAt(event) {
    if (!chart) return;
    const target = event.clientX - frame.getBoundingClientRect().left;
    const closest = chart.points.reduce((best, point, i) =>
      Math.abs(point.x - target) < Math.abs(chart.points[best].x - target) ? i : best, 0);
    if (closest === selected) return;
    selected = closest;
    renderSelection();
  }

  buttons.forEach((button, index) => button.addEventListener("click", () => {
    if (view === button.dataset.view) return;
    view = button.dataset.view;
    selected = null;
    buttons.forEach(option => option.setAttribute("aria-pressed", String(option === button)));
    button.parentElement.dataset.selected = index;
    draw();
  }));
  frame.addEventListener("pointermove", event => { if (event.pointerType !== "touch") selectAt(event); });
  frame.addEventListener("pointerup", event => { if (event.pointerType === "touch") selectAt(event); });
  frame.addEventListener("keydown", event => {
    const last = views[view].series.length - 1;
    const current = selected ?? last;
    switch (event.key) {
      case "ArrowLeft": selected = Math.max(0, current - 1); break;
      case "ArrowRight": selected = Math.min(last, current + 1); break;
      case "Home": selected = 0; break;
      case "End": selected = last; break;
      case "Escape": selected = null; break;
      case "Enter": ledgerLink.click(); break;
      default: return;
    }
    event.preventDefault();
    renderSelection();
  });
  draw();
  new ResizeObserver(draw).observe(frame);
}

function renderCappers(days) {
  const cappers = [
    { name: "Outlaw", field: "v1", id: "outlaw" },
    { name: "Ghost", field: "g", id: "ghost" }
  ];
  const series = cappers.flatMap(capper => {
    const { field } = capper;
    const first = days.findIndex(day => day.activity[field] === true);
    if (first === -1) return [];
    const tracked = days.slice(first);
    let total = 0;
    const curve = tracked.map(day => {
      total += day.values[field];
      return total;
    });
    const daily = tracked.filter(day => day.activity[field] === true).map(day => day.values[field]);
    const counts = countResults(tracked.map(day => resultOf(day.values[field], [day.activity[field]])));
    return [{ ...capper, tracked, curve, daily, counts, total }];
  });
  byId("empty-cappers").hidden = series.length > 0;
  byId("roster-list").innerHTML = series.map(({ name, id, total, tracked }) => `
    <a href="#cappers" class="roster-result">
      <img src="assets/${id}.webp" width="42" height="42" alt="">
      <span><strong>${name}</strong><small>Since ${shortDate.format(tracked[0].date)}</small></span>
      <svg class="roster-spark ${id}" id="roster-spark-${id}" viewBox="0 0 460 50" preserveAspectRatio="none" aria-hidden="true"></svg>
      <b class="${signOf(total)}">${units(total)}</b>
    </a>`).join("");
  const allValues = series.flatMap(capper => capper.curve);
  const low = Math.min(0, ...allValues);
  const high = Math.max(0, ...allValues);
  const scale = high - low || 1;
  const start = +days[0].date - dayMs;
  const duration = +days.at(-1).date - start;
  for (const { name, id, tracked, curve, daily, counts, total } of series) {
    const rate = positiveRate(counts);
    const card = document.createElement("article");
    card.className = "panel capper " + id;
    card.innerHTML = `
      <div class="capper-profile">
        <img src="assets/${id}.webp" width="520" height="520" loading="lazy" alt="">
        <div class="period-label">Tracking since ${shortDate.format(tracked[0].date)}</div>
        <h3>${name}</h3>
        <p class="figure">${units(total)}</p><p class="eyebrow">Net units</p>
      </div>
      <svg class="capper-spark" viewBox="0 0 460 50" preserveAspectRatio="none" aria-hidden="true"></svg>
      <dl class="capper-stats">
        <div><dt>Positive days</dt><dd>${counts.positive}</dd></div>
        <div><dt>Negative days</dt><dd>${counts.negative}</dd></div>
        <div><dt>Best day</dt><dd class="${signOf(Math.max(...daily))}">${units(Math.max(...daily))}</dd></div>
        <div><dt>Worst day</dt><dd class="${signOf(Math.min(...daily))}">${units(Math.min(...daily))}</dd></div>
        <div><dt>Positive days %</dt><dd>${rate.text}${rate.provisional ? '<span class="sr-only"> provisional</span>' : ""}</dd></div>
      </dl>`;
    const firstDate = +tracked[0].date - dayMs;
    const points = [0, ...curve].map((value, i) => ({
      x: ((i === 0 ? firstDate : +tracked[i - 1].date) - start) * 460 / duration,
      y: 46 - (value - low) * 42 / scale
    }));
    const svg = card.querySelector("svg");
    const zero = 46 + low * 42 / scale;
    svgNode(svg, "line", { x1: 0, x2: 460, y1: zero, y2: zero, class: "chart-grid" });
    const path = pointsPath(points);
    svgNode(svg, "path", { d: path });
    svgNode(byId("roster-spark-" + id), "path", { d: path });
    byId("capper-grid").append(card);
  }
}

function setUpLedger(days, months) {
  const monthFilter = byId("month-filter");
  const resultFilter = byId("result-filter");
  const previous = byId("previous-page");
  const next = byId("next-page");
  const clear = byId("clear-filters");
  const newestFirst = days.slice().reverse();
  let page = 0;
  let period = {};

  for (const month of months.slice().reverse()) {
    monthFilter.add(new Option(month.label, dateKey(month.date).slice(0, 7)));
  }
  if (days.some(day => day.result === "inactive")) resultFilter.add(new Option("Inactive", "inactive"));

  function formatCapper(day, field, detail = false) {
    const value = day.values[field];
    if (day.activity[field] === false) return detail ? "No plays" : "—";
    return units(value) + (detail && day.activity[field] !== true ? " · Activity unconfirmed" : "");
  }

  function draw() {
    const month = monthFilter.value;
    const result = resultFilter.value;
    const filtered = newestFirst.filter(day => {
      const key = dateKey(day.date);
      return (!month || key.startsWith(month)) && (!result || day.result === result)
        && (!period.date || key === period.date) && (!period.from || key >= period.from)
        && (!period.to || key <= period.to);
    });
    const totalPages = Math.ceil(filtered.length / pageSize);
    const start = page * pageSize;
    const visible = filtered.slice(start, start + pageSize);
    byId("ledger-body").innerHTML = visible.length ? visible.map(day => {
      const key = dateKey(day.date);
      return '<tr><th scope="row"><a class="ledger-date" href="' + ledgerHref({ date: key }) + '">'
        + shortDate.format(day.date) + '</a></th><td class="' + day.result + '">' + resultNames[day.result]
        + '</td><td class="numeric capper-column">' + formatCapper(day, "v1")
        + '</td><td class="numeric capper-column">' + formatCapper(day, "g")
        + '</td><td class="numeric ' + signOf(day.net) + '">' + units(day.net)
        + '</td><td class="numeric">' + units(day.cumulative) + '</td></tr>';
    }).join("") : '<tr><td colspan="6"><p>' + (days.length ? "No dates match these filters." : "No results have been published for this period.") + '</p></td></tr>';

    const selection = byId("ledger-selection");
    const day = period.date && filtered[0];
    selection.hidden = !day && !period.from;
    if (day) {
      selection.innerHTML = '<div><strong>' + shortDate.format(day.date) + '</strong><span>Capper breakdown</span></div>'
        + capperFields.map(field => '<div><span>' + capperNames[field]
          + '</span><strong>' + formatCapper(day, field, true) + '</strong></div>').join("");
    } else if (period.from) {
      const from = new Date(period.from + "T00:00:00Z");
      const to = new Date(period.to + "T00:00:00Z");
      selection.textContent = "Week of " + formatPeriod(from, to);
    } else {
      selection.replaceChildren();
    }

    setText("ledger-count", !visible.length ? "0 dates" : filtered.length === 1 ? "1 date"
      : (start + 1) + "–" + (start + visible.length) + " of " + filtered.length + " dates");
    previous.disabled = page === 0;
    next.disabled = page >= totalPages - 1;
    byId("ledger-pages").hidden = totalPages < 2;
    setText("page-label", (page + 1) + " / " + totalPages);
    clear.hidden = !month && !result && !period.date && !period.from;
  }

  function applyRoute(params) {
    const date = params.get("date");
    const from = params.get("from");
    const to = params.get("to");
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && !Number.isNaN(Date.parse(value));
    period = validDate(date) ? { date } : validDate(from) && validDate(to) && from <= to ? { from, to } : {};
    monthFilter.value = params.get("month") ?? "";
    resultFilter.value = params.get("result") ?? "";
    page = 0;
    draw();
  }

  [monthFilter, resultFilter].forEach(control => control.addEventListener("change", () => {
    period = {};
    history.replaceState(null, "", ledgerHref({ month: monthFilter.value, result: resultFilter.value }));
    page = 0;
    draw();
  }));
  clear.addEventListener("click", () => {
    history.replaceState(null, "", ledgerHref());
    applyRoute(new URLSearchParams());
    monthFilter.focus();
  });
  previous.addEventListener("click", () => {
    page--;
    draw();
    if (previous.disabled) next.focus();
  });
  next.addEventListener("click", () => {
    page++;
    draw();
    if (next.disabled) previous.focus();
  });
  return applyRoute;
}

function setUpCalculator(total) {
  const input = byId("stake-input");
  const buttons = [...document.querySelectorAll("[data-stake]")];
  function update(stake, preset, detail) {
    buttons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.stake) === preset)));
    const result = byId("calc-result");
    const valid = Number.isFinite(stake) && stake >= 0 && Number.isFinite(total / 100 * stake);
    result.textContent = valid ? money.format(total / 100 * stake) : "—";
    result.className = "figure " + (valid ? signOf(total * stake) : "");
    setText("calc-detail", valid ? units(total) + " × " + money.format(stake) + " per unit" : detail);
  }
  for (const button of buttons) {
    button.addEventListener("click", () => {
      input.value = "";
      const preset = Number(button.dataset.stake);
      update(preset, preset);
    });
  }
  input.addEventListener("input", () => {
    const detail = input.validity.badInput || input.validity.rangeUnderflow
      ? "Enter an amount of $0 or more."
      : input.value ? "Enter a smaller amount." : "Enter a unit size or choose a preset.";
    update(input.valueAsNumber, null, detail);
  });
  update(25, 25);
}

function setUpNavigation(applyLedgerRoute) {
  const pages = [...document.querySelectorAll(".dashboard-page")];
  const nav = document.querySelector(".glass-nav");
  const links = [...nav.querySelectorAll("[data-page]")];
  let currentPage;

  function applyRoute(focus = false) {
    const [fragment, query] = location.hash.slice(1).split("?", 2);
    const selected = pages.find(page => page.id === fragment) ?? pages[0];
    if (selected.id === "ledger") applyLedgerRoute(new URLSearchParams(query));
    pages.forEach(page => { page.hidden = page !== selected; });
    links.forEach(link => {
      if (link.dataset.page === selected.id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    nav.dataset.selected = pages.indexOf(selected);
    const heading = selected.querySelector("h1");
    document.title = "PWR YTD Tracker | " + heading.textContent;
    if (currentPage !== selected.id || selected.id === "ledger") {
      window.scrollTo(0, 0);
      if (focus) heading.focus({ preventScroll: true });
    }
    currentPage = selected.id;
  }

  document.querySelector(".skip").addEventListener("click", event => {
    event.preventDefault();
    byId("main").focus();
  });
  window.addEventListener("hashchange", () => applyRoute(true));
  applyRoute();
}

function setUpShare() {
  const button = byId("copy-link");
  const status = byId("copy-status");
  button.addEventListener("click", async () => {
    const url = new URL(location.href);
    if (!url.hash.startsWith("#ledger")) url.hash = "ledger";
    try {
      await navigator.clipboard.writeText(url.href);
      status.textContent = "View link copied.";
    } catch {
      status.textContent = "Copy the view link from your address bar.";
    }
    status.classList.remove("sr-only");
  });
  window.addEventListener("hashchange", () => {
    status.classList.add("sr-only");
    status.textContent = "";
  });
}

function renderSource() {
  const source = typeof TRACKER_SOURCE === "undefined" ? null : TRACKER_SOURCE;
  const badge = byId("source-badge");
  const note = byId("sync-note");
  const scheduled = source?.refreshMode === "scheduled";
  const syncedAt = Date.parse(source?.syncedAt ?? "");
  const hasSyncTime = Number.isFinite(syncedAt) && syncedAt <= Date.now() + 5 * 60 * 1000;

  if (scheduled && hasSyncTime) {
    const warningAt = syncedAt + syncWarningMs;
    const updateHealth = () => {
      const remaining = warningAt - Date.now();
      const delayed = remaining <= 0;
      badge.dataset.health = delayed ? "delayed" : "fresh";
      setText("source-label", delayed ? "Results may be stale" : "Sync up to date");
      note.hidden = !delayed;
      if (!delayed) window.setTimeout(updateHealth, remaining);
    };
    updateHealth();
  } else if (scheduled || !source) {
    badge.dataset.health = "unknown";
    setText("source-label", source ? "Sync status unavailable" : "Data unavailable");
  } else {
    setText("source-label", source.syncedAt ? "Sheet import" : source.label);
  }

  if (hasSyncTime) {
    const timestamp = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York"
    });
    if (!scheduled) setText("sync-time-label", "Last imported");
    setText("sync-status", timestamp.format(syncedAt) + " ET");
  } else {
    setText("sync-status", scheduled || !source || source.syncedAt ? "Unavailable" : "Published snapshot");
  }

  if (source?.pendingDates?.length) {
    const pending = source.pendingDates.map(date => shortDate.format(new Date(date + "T00:00:00Z")));
    const preview = pending.slice(0, 3).join(", ");
    setText("pending-status", "Awaiting capper entries · " + preview
      + (pending.length > 3 ? " and " + (pending.length - 3) + " more" : ""));
    byId("pending-status").hidden = false;
  }
}

const days = typeof RAW === "undefined" ? [] : prepareDays(RAW);
const months = summarizePeriods(days, "monthly");
if (days.length) {
  const extremes = findExtremes(days);
  renderSummary(days, months, extremes);
  renderRecent(days);
  setUpChart(days, summarizePeriods(days, "weekly"), months, extremes);
  renderCappers(days);
  setUpCalculator(days.at(-1).cumulative);
} else {
  byId("overview-data").hidden = true;
  byId("empty-season").hidden = false;
  byId("empty-cappers").hidden = false;
  byId("stake-input").disabled = true;
  document.querySelectorAll("[data-stake]").forEach(button => { button.disabled = true; });
  setText("calc-detail", "Historical results are needed to calculate net units.");
}
renderSource();
setUpNavigation(setUpLedger(days, months));
setUpShare();
