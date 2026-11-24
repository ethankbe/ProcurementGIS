/**
 * Procurement Price Monitoring System
 * Handles Map UI, PhilGEPS API fetching, and filtering logic.
 */

// --- Utility Functions ---
const $ = id => document.getElementById(id);

const esc = s => String(s ?? "").replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])
);

const peso = n => {
    if (n == null) return "n/a";
    const d = Math.abs(n) < 100 ? 2 : 0;
    return "PHP " + Number(n).toLocaleString("en-PH", {minimumFractionDigits: d, maximumFractionDigits: d});
};

const num = n => n == null ? "n/a" : Number(n).toLocaleString("en-PH", {maximumFractionDigits: 2});

const formatDate = dateStr => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return isNaN(d) ? dateStr : d.toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"});
};

// Blank award notices are loaded with an internal key like 50720:NO-AWARD-NO-1.
// Those rows are still awarded; they simply have no notice number to link to.
const isUnnumberedAward = id =>
    typeof id === "string" && id.includes(":NO-AWARD-NO-");

const bidRefBadge = (ref, title = "Bid Reference Number") =>
    `<span class="ref ref-bid" title="${esc(title)}">Bid ${esc(ref ?? "—")}</span>`;

const refBadge = (ref, awardId) => {
    if (!awardId || isUnnumberedAward(awardId)) {
        return bidRefBadge(ref, isUnnumberedAward(awardId)
            ? "Award notice number not in source; showing the bid reference number"
            : "Bid Reference Number");
    }
    return bidRefBadge(ref) +
        `<a href="https://philgeps.gov.ph/Indexes/viewAwardNotice/${esc(awardId)}" ` +
        `target="_blank" rel="noopener noreferrer" class="ref-link" ` +
        `title="Open award notice ${esc(awardId)}">` +
        `<span class="ref ref-award">Award ${esc(awardId)} ↗</span></a>`;
};

const supplierLine = awardee => awardee
    ? `<div class="cmp-supplier"><strong>Supplier:</strong> ${esc(awardee)}</div>`
    : "";

const itemSubLabel = l => l.item_secondary ??
    (l.item_name && l.item_name !== l.item ? l.item_name : null);

const lotRange = p => {
    if (!p.n_lots || p.lot_min == null) return "n/a";
    return p.lot_min === p.lot_max
        ? peso(p.lot_min)
        : `${peso(p.lot_min)} – ${peso(p.lot_max)}`;
};

const sumRef = e => {
    const bid = `Bid ${esc(e.bid_ref || "—")}`;
    return !e.award_id || isUnnumberedAward(e.award_id)
        ? bid
        : `${bid} · Award ${esc(e.award_id)}`;
};

const sumWhere = e => [e.region || "Unspecified region", e.entity]
    .filter(Boolean).map(esc).join(" · ");

const sumCard = (e, kind, label, compact = false, priceKey = "unit_budget") => {
    if (!e) return "";
    const sub = itemSubLabel(e);
    const titleBits = [e.item, sub, e.entity, e.address, e.region, e.awardee]
        .filter(Boolean).join(" · ");
    return `<button type="button" class="sum-card ${kind}${compact ? " compact" : ""}" ` +
           `${e.address_id != null ? `data-id="${esc(e.address_id)}"` : ""} ` +
           `title="Focus on the map — ${esc(titleBits)}">` +
           `<span class="sum-label">${esc(label)}</span>` +
           `<strong class="sum-price">${peso(e[priceKey])}</strong>` +
           `<span class="sum-item">${esc(e.item || "Item")}</span>` +
           (sub ? `<span class="sum-sub">${esc(sub)}</span>` : "") +
           `<span class="sum-meta">${sumWhere(e)}</span>` +
           `<span class="sum-ref">${sumRef(e)} · ${num(e.quantity)} ${esc(e.uom || "")}</span>` +
           `</button>`;
};

function renderSummary(summary) {
    const el = $("summary");
    if (!el) return;

    // Older cached API responses used a flat shape; keep them readable too.
    const flat = summary && summary.national
        ? {per_item: {available: summary.available || 0, national: summary.national,
                      regions: summary.regions || []},
           whole_lot: {available: 0, national: null, regions: []}}
        : null;
    const data = flat || {
        per_item: (summary && summary.per_item) || {available: 0, national: null, regions: []},
        whole_lot: (summary && summary.whole_lot) || {available: 0, national: null, regions: []},
    };

    const groups = [
        {key: "per_item", title: "National per item", regionTitle: "Per item by region",
         low: "Least per item", high: "Most per item", median: "Median per item",
         field: "unit_budget", open: true},
        {key: "whole_lot", title: "National whole lots", regionTitle: "Whole lots by region",
         low: "Smallest lot", high: "Largest lot", median: "Median lot",
         field: "item_budget", open: false},
    ];

    if (!groups.some(g => data[g.key].available)) {
        el.hidden = false;
        el.innerHTML = `<div class="sum-head">` +
            `<span class="status-kicker">Price extremes</span>` +
            `<span class="sum-count">Nothing to rank</span></div>` +
            `<p class="sum-empty">No budget values in this search can be ranked as prices.</p>`;
        return;
    }

    const nationalBlock = (g, d) => !d.national ? "" :
        `<details class="sum-block" ${g.open ? "open" : ""}>` +
          `<summary><span class="sum-caret" aria-hidden="true">${g.open ? "▾" : "▸"}</span>` +
            `<span class="sum-block-title">${esc(g.title)}</span>` +
            `<span class="sum-badge">all regions</span></summary>` +
          `<div class="sum-body">` +
            sumCard(d.national.lowest, "low", g.low, false, g.field) +
            sumCard(d.national.highest, "high", g.high, false, g.field) +
            (d.national.median != null
                ? `<div class="sum-median">${esc(g.median)} <strong>${peso(d.national.median)}</strong></div>`
                : "") +
          `</div>` +
        `</details>`;

    const regionBlock = (g, d) => !(d.regions || []).length ? "" :
        `<details class="sum-block">` +
          `<summary><span class="sum-caret" aria-hidden="true">▸</span>` +
            `<span class="sum-block-title">${esc(g.regionTitle)}</span>` +
            `<span class="sum-badge">${d.regions.length} region${d.regions.length === 1 ? "" : "s"}</span></summary>` +
          `<div class="sum-body">` +
            d.regions.map(rg => `<div class="sum-region">` +
              `<div class="sum-region-head"><b>${esc(rg.region)}</b>` +
                `<span title="${esc(g.median)}">${num(rg.count)} · ${peso(rg.median)}</span></div>` +
              sumCard(rg.lowest, "low", "Least", true, g.field) +
              sumCard(rg.highest, "high", "Most", true, g.field) +
              `</div>`).join("") +
          `</div>` +
        `</details>`;

    const nItems = data.per_item.available || 0;
    const nLots = data.whole_lot.available || 0;
    const countText = nItems && nLots
        ? `${num(nItems)} per-item · ${num(nLots)} lot`
        : nItems ? `${num(nItems)} comparable lines` : `${num(nLots)} whole-lot lines`;

    el.hidden = false;
    el.innerHTML =
        `<div class="sum-head"><span class="status-kicker">Price extremes</span>` +
        `<span class="sum-count">${countText}</span></div>` +
        groups.map(g => nationalBlock(g, data[g.key]) + regionBlock(g, data[g.key])).join("") +
        `<div class="sum-note">Per-item estimates and whole-lot budgets are ranked separately; ` +
        `whole-lot values are not unit prices.</div>`;
}

function clearSummary() {
    const el = $("summary");
    if (el) { el.hidden = true; el.innerHTML = ""; }
}

const itemPriceRows = p => {
    if (!p.n_comparable) {
        return `<dt>Whole lot budget</dt><dd>${lotRange(p)}</dd>`;
    }
    const units = p.min_unit === p.max_unit
        ? `<dt>Budget/item (est.)</dt><dd>${peso(p.min_unit)}</dd>`
        : `<dt>Budget/item (est.)</dt><dd>${peso(p.min_unit)} to ${peso(p.max_unit)}</dd>` +
          `<dt>Median (est.)</dt><dd>${peso(p.median_unit)}</dd>`;
    return units + (p.n_lots ? `<dt>Lot totals</dt><dd>${lotRange(p)}</dd>` : "");
};

const itemPriceLines = p => {
    let out = "";
    if (p.n_comparable) {
        const range = p.min_unit === p.max_unit
            ? peso(p.min_unit)
            : `${peso(p.min_unit)} – ${peso(p.max_unit)}`;
        const median = p.min_unit !== p.max_unit && p.median_unit != null
            ? ` · median ${peso(p.median_unit)}`
            : "";
        out += `<span class="meta meta-price"><span class="meta-label">Budget/item (est.)</span> ${range}${median}</span>`;
    }
    if (p.n_lots) {
        out += `<span class="meta meta-price"><span class="meta-label">Total lot budget</span> ${lotRange(p)}</span>`;
    }
    return out;
};

const priceTag = (kind, text) => `<span class="price-tag tag-${kind}">${text}</span>`;

const linePrice = l => l.comparable
    ? peso(l.unit_budget) + priceTag("unit", "per item est.")
    : (l.item_budget != null
        ? peso(l.item_budget) + priceTag("lot", "whole lot")
        : "n/a" + priceTag("lot", "no price"));

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;


// --- Theme toggle ---
const themeBtn = $("themeToggle");
const THEME_ICONS = {
    dark: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>`,
    light: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.9 4.9 1.4 1.4"></path><path d="m17.7 17.7 1.4 1.4"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m4.9 19.1 1.4-1.4"></path><path d="m17.7 6.3 1.4-1.4"></path></svg>`
};

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (!themeBtn) return;
    themeBtn.innerHTML = THEME_ICONS[theme];
    themeBtn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    themeBtn.setAttribute("aria-label", themeBtn.title);
    themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
}

applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

if (themeBtn) {
    themeBtn.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(next);
        try { localStorage.setItem("procurement-theme", next); } catch (e) {}
    });
}


// --- Map Initialization & Styling ---
const BASE = {
    radius: 10,
    color: "#ffffff",
    weight: 1.5,
    fillColor: "#3b82f6",
    fillOpacity: 0.75
};

const ACTIVE = {
    radius: 13,
    color: "#ffffff",
    weight: 2,
    fillColor: "#f59e0b", // Amber/Orange so it never clashes with green or red price tags
    fillOpacity: 1
};

// Initialize map centered on the Philippines
const map = L.map("map").setView([12.8797, 121.7740], 10); 

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, 
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let layer = null, markers = {}, props = {}, selected = [], fitNext = true, lastMode = "", timer = null;


// --- Core Rendering Logic ---
function render(data, popupFn, onOpen, rowFn, sortFn) {
    if (layer) layer.remove();
    markers = {}; props = {};
    
    // Find the global lowest min_unit and highest max_unit across all matching locations
    let globalMin = Infinity, globalMax = -Infinity;
    if ($("item").value.trim()) {
        data.features.forEach(f => {
            const p = f.properties;
            if (p.min_unit != null && p.min_unit > 0 && p.min_unit < globalMin) {
                globalMin = p.min_unit;
            }
            if (p.max_unit != null && p.max_unit > 0 && p.max_unit > globalMax) {
                globalMax = p.max_unit;
            }
        });
    }

    // Create GeoJSON layer with item-level pricing colors
    layer = L.geoJSON(data, {
        pointToLayer: (f, ll) => {
            const p = f.properties;
            let markerStyle = { ...BASE };
            
            if ($("item").value.trim() && globalMin !== globalMax) {
                // If this location's lowest item matches the global minimum -> Green
                if (p.min_unit != null && p.min_unit === globalMin) {
                    markerStyle.fillColor = "#16a34a"; 
                } 
                // If this location's highest item matches the global maximum -> Red
                else if (p.max_unit != null && p.max_unit === globalMax) {
                    markerStyle.fillColor = "#dc2626"; 
                }
            }
            return L.circleMarker(ll, markerStyle);
        },
        onEachFeature: (f, l) => {
            const p = f.properties;
            markers[p.id] = l; 
            props[p.id] = p;
            l.bindPopup(popupFn(p), {minWidth: 260, maxWidth: 340});
            l.on("popupopen", () => {
                l.setStyle(ACTIVE);
                onOpen(p, l);
            });
            l.on("popupclose", () => {
                let resetColor = BASE.fillColor;
                if ($("item").value.trim() && globalMin !== globalMax) {
                    if (p.min_unit != null && p.min_unit === globalMin) resetColor = "#16a34a";
                    else if (p.max_unit != null && p.max_unit === globalMax) resetColor = "#dc2626";
                }
                l.setStyle({ ...BASE, fillColor: resetColor });
            });
        }
    }).addTo(map);

    // Update the right sidebar list
    const rows = data.features.map(f => f.properties).sort(sortFn);
    $("list").innerHTML = rows.map(rowFn).join("");
    
    markCompare();
    
    // Adjust map bounds to fit new data
    if (fitNext && rows.length) {
        fitNext = false;
        map.fitBounds(layer.getBounds().pad(.2), {maxZoom: 15});
    }
}

function focusLoc(id) {
    const m = markers[id];
    if (!m) return;
    const z = Math.max(map.getZoom(), 14);
    if (reduce) map.setView(m.getLatLng(), z); 
    else map.flyTo(m.getLatLng(), z, {duration: .6});
    m.openPopup();
}

const refLine = (ref, right, text, awardId = null, awardee = null) =>
    `<li><div class="top">${refBadge(ref, awardId)}` +
    `<span class="amt">${right}</span></div><div class="t">${text}</div>` +
    supplierLine(awardee) + `</li>`;

// --- Full contract details in a side drawer ---

const contractDrawerCache = {};

const contractItemTable = c => {
    const items = c.items || [];
    if (!items.length) return `<p class="cmp-empty">No item lines recorded for this contract.</p>`;
    return `<div class="cmp-table-wrap contract-table-wrap"><table>
             <thead><tr><th>Item Details</th><th>Qty</th><th>Indicative budget</th></tr></thead>
             <tbody>` +
           items.map(l => `
             <tr>
               <td>
                 <div class="cmp-item-title">${esc(l.item || l.item_name || c.title || "Item line")}</div>
                 ${itemSubLabel(l) ? `<div class="cmp-line-meta">${esc(itemSubLabel(l))}</div>` : ""}
               </td>
               <td class="num">${num(l.quantity)} ${esc(l.uom || "")}</td>
               <td class="num price-cell">${linePrice(l)}</td>
             </tr>`).join("") +
           `</tbody></table></div>`;
};

const contractCard = c => {
    const derived = c.derived
        ? `<small class="derived-note" title="Budget comes from the item lines, not a copied whole-lot ABC">from items</small>`
        : "";
    const meta = [c.status, formatDate(c.published)].filter(Boolean).map(esc).join(" · ");
    return `<article class="drawer-contract">
              <div class="dc-head">
                <div>${refBadge(c.bid_ref, c.award_id)}</div>
                <div class="dc-budget">${peso(c.abc)}${derived}</div>
              </div>
              <h4 class="dc-title">${esc(c.title || c.bid_ref)}</h4>
              <div class="dc-meta">${supplierLine(c.awardee)}${meta ? `<div class="detail-meta">${meta}</div>` : ""}</div>
              ${contractItemTable(c)}
            </article>`;
};

const contractYearCards = rows => {
    const byYear = new Map();
    rows.forEach(x => {
        const d = x.published ? new Date(x.published) : null;
        const year = d && !isNaN(d) ? d.getFullYear() : "Undated";
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(x);
    });
    return [...byYear.entries()]
        .sort((a, b) => a[0] === "Undated" ? 1
            : b[0] === "Undated" ? -1
            : Number(b[0]) - Number(a[0]))
        .map(([year, items]) =>
            `<details class="contract-year" open><summary>${esc(year)} <span>${items.length}</span></summary>` +
            `<div class="contract-year-body">${items.map(contractCard).join("")}</div></details>`
        ).join("");
};

const fetchAllContracts = async id => {
    const all = [];
    for (let offset = 0; offset < 20000; offset += 200) {
        const res = await fetch(`/api/pins/${id}/contracts?limit=200&offset=${offset}&details=1&${filterParams(false)}`);
        if (!res.ok) throw new Error("bad response");
        const rows = await res.json();
        all.push(...rows);
        if (rows.length < 200) break;
    }
    return all;
};

const contractDrawerKey = id => `${id}:${filterParams(false).toString()}`;

const closeContractDrawer = () => {
    const d = $("contractDrawer");
    if (!d) return;
    d.hidden = true;
    d.dataset.token = "";
};

const bindContractClose = () => {
    const btn = $("closeContractDrawer");
    if (btn) btn.onclick = closeContractDrawer;
};

const contractDrawerShell = p => `
    <div class="cmp-header">
        <div class="cmp-header-main">
            <h2>All contracts</h2>
            <p class="cmp-subtitle">${esc(p.entities || "Agency")} · ${esc(p.address || "No address listed")}</p>
        </div>
        <button type="button" class="btn ghost close-cmp" id="closeContractDrawer">Close</button>
    </div>`;

const openContractDrawer = async p => {
    const d = $("contractDrawer");
    if (!d) return;
    const id = Number(p.id);
    const key = contractDrawerKey(id);
    const token = `${key}:${Date.now()}`;
    d.dataset.token = token;
    $("cmp").hidden = true;
    d.hidden = false;
    d.innerHTML = contractDrawerShell(p) +
        `<div class="drawer-loading">Loading every contract and its item lines…</div>`;
    bindContractClose();
    $("closeContractDrawer")?.focus();

    try {
        let rows = contractDrawerCache[key];
        if (!rows) {
            rows = await fetchAllContracts(id);
            contractDrawerCache[key] = rows;
        }
        if (d.dataset.token !== token) return;
        d.innerHTML = contractDrawerShell(p) + (rows.length
            ? `<div class="drawer-summary">${rows.length} contract${rows.length === 1 ? "" : "s"} · grouped by year</div>` +
              contractYearCards(rows) +
              `<p class="cmp-note"><span class="legend-key tag-unit">PER ITEM (EST.)</span> uses genuine line budgets. ` +
              `<span class="legend-key tag-lot">WHOLE LOT</span> is the full bundle budget. These are budgets, not amounts paid.</p>`
            : `<p class="cmp-empty">No contracts found.</p>`);
        bindContractClose();
    } catch {
        if (d.dataset.token !== token) return;
        d.innerHTML = contractDrawerShell(p) +
            `<p class="cmp-empty">Could not load contracts. Please try again.</p>`;
        bindContractClose();
    }
};

// --- Data Fetching (Agencies & Items) ---
async function loadAgencies() {
    const params = filterParams(false);
    clearSummary();
    
    const res = await fetch("/api/pins?" + params);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    
    render(data,
        p => `<div class="pop"><h2>${esc(p.entities)}</h2><div class="addr">${esc(p.address)}</div>` +
             `<dl><dt>Contracts</dt><dd>${p.contracts}</dd>` +
             `<dt>Total budget</dt><dd>${peso(p.total_budget)}</dd></dl>` +
             `<div class="pop-section-title">Recent contracts</div>` +
             `<ul class="refs" id="refs-${p.id}"><li class="more">Loading contracts...</li></ul>` +
             `<button type="button" class="btn pop-btn contract-details-btn" id="all-${p.id}" data-id="${p.id}">` +
             `<span>View all ${p.contracts} contracts</span><span aria-hidden="true">→</span></button></div>`,
async (p, marker) => {
    const popupEl = marker.getPopup()?.getElement();
    if (!popupEl) return;

    const viewAll = popupEl.querySelector(`#all-${p.id}`);
    if (viewAll && !viewAll.dataset.bound) {
        viewAll.dataset.bound = "1";
        viewAll.onclick = () => openContractDrawer(p);
    }

    try {
        const r = await fetch(
            `/api/pins/${p.id}/contracts?limit=10&${filterParams(false)}`
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const rows = await r.json();

        const el = popupEl.querySelector(`#refs-${p.id}`);
        if (!el) return;

        el.innerHTML = rows.length
            ? rows.map(x =>
                refLine(
                    x.bid_ref,
                    peso(x.abc) + (
                        x.derived
                            ? ' <small title="Contract budget was blank; this is the sum of its item budgets">from items</small>'
                            : ""
                    ),
                    esc(x.title),
                    x.award_id,
                    x.awardee
                )
            ).join("") +
            (p.contracts > rows.length
                ? `<li class="more">Showing ${rows.length} of ${p.contracts} contracts</li>`
                : "")
            : `<li class="more">No contracts to show.</li>`;

    } catch (error) {
        console.error("Could not load contracts for agency:", p.id, error);
        const el = popupEl.querySelector(`#refs-${p.id}`);
        if (el) el.innerHTML = `<li class="more">Could not load contracts. Please try again.</li>`;
    }
},

        p => `<li><button class="row" data-id="${p.id}"><span class="name">${esc(p.entities)}</span>` +
             `<span class="addr">${esc(p.address)}</span>` +
             `<span class="meta"><b>${p.contracts}</b> contracts, ${peso(p.total_budget)}</span></button></li>`,
        (a, b) => b.total_budget - a.total_budget
    );
    
    const n = data.features.length;
    $("status").innerHTML = n
        ? `<span class="status-kicker">Agency locations</span><strong>${n} location${n === 1 ? "" : "s"} found</strong><span class="status-sub">Click a pin to see its contracts.</span>`
        : `<span class="status-kicker">Agency locations</span><strong>No matches</strong><span class="status-sub">Clear a filter or adjust the criteria.</span>`;
}

async function loadItems(itemQ) {
    const params = filterParams(true);

    params.set("min_budget", $("minInput").value);
    params.set("max_budget", $("maxInput").value);

    const res = await fetch(
        `/api/items/pins?q=${encodeURIComponent(itemQ)}&${params.toString()}`
    );
    if (!res.ok) {
        clearSummary();
        $("status").textContent = "Type at least 2 characters to search items.";
        return;
    }
    const data = await res.json();
    renderSummary(data.summary);
    
    render(data,
        p => `<div class="pop"><h2>${esc(p.entities)}</h2><div class="addr">${esc(p.address)}</div>` +
             `<dl><dt>Matching items</dt><dd>${p.n_items}${p.total_qty ? ` (${num(p.total_qty)} units)` : ""}</dd>` +
             itemPriceRows(p) + `</dl>` +
             `<div class="pop-note">${p.n_comparable ? "Per-item estimates use real line budgets. " : ""}Whole-lot values cover the full bundle, not one item.</div>` +
             `<ul class="refs" id="refs-${p.id}"><li class="more">Loading items...</li></ul>` +
             `<button type="button" class="btn pop-btn contract-details-btn" id="all-${p.id}" data-id="${p.id}">` +
             `<span>View all agency contracts</span><span aria-hidden="true">→</span></button>` +
             `<button class="btn pop-btn cmpbtn" id="cmp-${p.id}" data-id="${p.id}">` +
             `<span class="cmp-icon">+</span><span>Add to comparison</span></button></div>`,
        async p => {
            const b = $(`cmp-${p.id}`);
            if (b) b.onclick = () => addCompare(p);
            const viewAll = $(`all-${p.id}`);
            if (viewAll) viewAll.onclick = () => openContractDrawer(p);
            const el = $(`refs-${p.id}`);
            try {
                const r = await fetch(`/api/items/compare?q=${encodeURIComponent(itemQ)}&a=${p.id}&b=0&${filterParams(true)}`);
                const d = r.ok ? await r.json() : null;
                const lines = d ? d.a.lines : [];
                el.innerHTML = lines.length
                    ? lines.slice(0, 10).map(l => // Add l.awardee at the very end
refLine(l.bid_ref, linePrice(l),
                        `${esc(l.item)}${itemSubLabel(l) ? ` · ${esc(itemSubLabel(l))}` : ""}, ${num(l.quantity)} ${esc(l.uom || "")}`,
                        l.award_id, l.awardee
                      )).join("") + 
                      (lines.length > 10 ? `<li class="more">Showing 10 of ${lines.length} items</li>` : "")
                    : `<li class="more">No items to show.</li>`;
            } catch { el.innerHTML = `<li class="more">Could not load items.</li>`; }
        },
        p => `<li draggable="true" data-id="${p.id}"><span class="drag-handle" title="Drag to a compare slot" aria-hidden="true">⠿</span>` +
             `<button class="row" data-id="${p.id}"><span class="name">${esc(p.entities)}</span>` +
             `<span class="addr">${esc(p.address)}</span>` +
             `<span class="meta"><b>${p.n_items}</b> item${p.n_items === 1 ? "" : "s"}</span>` +
             itemPriceLines(p) + `</button>` +
             `<button class="cmpbtn" data-id="${p.id}" title="Add to comparison">` +
             `<span class="cmp-icon">+</span><span>Compare</span></button></li>`,
        (a, b) => {
            const ka = a.n_comparable ? a.median_unit : Infinity;
            const kb = b.n_comparable ? b.median_unit : Infinity;
            return ka === kb
                ? (a.lot_min ?? Infinity) - (b.lot_min ?? Infinity)
                : ka - kb;
        }
    );
    
    const n = data.features.length;
    $("status").innerHTML = n
        ? `<span class="status-kicker">Item matches</span><strong>${n} location${n === 1 ? "" : "s"} for “${esc(itemQ)}”</strong>` +
          `<span class="status-sub">Click a pin to inspect items. Select two to compare.</span>` +
          (data.truncated ? `<span class="status-warn">Results capped — try a more specific search.</span>` : "")
        : `<span class="status-kicker">Item matches</span><strong>No purchases found</strong><span class="status-sub">Try a broader term such as “laptop” or “printer”.</span>`;
}

async function refresh() {
    const itemQ = $("item").value.trim();
    const mode = itemQ ? "item:" + itemQ : "agency";
    if (mode !== lastMode) {
        fitNext = true;
        lastMode = mode;
        selected = []; // a new search starts a fresh comparison
    }

    const mapMode = $("mapMode");
    if (mapMode) {
        mapMode.textContent = itemQ
            ? "Item search: " + (itemQ.length > 32 ? itemQ.slice(0, 32) + "…" : itemQ)
            : "Agency locations";
    }

    try { 
        await (itemQ ? loadItems(itemQ) : loadAgencies()); 
        drawTray();
    } catch { 
        clearSummary();
        $("status").textContent = "Could not reach the server. Check that it is running."; 
        drawTray();
    }
}

const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 350); };


// --- Filters Handling ---
let FILTERS = null;
const SEL = {region: "f-region", province: "f-province", city: "f-city", category: "f-category", status: "f-status"};

function filterParams(forItems) {
    const p = new URLSearchParams();
    for (const [k, id] of Object.entries(SEL)) { 
        const v = $(id).value; 
        if (v) p.set(k, v); 
    }
    const a = $("q").value.trim();
    if (a) {
        if (FILTERS && FILTERS.agencies.some(x => x.name === a)) p.set("agency", a);
        else if (!forItems) p.set("q", a);
    }
    
    // --- Fix: Apply Price Range Filters globally ---
    const minB = $("minInput").value;
    const maxB = $("maxInput").value;
    
    // Only append to the URL if they have been moved from their absolute extremes
    if (minB && Number(minB) > 1000) {
        p.set("min_budget", minB);
    }
    if (maxB && Number(maxB) < 10000000) {
        p.set("max_budget", maxB);
    }
    
    return p;
}

function fillFilters() {
    const F = FILTERS, r = $("f-region").value, pr = $("f-province").value, c = $("f-city").value;
    const opts = (list, label) => `<option value="">${label}</option>` +
        list.map(x => `<option value="${esc(x.name)}">${esc(x.name)} (${x.n})</option>`).join("");
    
    const keep = (id, html) => { 
        const s = $(id), v = s.value; s.innerHTML = html;
        if ([...s.options].some(o => o.value === v)) s.value = v; 
    };
    
    keep("f-region", opts(F.regions, "All Regions"));
    keep("f-province", opts(F.provinces.filter(x => !r || x.region === r), "All Provinces"));
    keep("f-city", opts(F.cities.filter(x => (!r || x.region === r) && (!pr || x.province === pr)), "All Cities"));
    keep("f-category", opts(F.categories, "All Categories"));
    keep("f-status", opts(F.statuses, "All Statuses"));
    
    $("agencylist").innerHTML = F.agencies
        .filter(x => (!r || x.region === r) && (!pr || x.province === pr) && (!c || x.city === c))
        .map(x => `<option value="${esc(x.name)}"></option>`).join("");
}

function countFilters() {
    // Check if either slider has been moved from its default position
    let priceActive = 0;
    if (Number($("minInput").value) > 1000 || Number($("maxInput").value) < 10000000) {
        priceActive = 1;
    }
    
    const n = Object.values(SEL).filter(id => $(id).value).length + ($("q").value.trim() ? 1 : 0) + priceActive;
    $("fcount").textContent = n ? `(${n} active)` : "";
}

// Event Listeners for Filters
Object.values(SEL).forEach(id => $(id).addEventListener("change", () => { fillFilters(); countFilters(); later(); }));
["q"].forEach(id => $(id).addEventListener("input", () => { countFilters(); later(); }));
$("clearF").onclick = () => {
    Object.values(SEL).forEach(id => { $(id).value = ""; });
    $("q").value = "";
    $("item").value = "";
    syncClearSearch();

    // Reset price range
    $("minInput").value = "1000"; $("maxInput").value = "10000000";
    $("minb").value = "1000"; $("maxb").value = "10000000";
    updatePriceRange("min");

    if (FILTERS) fillFilters();
    countFilters();
    later();
};
if($("applyF")) $("applyF").addEventListener("click", refresh);

// Typeahead for Items
let sugTimer = null;

function syncClearSearch() {
    const btn = $("clear-search");
    if (btn) btn.hidden = !$("item").value;
}
syncClearSearch();

$("clear-search").addEventListener("click", () => {
    $("item").value = "";
    syncClearSearch();
    later();
    $("item").focus();
});

$("item").addEventListener("input", () => {
    syncClearSearch();
    clearTimeout(sugTimer);
    later(); // Also trigger standard refresh
    const v = $("item").value.trim();
    if (v.length < 2) return;
    sugTimer = setTimeout(async () => {
        try {
            const r = await fetch("/api/items/suggest?q=" + encodeURIComponent(v));
            if (r.ok) $("itemlist").innerHTML = (await r.json()).map(x => `<option value="${esc(x)}">`).join("");
        } catch {}
    }, 200);
});

$("summary").addEventListener("click", e => {
    const card = e.target.closest(".sum-card[data-id]");
    if (card) focusLoc(+card.dataset.id);
});

$("list").addEventListener("click", e => {
    const c = e.target.closest(".cmpbtn");
    if (c) return addCompare(props[c.dataset.id]);
    const r = e.target.closest(".row");
    if (r) focusLoc(+r.dataset.id);
});


// --- Drag a result card into the comparison dock ---
const DRAG_TYPE = "application/x-procurement-location";

const readDragId = e => {
    const dt = e.dataTransfer;
    if (!dt) return null;
    const raw = dt.getData(DRAG_TYPE) || dt.getData("text/plain");
    return raw ? Number(raw) : null;
};

$("list").addEventListener("dragstart", e => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", li.dataset.id);
    e.dataTransfer.setData(DRAG_TYPE, li.dataset.id);
    li.classList.add("dragging");
});

$("list").addEventListener("dragend", e => {
    const li = e.target.closest("li[data-id]");
    if (li) li.classList.remove("dragging");
    trayEl.classList.remove("drag-over");
    document.querySelectorAll(".tray-slot").forEach(s => s.classList.remove("drop-target"));
});

const trayEl = $("tray");
trayEl.addEventListener("dragover", e => {
    if (e.target.closest(".tray-slot")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    trayEl.classList.add("drag-over");
});

trayEl.addEventListener("drop", e => {
    if (e.target.closest(".tray-slot")) return;
    e.preventDefault();
    trayEl.classList.remove("drag-over");
    const id = readDragId(e);
    if (id == null || !props[id]) return;
    setCompareSlot(selected.length < 2 ? selected.length : 1, props[id]);
});


// --- Location Comparison Logic ---
function addCompare(p) {
    if (!p) return;
    const i = selected.findIndex(s => s.id === p.id);
    if (i >= 0) selected.splice(i, 1);
    else { selected.push({id: p.id, entities: p.entities}); if (selected.length > 2) selected.shift(); }
    drawTray(); markCompare();
}

function markCompare() {
    document.querySelectorAll(".cmpbtn[data-id]").forEach(b => {
        const on = selected.some(s => String(s.id) === b.dataset.id);
        const idle = b.classList.contains("pop-btn") ? "Add to comparison" : "Compare";
        b.classList.toggle("on", on);
        b.innerHTML = `<span class="cmp-icon">${on ? "✓" : "+"}</span><span>${on ? "Added" : idle}</span>`;
        b.title = on ? "Remove from comparison" : "Add to comparison";
    });
}

const topLocation = (exclude = []) =>
    Object.values(props).find(p => !exclude.includes(p.id)) || null;

function setCompareSlot(index, p) {
    if (!p || selected.some(s => s.id === p.id)) return;
    const next = selected.slice(0, index);
    while (next.length < index) {
        const filler = topLocation(next.map(s => s.id).concat(p.id));
        if (!filler) return;
        next.push({id: filler.id, entities: filler.entities});
    }
    next[index] = {id: p.id, entities: p.entities};
    selected = next.slice(0, 2);
    drawTray(); markCompare();
}

function drawTray() {
    const t = $("tray");
    if (!$("item").value.trim()) {
        t.style.display = "none";
        t.innerHTML = "";
        return;
    }
    t.style.display = "block";

    const slot = i => {
        const s = selected[i];
        return `<button type="button" class="tray-slot ${s ? "filled" : ""}" data-slot="${i}" ` +
               `title="Drag a result here${s ? " to replace" : ""}">` +
               `<span class="slot-letter">${i === 0 ? "A" : "B"}</span>` +
               `<span class="slot-copy">${s ? `<b>${esc(s.entities)}</b>` : `<b>Add a location</b><small>Drag here</small>`}</span>` +
               `<span class="slot-action">${s ? "✓" : "+"}</span></button>`;
    };

    t.innerHTML =
        `<div class="tray-head"><div>` +
          `<span class="tray-title">Compare prices</span>` +
          `<span class="tray-count">${selected.length}/2 selected</span>` +
        `</div><button type="button" class="tray-x" id="clrCmp" title="Clear selection" ${selected.length ? "" : "disabled"}>×</button></div>` +
        `<div class="tray-slots">${slot(0)}${slot(1)}</div>` +
        `<button class="btn tray-go" id="goCmp" ${selected.length < 2 ? "disabled" : ""}>Compare selected <span>→</span></button>` +
        `<div class="tray-tip">Drag a result into A or B, or use the compare buttons.</div>`;

    $("clrCmp").onclick = () => { selected = []; drawTray(); markCompare(); };
    $("goCmp").onclick = showCompare;
    t.querySelectorAll(".tray-slot").forEach(btn => {
        btn.addEventListener("dragover", e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            btn.classList.add("drop-target");
        });

        btn.addEventListener("dragleave", () => btn.classList.remove("drop-target"));

        btn.addEventListener("drop", e => {
            e.preventDefault();
            btn.classList.remove("drop-target");
            const id = readDragId(e);
            if (id != null && props[id]) setCompareSlot(Number(btn.dataset.slot), props[id]);
        });
    });
}

async function showCompare() {
    const itemQ = $("item").value.trim();
    if (selected.length < 2 || !itemQ) return;
    
    const res = await fetch(`/api/items/compare?q=${encodeURIComponent(itemQ)}&a=${selected[0].id}&b=${selected[1].id}&${filterParams(true)}`);
    if (!res.ok) return;
    
    const d = await res.json(), A = d.a, B = d.b;
    const lo = (x, y) => (x != null && y != null && x < y) ? "cmp-cheaper" : "";
    
    const renderStats = (X, Y) => {
        let rows = `<div class="stat-row"><span>Items found</span> <b>${num(X.n_items)}</b></div>`;
        if (X.n_comparable) {
            rows += `<div class="stat-row"><span>Lowest /item (est.)</span> <b class="${lo(X.min_unit, Y.min_unit)}">${peso(X.min_unit)}</b></div>` +
                    `<div class="stat-row"><span>Median /item (est.)</span> <b class="${lo(X.median_unit, Y.median_unit)}">${peso(X.median_unit)}</b></div>` +
                    `<div class="stat-row"><span>Highest /item (est.)</span> <b class="${lo(X.max_unit, Y.max_unit)}">${peso(X.max_unit)}</b></div>`;
            if (X.n_lots) {
                rows += `<div class="stat-row stat-alt"><span>Lot totals</span> <b>${lotRange(X)}</b></div>`;
            }
        } else if (X.n_lots) {
            rows += `<div class="stat-row"><span>Lowest lot</span> <b class="${lo(X.lot_min, Y.lot_min)}">${peso(X.lot_min)}</b></div>` +
                    `<div class="stat-row"><span>Median lot</span> <b class="${lo(X.lot_median, Y.lot_median)}">${peso(X.lot_median)}</b></div>` +
                    `<div class="stat-row"><span>Highest lot</span> <b class="${lo(X.lot_max, Y.lot_max)}">${peso(X.lot_max)}</b></div>` +
                    `<div class="stat-note">Whole-lot budgets — not comparable per item.</div>`;
        } else {
            rows += `<div class="stat-note">No budget values available.</div>`;
        }
        return rows;
    };

const renderLines = (X) => X.lines.length
        ? `<div class="cmp-table-wrap"><table>
             <thead><tr><th>Item Details</th><th>Qty</th><th>Indicative budget</th></tr></thead>
             <tbody>` +
             X.lines.slice(0, 10).map(l => `
               <tr>
                 <td>
                   <div class="cmp-item-title">${esc(l.item || l.item_name)}</div>
                   ${itemSubLabel(l) ? `<div class="cmp-line-meta">${esc(itemSubLabel(l))}</div>` : ""}
                   <!-- Awardee tag added right below the title -->
                   ${l.awardee ? `<div class="cmp-supplier"><strong>Supplier:</strong> ${esc(l.awardee)}</div>` : ""}
                   <div class="cmp-meta-badges">
                     ${refBadge(l.bid_ref, l.award_id)}
                     ${l.status ? `<span class="cmp-status-badge">${esc(l.status)}</span>` : ""}
                     ${l.published ? `<span class="cmp-date">${formatDate(l.published)}</span>` : ""}
                   </div>
                 </td>
                 <td class="num">${num(l.quantity)} ${esc(l.uom || "")}</td>
                 <td class="num price-cell">${linePrice(l)}</td>
               </tr>`).join("") +
             `</tbody></table></div>`
        : `<p class="cmp-empty">No matching contract line items found.</p>`;

    const c = $("cmp");
    closeContractDrawer();
    c.hidden = false;
    c.innerHTML = `
        <div class="cmp-header">
            <div class="cmp-header-main">
                <h2>Price Benchmark Comparison</h2>
                <p class="cmp-subtitle">For: "${esc(itemQ)}"</p>
            </div>
            <button class="btn ghost close-cmp" id="closeCmp">Close</button>
        </div>

        <div class="cmp-grid">
            <!-- Location A Card -->
            <div class="cmp-card">
                <h3>${esc(A.entities.join("; ") || "Location A")}</h3>
                <p class="cmp-address">${esc(A.address || "No address listed")}</p>
                <div class="cmp-stats">
                    ${renderStats(A, B)}
                </div>
                <h4 class="cmp-section-title">Recent Contract Entries</h4>
                ${renderLines(A)}
            </div>

            <!-- Location B Card -->
            <div class="cmp-card">
                <h3>${esc(B.entities.join("; ") || "Location B")}</h3>
                <p class="cmp-address">${esc(B.address || "No address listed")}</p>
                <div class="cmp-stats">
                    ${renderStats(B, A)}
                </div>
                <h4 class="cmp-section-title">Recent Contract Entries</h4>
                ${renderLines(B)}
            </div>
        </div>
        
        <p class="cmp-note"><span class="legend-key tag-unit">PER ITEM (EST.)</span> uses genuine line-item budgets. <span class="legend-key tag-lot">WHOLE LOT</span> is the full contract/lot budget and must not be read as a unit price. These are budgets, not amounts paid.</p>
    `;

    $("closeCmp").focus();
    $("closeCmp").onclick = () => { c.hidden = true; };
}

document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    $("cmp").hidden = true;
    closeContractDrawer();
});


// --- Initialization Call ---
fetch("/api/filters").then(r => r.ok ? r.json() : null)
    .then(f => { 
        if (f) { 
            FILTERS = f; 
            fillFilters(); 
            
            // Update the date in the header
            if (f.last_updated) {
                $("last-updated").textContent = f.last_updated;
            } else {
                $("last-updated").textContent = "Unknown Date";
            }
        } 
    })
    .catch(() => {
        $("last-updated").textContent = "Offline";
    }).finally(refresh);



// --- Price Range Slider Logic ---
const minSlider = $("minb");
const maxSlider = $("maxb");
const minInput = $("minInput");
const maxInput = $("maxInput");

function updatePriceRange(source) {
    let min = Number(minSlider.value);
    let max = Number(maxSlider.value);

    // Prevent sliders from crossing over
    if (min > max) {
        if (source === "min") {
            min = max;
            minSlider.value = min;
        } else {
            max = min;
            maxSlider.value = max;
        }
    }

    // Sync manual inputs
    minInput.value = min;
    maxInput.value = max;

    // Update UI labels
    $("minLabel").textContent = "₱" + min.toLocaleString("en-PH");
    $("maxLabel").textContent = max >= 10000000
        ? "₱10,000,000+"
        : "₱" + max.toLocaleString("en-PH");

    countFilters();
    later();
}

// Update when either slider moves
minSlider.addEventListener("input", () => updatePriceRange("min"));
maxSlider.addEventListener("input", () => updatePriceRange("max"));

// Update when manually entering prices
minInput.addEventListener("change", () => {
    minSlider.value = Math.min(
        10000000,
        Math.max(1000, Number(minInput.value) || 1000)
    );
    updatePriceRange("min");
});

maxInput.addEventListener("change", () => {
    maxSlider.value = Math.min(
        10000000,
        Math.max(1000, Number(maxInput.value) || 1000)
    );
    updatePriceRange("max");
});

// Reset slider values on initial load
window.addEventListener("DOMContentLoaded", () => {
    minSlider.value = "1000";
    maxSlider.value = "10000000";

    updatePriceRange("min");
});

// for getting date safely
function updateDataDate() {
    const el = $("dataDate");
    if (!el) return; // Exit quietly if the element doesn't exist in HTML

    const today = new Date();
    el.textContent = new Intl.DateTimeFormat("en-PH", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "Asia/Manila"
    }).format(today);
}

updateDataDate();