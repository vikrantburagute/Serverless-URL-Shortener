const $ = (id) => document.getElementById(id);
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// Every value from the API is inserted with textContent, never innerHTML:
// referrers and URLs are attacker-controlled.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDay(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatTimestamp(sqlTime) {
  return new Date(`${sqlTime.replace(" ", "T")}Z`).toLocaleString();
}

function countryName(code) {
  try {
    return /^[A-Z]{2}$/.test(code) ? regionNames.of(code) : code;
  } catch {
    return code;
  }
}

// Round the axis maximum up to a clean 1 / 2 / 5 × 10ⁿ value.
function niceMax(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * magnitude).find((nice) => nice >= value);
}

function renderChart(daily) {
  const chart = $("chart");
  chart.replaceChildren();

  const max = Math.max(...daily.map((d) => d.count));
  if (max === 0) {
    chart.append(el("p", "muted", "No clicks in the last 30 days yet."));
    return;
  }
  const top = niceMax(max);

  const columns = el("div", "columns");
  const tooltip = el("div", "tooltip");
  tooltip.hidden = true;
  columns.append(el("span", "y-max", top.toLocaleString()), tooltip);

  for (const { day, count } of daily) {
    // The whole column is the hover target, so even zero-click days have one.
    const column = el("div", "column");
    const bar = el("div", "bar");
    bar.style.height = `${(count / top) * 100}%`;
    column.append(bar);

    column.addEventListener("mouseenter", () => {
      column.classList.add("active");
      tooltip.textContent = `${formatDay(day)} · ${count.toLocaleString()} click${count === 1 ? "" : "s"}`;
      tooltip.hidden = false;
      const half = tooltip.offsetWidth / 2;
      const center = column.offsetLeft + column.offsetWidth / 2;
      tooltip.style.left = `${Math.min(Math.max(center, half), columns.clientWidth - half)}px`;
      tooltip.style.top = `${columns.clientHeight - bar.offsetHeight}px`;
    });
    column.addEventListener("mouseleave", () => {
      column.classList.remove("active");
      tooltip.hidden = true;
    });
    columns.append(column);
  }

  const axis = el("div", "axis");
  const middle = daily[Math.floor(daily.length / 2)].day;
  axis.append(
    el("span", "", formatDay(daily[0].day)),
    el("span", "", formatDay(middle)),
    el("span", "", formatDay(daily.at(-1).day))
  );

  chart.append(columns, axis);

  const tableBody = $("daily-table");
  tableBody.replaceChildren(
    ...daily
      .slice()
      .reverse()
      .map(({ day, count }) => {
        const row = el("tr");
        row.append(el("td", "", formatDay(day)), el("td", "num", count.toLocaleString()));
        return row;
      })
  );
}

function renderBreakdown(containerId, rows, formatLabel = (label) => label) {
  const container = $(containerId);
  container.replaceChildren();
  if (rows.length === 0) {
    container.append(el("p", "muted", "No data yet"));
    return;
  }

  const max = Math.max(...rows.map((r) => r.count));
  for (const { label, count } of rows) {
    const name = formatLabel(label);
    const row = el("div", "bar-row");
    row.title = `${name}: ${count.toLocaleString()}`;

    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${(count / max) * 100}%`;
    track.append(fill);

    row.append(el("span", "label", name), track, el("span", "value", count.toLocaleString()));
    container.append(row);
  }
}

function renderStats(data) {
  const shortUrl = `${location.origin}/${data.code}`;
  $("short-link").href = $("short-link").textContent = shortUrl;
  $("long-url").textContent = data.url;
  $("created").textContent = formatTimestamp(data.createdAt);
  $("total").textContent = data.totalClicks.toLocaleString();

  renderChart(data.daily);
  renderBreakdown("countries", data.countries, countryName);
  renderBreakdown("referrers", data.referrers);
  renderBreakdown("devices", data.devices);
  renderBreakdown("browsers", data.browsers);
  $("stats").hidden = false;
}

function renderAdmin(links, key) {
  const tableBody = $("links-table");
  tableBody.replaceChildren();

  for (const link of links) {
    const row = el("tr");
    const codeCell = el("td");
    const codeLink = el("a", "", link.code);
    codeLink.href = `#${new URLSearchParams({ code: link.code })}`;
    codeLink.addEventListener("click", (e) => {
      e.preventDefault();
      $("code").value = link.code;
      load();
    });
    codeCell.append(codeLink);

    const urlCell = el("td", "url", link.url);
    urlCell.title = link.url;

    const deleteButton = el("button", "small danger", "Delete");
    deleteButton.type = "button";
    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Delete /${link.code} and all its click data?`)) return;
      const res = await fetch(`/api/links/${encodeURIComponent(link.code)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) row.remove();
      else $("error").textContent = (await res.json()).error;
    });
    const actionCell = el("td");
    actionCell.append(deleteButton);

    row.append(
      codeCell,
      urlCell,
      el("td", "", formatTimestamp(link.createdAt)),
      el("td", "num", link.clicks.toLocaleString()),
      actionCell
    );
    tableBody.append(row);
  }

  if (links.length === 0) {
    const row = el("tr");
    row.append(el("td", "muted", "No links yet"));
    tableBody.append(row);
  }
  $("admin").hidden = false;
}

async function load() {
  const code = $("code").value.trim();
  const key = $("key").value.trim();
  $("error").textContent = "";
  $("stats").hidden = true;
  $("admin").hidden = true;
  $("submit").disabled = true;

  try {
    const res = await fetch(code ? `/api/stats/${encodeURIComponent(code)}` : "/api/links", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong");

    if (code) {
      renderStats(data);
      // Keep per-link keys in the fragment so the page can be bookmarked;
      // the fragment is never sent to the server. The admin key is never put in the URL.
      if (!data.adminView) history.replaceState(null, "", `#${new URLSearchParams({ code, key })}`);
    } else {
      renderAdmin(data.links, key);
    }
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("submit").disabled = false;
  }
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  load();
});

const params = new URLSearchParams(location.hash.slice(1));
$("code").value = params.get("code") || "";
$("key").value = params.get("key") || "";
if ($("code").value && $("key").value) load();
