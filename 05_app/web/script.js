/**
- Procurement Price Monitoring System
- Handles Map UI, PhilGEPS API fetching, and filtering logic.
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

const AWARD_LINK_ICON = `<svg class="ref-ext-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

const refBadge = (ref, awardId) => {
    if (!awardId || isUnnumberedAward(awardId)) {
        return bidRefBadge(ref, isUnnumberedAward(awardId)
            ? "Award notice number not in source; showing the bid reference number"
            : "Bid Reference Number");
    }
    return bidRefBadge(ref) +
        `<a href="https://philgeps.gov.ph/Indexes/viewAwardNotice/${esc(awardId)}" ` +
        `target="_blank" rel="noopener noreferrer" class="ref-link" ` +
        `title="Click to view full details about this bid on PhilGEPS">` +
        `<span class="ref ref-award"><span>Award ${esc(awardId)}</span>${AWARD_LINK_ICON}</span></a>`;
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

const pesoCompact = n => {
    if (n == null) return "n/a";
    const abs = Math.abs(n);
    if (abs < 1000) return peso(n);

    const units = [
        { div: 1e9, suffix: "B" },
        { div: 1e6, suffix: "M" },
        { div: 1e3, suffix: "k" },
    ];

    for (const { div, suffix } of units) {
        if (abs >= div) {
            const raw = abs / div;
            if (raw >= 1000 && suffix !== "B") continue;

            const intDigits = Math.max(1, Math.floor(Math.log10(raw)) + 1);
            const decimals = Math.max(0, 3 - intDigits);
            const factor = Math.pow(10, decimals);
            let ceiled = Math.ceil(raw * factor) / factor;

            if (ceiled >= 1000 && suffix === "k") {
                const mVal = Math.ceil((abs / 1e6) * 100) / 100;
                const sign = n < 0 ? "-" : "";
                return "PHP " + sign + Number(mVal.toFixed(2)).toString() + "M";
            }

            const sign = n < 0 ? "-" : "";
            return "PHP " + sign + Number(ceiled.toFixed(decimals)).toString() + suffix;
        }
    }

    return peso(n);
};

// Normalize ALL-CAPS database strings for cleaner popup/drawer readability while keeping acronyms
const smartCase = str => {
    const s = String(str ?? "").trim();
    if (!s) return "";
    if (/[a-z]/.test(s)) return s.charAt(0).toUpperCase() + s.slice(1);

    const keepUpper = /^(lan|wan|ict|it|pc|ups|led|lcd|usb|hdmi|vga|ssd|hdd|ram|cpu|gpu|cctv|dvr|nvr|wifi|voip|ip|id|ncr|car|barmm|dpwh|bir|lgu|deped|doh|dilg|dost|dict|lto|sec|sss|gsis|pnp|afp|bfp|bjmp|ched|tesda|neda|dbm|dof|dti|dole|denr|da|dar|dswd|dot|dotr|doe|psa|coa|csc|comelec|deo|rhu|i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/i;
    const minorWords = /^(a|an|the|and|but|or|for|nor|on|at|to|from|by|in|of|with)$/i;

    return s.toLowerCase().replace(/\b([a-z0-9']+)\b/g, (word, _, offset, full) => {
        if (word === "philgeps") return "PhilGEPS";
        if (keepUpper.test(word)) return word.toUpperCase();
        const prev = offset > 0 ? full.charAt(offset - 1) : "";
        const afterBoundary = offset === 0 || prev === "-" || prev === "(" || prev === "/" || prev === ":";
        if (!afterBoundary && minorWords.test(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
    });
};

let summaryTab = "per_item";

function renderSummary(summary) {
    const el = $("summary");
    if (!el) return;

    const flat = summary && summary.national
        ? {
            per_item: { available: summary.available || 0, national: summary.national, regions: summary.regions || [] },
            whole_lot: { available: 0, national: null, regions: [] }
          }
        : null;

    const data = flat || {
        per_item: (summary && summary.per_item) || { available: 0, national: null, regions: [] },
        whole_lot: (summary && summary.whole_lot) || { available: 0, national: null, regions: [] },
    };

    const hasItems = (data.per_item.available || 0) > 0;
    const hasLots = (data.whole_lot.available || 0) > 0;

    if (!hasItems && !hasLots) {
        el.hidden = false;
        el.innerHTML =
            `<div class="bench-card">` +
              `<div class="bench-head"><span class="status-kicker">Price Summary</span></div>` +
              `<p class="sum-empty">No budget values in this search can be ranked as prices.</p>` +
            `</div>`;
        return;
    }

    if (summaryTab === "per_item" && !hasItems) summaryTab = "whole_lot";
    if (summaryTab === "whole_lot" && !hasLots) summaryTab = "per_item";

    const active = data[summaryTab];
    const priceKey = summaryTab === "per_item" ? "unit_budget" : "item_budget";
    const nat = active.national || {};
    const lo = nat.lowest;
    const hi = nat.highest;

    const kpiCell = (entry, kind, label, val) => {
        const clickable = entry && entry.address_id != null;
        const tag = clickable ? "button" : "div";
        const attrs = clickable
            ? `type="button" data-id="${esc(entry.address_id)}" title="Focus ${esc(smartCase(entry.entity))} on map"`
            : "";
        return `<${tag} class="kpi-cell ${kind}${clickable ? " is-link" : ""}" ${attrs}>` +
                 `<span class="kpi-label">${label}</span>` +
                 `<strong class="kpi-val">${val}</strong>` +
               `</${tag}>`;
    };

    const extremeCard = (entry, kind, badgeText) => {
        if (!entry) return "";
        const categ = smartCase(entry.item) || "Uncategorized";
        const agency = smartCase(entry.entity) || "Agency";
        const region = entry.region || "Unspecified";
        const clickable = entry.address_id != null;

        return `<button type="button" class="ext-row ${kind}" ` +
                 `${clickable ? `data-id="${esc(entry.address_id)}"` : "disabled"} ` +
                 `title="Focus ${esc(agency)} (${esc(region)}) on map">` +
                 `<div class="ext-top">` +
                   `<span class="ext-badge ${kind}">${badgeText}</span>` +
                   `<span class="ext-price">${peso(entry[priceKey])}</span>` +
                 `</div>` +
                 `<div class="ext-agency">${esc(agency)}</div>` +
                 `<div class="ext-meta-row">` +
                   `<span class="ext-categ">${esc(categ)}</span>` +
                   `<span class="ext-region">${esc(region)}</span>` +
                 `</div>` +
                 `<div class="ext-foot">${sumRef(entry)} · ${num(entry.quantity)} ${esc(entry.uom || "")}</div>` +
               `</button>`;
    };

    const regions = active.regions || [];
    const globalLoVal = lo && typeof lo[priceKey] === "number" ? lo[priceKey] : null;
    const globalHiVal = hi && typeof hi[priceKey] === "number" ? hi[priceKey] : null;
    const globalSpan = (globalLoVal != null && globalHiVal != null && globalHiVal > globalLoVal)
        ? globalHiVal - globalLoVal
        : 0;

    const regionRows = regions.map(rg => {
        const rLo = rg.lowest && typeof rg.lowest[priceKey] === "number" ? rg.lowest[priceKey] : null;
        const rHi = rg.highest && typeof rg.highest[priceKey] === "number" ? rg.highest[priceKey] : null;

        const lowChip = rg.lowest && rg.lowest.address_id != null
            ? `<button type="button" class="reg-chip low" data-id="${esc(rg.lowest.address_id)}" ` +
              `title="Lowest in ${esc(rg.region)}: ${peso(rLo)} — ${esc(smartCase(rg.lowest.entity))}">` +
              `Low ${pesoCompact(rLo)}</button>`
            : "";
        const highChip = rg.highest && rg.highest.address_id != null
            ? `<button type="button" class="reg-chip high" data-id="${esc(rg.highest.address_id)}" ` +
              `title="Highest in ${esc(rg.region)}: ${peso(rHi)} — ${esc(smartCase(rg.highest.entity))}">` +
              `High ${pesoCompact(rHi)}</button>`
            : "";

        let barHtml = "";
        if (globalSpan > 0 && rLo != null && rHi != null) {
            const leftPct = Math.max(0, Math.min(100, ((rLo - globalLoVal) / globalSpan) * 100));
            const rightPct = Math.max(0, Math.min(100 - leftPct, 100 - ((rHi - globalLoVal) / globalSpan) * 100));
            const widthPct = Math.max(8, 100 - leftPct - rightPct);
            barHtml = `<div class="reg-bar"><span style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></span></div>`;
        }

        return `<div class="reg-row">` +
                 `<div class="reg-main">` +
                   `<span class="reg-name">${esc(rg.region)}</span>` +
                   `<span class="reg-median" title="Regional median">${peso(rg.median)}</span>` +
                 `</div>` +
                 barHtml +
                 `<div class="reg-sub">` +
                   `<span class="reg-count">${num(rg.count)} line${rg.count === 1 ? "" : "s"} · median</span>` +
                   `<div class="reg-chips">${lowChip}${highChip}</div>` +
                 `</div>` +
               `</div>`;
    }).join("");

    el.hidden = false;
    el.innerHTML =
        `<div class="bench-card">` +
          `<div class="bench-head">` +
            `<span class="status-kicker">Price Summary</span>` +
            `<div class="seg-tabs" role="tablist" aria-label="Pricing basis">` +
              `<button type="button" class="seg-tab${summaryTab === "per_item" ? " active" : ""}" ` +
                      `data-tab="per_item" ${hasItems ? "" : "disabled"}>` +
                `Per item <span>${num(data.per_item.available || 0)}</span>` +
              `</button>` +
              `<button type="button" class="seg-tab${summaryTab === "whole_lot" ? " active" : ""}" ` +
                      `data-tab="whole_lot" ${hasLots ? "" : "disabled"}>` +
                `Whole lot <span>${num(data.whole_lot.available || 0)}</span>` +
              `</button>` +
            `</div>` +
          `</div>` +

          `<div class="kpi-strip">` +
            kpiCell(lo, "low", "Lowest", lo ? pesoCompact(lo[priceKey]) : "n/a") +
            kpiCell(null, "mid", "Median", nat.median != null ? pesoCompact(nat.median) : "n/a") +
            kpiCell(hi, "high", "Highest", hi ? pesoCompact(hi[priceKey]) : "n/a") +
          `</div>` +

          `<div class="ext-list">` +
            extremeCard(lo, "low", summaryTab === "per_item" ? "Lowest / item" : "Smallest lot") +
            extremeCard(hi, "high", summaryTab === "per_item" ? "Highest / item" : "Largest lot") +
          `</div>` +

          (regions.length
            ? `<details class="reg-details" open>` +
                `<summary>` +
                  `<span>Regional breakdown (${regions.length} region${regions.length === 1 ? "" : "s"})</span>` +
                  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ` +
                       `fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
                    `<polyline points="6 9 12 15 18 9"></polyline>` +
                  `</svg>` +
                `</summary>` +
                `<div class="reg-list">${regionRows}</div>` +
              `</details>`
            : "") +

          `<div class="bench-foot">` +
            (summaryTab === "per_item"
                ? "Unit estimates derived from line-item quantities."
                : "Whole-lot contract totals; not unit prices.") +
          `</div>` +
        `</div>`;

    syncRegChipWidth(el);
    el._lastSummary = summary;
}

function syncRegChipWidth(container = $("summary")) {
    if (!container) return;
    const chips = [...container.querySelectorAll(".reg-chip")];
    if (!chips.length) return;

    chips.forEach(chip => {
        chip.style.removeProperty("--reg-chip-w");
    });

    const maxW = Math.ceil(
        Math.max(...chips.map(chip => chip.getBoundingClientRect().width))
    );

    if (maxW > 0) {
        container.style.setProperty("--reg-chip-w", `${maxW}px`);
    }
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
    ? peso(l.unit_budget) + priceTag("unit", "Per-item est.")
    : (l.item_budget != null
        ? peso(l.item_budget) + priceTag("lot", "Whole lot")
        : "n/a" + priceTag("lot", "No price"));

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


// --- Map Initialization, Zoom Bounds & Soft-Halo Nodes ---
const DEFAULT_VIEW = {
    center: [12.8797, 121.7740],
    zoom: 6
};

const PH_BOUNDS = L.latLngBounds(
    [-6.0, 102.0],  // Southwest
    [32.0, 140.0]   // Northeast
);

const map = L.map("map", {
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    minZoom: 6,
    maxZoom: 19,
    maxBounds: PH_BOUNDS,
    maxBoundsViscosity: 0.85
});

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

function resetMapView() {
    map.closePopup();

    const cur = map.getCenter();
    const alreadyCentered =
        map.getZoom() === DEFAULT_VIEW.zoom &&
        Math.abs(cur.lat - DEFAULT_VIEW.center[0]) < 0.02 &&
        Math.abs(cur.lng - DEFAULT_VIEW.center[1]) < 0.02;

    if (alreadyCentered) return;

    map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom, {
        animate: !reduce,
        duration: 0.45
    });
}

// Custom Reset Zoom control stacked cleanly under Leaflet's +/- zoom bar
const ResetZoomControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const btn = L.DomUtil.create("a", "leaflet-reset-zoom", container);
        btn.href = "#";
        btn.title = "Reset map zoom";
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", "Reset map zoom");
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(btn, "click", e => {
            L.DomEvent.preventDefault(e);
            resetMapView();
        });
        return container;
    }
});
new ResetZoomControl().addTo(map);

function createNodeIcon(_p, tone = "default", isActive = false) {
    const size = 16;
    const stateClass = isActive ? "is-active" : `tone-${tone}`;

    return L.divIcon({
        className: "map-node-wrap",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -(size / 2 + 4)],
        html: `<span class="map-node ${stateClass}"></span>`
    });
}

let layer = null,
    markers = {},
    props = {},
    selected = [],
    fitNext = false,
    lastMode = "",
    timer = null,
    trayCollapsed = false,
    activePopupAbort = null;

const popupContractsCache = {};

function centerPopupOnMap(marker, popup, zoom = map.getZoom()) {
    const popHeight = popup?.getElement()?.offsetHeight || 320;
    const mapHeight = map.getSize().y;
    const idealOffset = Math.max(0, Math.round(popHeight / 2 + 25));
    const maxSafeOffset = Math.max(0, Math.round(mapHeight / 2 - 36));
    const yOffset = Math.min(idealOffset, maxSafeOffset);

    const targetPt = map.project(marker.getLatLng(), zoom).subtract([0, yOffset]);
    const targetLl = map.unproject(targetPt, zoom);

    map.stop();
    if (reduce) {
        map.setView(targetLl, zoom);
    } else if (zoom !== map.getZoom()) {
        map.flyTo(targetLl, zoom, { duration: 0.55 });
    } else {
        map.panTo(targetLl, { animate: true, duration: 0.45 });
    }
}


// --- Core Rendering Logic ---
function render(data, popupFn, onOpen, rowFn, sortFn) {
    if (layer) layer.remove();
    markers = {}; props = {};

    const isItemSearch = Boolean($("item").value.trim());

    let globalMin = Infinity, globalMax = -Infinity;
    if (isItemSearch) {
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

    const getTone = p => {
        if (isItemSearch && globalMin !== globalMax) {
            if (p.min_unit != null && p.min_unit === globalMin) return "low";
            if (p.max_unit != null && p.max_unit === globalMax) return "high";
        }
        return "default";
    };

    const getZOffset = tone => (tone === "low" || tone === "high") ? 500 : 0;

    layer = L.geoJSON(data, {
        pointToLayer: (f, ll) => {
            const p = f.properties;
            const tone = getTone(p);
            return L.marker(ll, {
                icon: createNodeIcon(p, tone, false),
                zIndexOffset: getZOffset(tone),
                riseOnHover: true
            });
        },
        onEachFeature: (f, l) => {
            const p = f.properties;
            markers[p.id] = l;
            props[p.id] = p;
            l._onPopupOpen = popup => onOpen(p, l, popup);
            l.bindPopup(popupFn(p), { minWidth: 260, maxWidth: 360, autoPan: false });
            l.on("popupopen", e => {
                l.setIcon(createNodeIcon(p, getTone(p), true));
                l.setZIndexOffset(1000);

                const targetZoom = l._pendingZoom || map.getZoom();
                l._pendingZoom = null;
                l._targetZoom = targetZoom;

                onOpen(p, l, e.popup);
                centerPopupOnMap(l, e.popup, targetZoom);
            });
            l.on("popupclose", () => {
                const tone = getTone(p);
                l.setIcon(createNodeIcon(p, tone, false));
                l.setZIndexOffset(getZOffset(tone));
            });
        }
    }).addTo(map);

    const rows = data.features.map(f => f.properties).sort(sortFn);
    $("list").innerHTML = rows.map(rowFn).join("");

    markCompare();

    if (fitNext && rows.length) {
        fitNext = false;
        map.fitBounds(layer.getBounds().pad(0.08), { maxZoom: 14 });
    }
}

function focusLoc(id) {
    const m = markers[id];
    if (!m) return;
    const targetZoom = Math.max(map.getZoom(), 14);

    if (m.isPopupOpen()) {
        const popup = m.getPopup();
        m._targetZoom = targetZoom;
        centerPopupOnMap(m, popup, targetZoom);
        const listEl = popup?.getElement()?.querySelector(`#refs-${id}`);
        if (listEl && listEl.querySelector(".more") && m._onPopupOpen) {
            m._onPopupOpen(popup);
        }
        return;
    }

    m._pendingZoom = targetZoom;
    m.openPopup();
}

const popLinePrice = l => {
    if (l.comparable) return peso(l.unit_budget);
    return l.item_budget != null ? peso(l.item_budget) : "n/a";
};

const popLineType = l => {
    if (l.comparable) return "Per-item est.";
    return l.item_budget != null ? "Whole lot" : "No price";
};

const refLine = (ref, right, text, awardId = null, subtitle = "", supplier = "") =>
    `<li>` +
      `<div class="top">` +
        `<div class="refs-badges">${refBadge(ref, awardId)}</div>` +
        `<span class="amt">${right}</span>` +
      `</div>` +
      `<div class="t">${text}</div>` +
      (subtitle ? `<div class="sub-type">${subtitle}</div>` : "") +
      (supplier ? `<div class="sub-supplier">${supplier}</div>` : "") +
    `</li>`;


// --- Full contract & comparison tables ---
const contractDrawerCache = {};

const drawerLinePrice = l => l.comparable
    ? `<div class="dc-price-stack"><span class="dc-amount">${peso(l.unit_budget)}</span>${priceTag("unit", "Per-item est.")}</div>`
    : (l.item_budget != null
        ? `<div class="dc-price-stack"><span class="dc-amount">${peso(l.item_budget)}</span>${priceTag("lot", "Whole lot")}</div>`
        : `<div class="dc-price-stack"><span class="dc-amount">n/a</span>${priceTag("lot", "No price")}</div>`);

const contractItemTable = c => {
    const items = c.items || [];
    if (!items.length) return `<p class="cmp-empty">No item lines recorded for this contract.</p>`;
    return `<div class="cmp-table-wrap contract-table-wrap"><table>
             <colgroup>
               <col class="col-item">
               <col class="col-qty">
               <col class="col-budget">
             </colgroup>
             <thead><tr><th>Item Details</th><th class="num">Qty</th><th class="num">Indicative budget</th></tr></thead>
             <tbody>` +
           items.map(l => `
             <tr>
               <td class="item-cell">
                 <div class="cmp-item-title">${esc(smartCase(l.item || l.item_name || c.title || "Item line"))}</div>
                 ${itemSubLabel(l) ? `<div class="cmp-line-meta">${esc(smartCase(itemSubLabel(l)))}</div>` : ""}
               </td>
               <td class="num qty-cell">${num(l.quantity)} ${esc(l.uom || "")}</td>
               <td class="num price-cell">${drawerLinePrice(l)}</td>
             </tr>`).join("") +
           `</tbody></table></div>`;
};

const contractCard = c => {
    const derived = c.derived
        ? `<small class="derived-note" title="Budget comes from the item lines, not a copied whole-lot ABC">from items</small>`
        : "";
    const meta = [smartCase(c.status), formatDate(c.published)].filter(Boolean).map(esc).join(" · ");
    return `<article class="drawer-contract">
              <div class="dc-head">
                <div>${refBadge(c.bid_ref, c.award_id)}</div>
                <div class="dc-budget">${peso(c.abc)}${derived}</div>
              </div>
              <h4 class="dc-title">${esc(smartCase(c.title || c.bid_ref))}</h4>
              <div class="dc-meta">${supplierLine(smartCase(c.awardee))}${meta ? `<div class="detail-meta">${meta}</div>` : ""}</div>
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
            `<details class="contract-year" open>` +
              `<summary>` +
                `<span class="year-label">${esc(year)}</span>` +
                `<span class="year-right">` +
                  `<span class="year-count">${items.length} contract${items.length === 1 ? "" : "s"}</span>` +
                  `<span class="year-chevron" aria-hidden="true">` +
                    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ` +
                         `fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">` +
                      `<polyline points="6 9 12 15 18 9"></polyline>` +
                    `</svg>` +
                  `</span>` +
                `</span>` +
              `</summary>` +
              `<div class="contract-year-body">${items.map(contractCard).join("")}</div>` +
            `</details>`
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
            <h2>All Contracts</h2>
            <div class="drawer-agency">${esc(smartCase(p.entities) || "Agency")}</div>
            <p class="cmp-subtitle drawer-location">${esc(p.address || "No address listed")}</p>
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
            ? `<div class="drawer-top-meta">` +
                `<div class="drawer-summary">${rows.length} contract${rows.length === 1 ? "" : "s"} · grouped by year</div>` +
                `<p class="drawer-note">` +
                  `<span class="price-tag tag-unit">Per-item est.</span> line-item estimate · ` +
                  `<span class="price-tag tag-lot">Whole lot</span> full bundle budget (budgets, not amounts paid)` +
                `</p>` +
              `</div>` +
              contractYearCards(rows)
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
const CMP_ICONS = {
    plus: `<svg class="cmp-svg" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
    check: `<svg class="cmp-svg" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`
};

async function loadAgencies() {
    const params = filterParams(false);
    clearSummary();

    const res = await fetch("/api/pins?" + params);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();

    render(data,
        p => `<div class="pop">` +
               `<h2>${esc(smartCase(p.entities))}</h2>` +
               `<div class="addr">${esc(p.address)}</div>` +
               `<dl>` +
                 `<dt>Contracts</dt><dd>${p.contracts}</dd>` +
                 `<dt>Total budget</dt><dd>${peso(p.total_budget)}</dd>` +
               `</dl>` +
               `<div class="pop-section-title">Recent contracts</div>` +
               `<ul class="refs" id="refs-${p.id}"><li class="more">Loading contracts...</li></ul>` +
               `<div class="pop-actions">` +
                 `<button type="button" class="btn pop-btn contract-details-btn" id="all-${p.id}" data-id="${p.id}">` +
                   `<span>View all agency contracts</span>` +
                 `</button>` +
               `</div>` +
             `</div>`,
        async (p, marker, popup) => {
            const popupEl = (popup || marker.getPopup())?.getElement();
            if (!popupEl) return;

            const viewAll = popupEl.querySelector(`#all-${p.id}`);
            if (viewAll && !viewAll.dataset.bound) {
                viewAll.dataset.bound = "1";
                viewAll.onclick = () => openContractDrawer(p);
            }

            const el = popupEl.querySelector(`#refs-${p.id}`);
            if (!el) return;

            const qs = filterParams(false).toString();
            const cacheKey = `agency:${p.id}:${qs}`;
            const renderRows = rows => {
                el.innerHTML = rows.length
                    ? rows.map(x =>
                        refLine(
                            x.bid_ref,
                            peso(x.abc),
                            esc(smartCase(x.title)),
                            x.award_id,
                            x.derived ? "From item lines" : "",
                            x.awardee ? `Supplier: ${esc(smartCase(x.awardee))}` : ""
                        )
                    ).join("") +
                    (p.contracts > rows.length
                        ? `<li class="more">Showing ${rows.length} of ${p.contracts} contracts</li>`
                        : "")
                    : `<li class="more">No contracts to show.</li>`;
            };

            if (popupContractsCache[cacheKey]) {
                renderRows(popupContractsCache[cacheKey]);
                return;
            }

            if (activePopupAbort) activePopupAbort.abort();
            const controller = new AbortController();
            activePopupAbort = controller;

            try {
                const r = await fetch(`/api/pins/${p.id}/contracts?limit=10&${qs}`, {
                    signal: controller.signal
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const rows = await r.json();
                popupContractsCache[cacheKey] = rows;
                renderRows(rows);
                if (marker.isPopupOpen()) {
                    centerPopupOnMap(marker, popup || marker.getPopup(), marker._targetZoom || map.getZoom());
                }
            } catch (error) {
                if (error && error.name === "AbortError") return;
                console.error("Could not load contracts for agency:", p.id, error);
                el.innerHTML = `<li class="more">Could not load contracts. Please try again.</li>`;
            }
        },
        p => `<li><button class="row" data-id="${p.id}"><span class="name">${esc(smartCase(p.entities))}</span>` +
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

    const res = await fetch(`/api/items/pins?q=${encodeURIComponent(itemQ)}&${params.toString()}`);
    if (!res.ok) {
        clearSummary();
        $("status").textContent = "Type at least 2 characters to search items.";
        return;
    }
    const data = await res.json();
    renderSummary(data.summary);

    render(data,
        p => `<div class="pop">` +
               `<h2>${esc(smartCase(p.entities))}</h2>` +
               `<div class="addr">${esc(p.address)}</div>` +
               `<dl>` +
                 `<dt>Matching items</dt><dd>${p.n_items}${p.total_qty ? ` (${num(p.total_qty)} units)` : ""}</dd>` +
                 itemPriceRows(p) +
               `</dl>` +
               `<div class="pop-section-title">Matching lines</div>` +
               `<ul class="refs" id="refs-${p.id}"><li class="more">Loading items...</li></ul>` +
               `<div class="pop-actions">` +
                 `<button type="button" class="btn pop-btn contract-details-btn" id="all-${p.id}" data-id="${p.id}">` +
                   `<span>View all agency contracts</span>` +
                 `</button>` +
                 `<button type="button" class="btn pop-btn cmpbtn" id="cmp-${p.id}" data-id="${p.id}">` +
                   `${CMP_ICONS.plus}<span>Add to comparison</span>` +
                 `</button>` +
               `</div>` +
               `<div class="pop-footnote">Per-item estimates use line budgets; whole-lot values cover the full bundle.</div>` +
             `</div>`,
        async (p, marker, popup) => {
            const popupEl = (popup || marker.getPopup())?.getElement();
            if (!popupEl) return;

            const b = popupEl.querySelector(`#cmp-${p.id}`);
            if (b && !b.dataset.bound) {
                b.dataset.bound = "1";
                b.onclick = () => addCompare(p);
            }
            const viewAll = popupEl.querySelector(`#all-${p.id}`);
            if (viewAll && !viewAll.dataset.bound) {
                viewAll.dataset.bound = "1";
                viewAll.onclick = () => openContractDrawer(p);
            }

            const el = popupEl.querySelector(`#refs-${p.id}`);
            if (!el) return;

            const qs = filterParams(true).toString();
            const cacheKey = `item:${itemQ}:${p.id}:${qs}`;
            const renderLines = lines => {
                el.innerHTML = lines.length
                    ? lines.slice(0, 10).map(l => {
                        const sub = itemSubLabel(l);
                        const qty = l.quantity != null ? `${num(l.quantity)} ${esc(l.uom || "")}`.trim() : "";
                        const titleText = [
                            esc(smartCase(l.item)),
                            sub ? esc(smartCase(sub)) : "",
                            qty
                        ].filter(Boolean).join(" · ");

                        return refLine(
                            l.bid_ref,
                            popLinePrice(l),
                            titleText,
                            l.award_id,
                            popLineType(l),
                            l.awardee ? `Supplier: ${esc(smartCase(l.awardee))}` : ""
                        );
                    }).join("") +
                    (lines.length > 10 ? `<li class="more">Showing 10 of ${lines.length} items</li>` : "")
                    : `<li class="more">No items to show.</li>`;
            };

            if (popupContractsCache[cacheKey]) {
                renderLines(popupContractsCache[cacheKey]);
                return;
            }

            if (activePopupAbort) activePopupAbort.abort();
            const controller = new AbortController();
            activePopupAbort = controller;

            try {
                const r = await fetch(`/api/items/compare?q=${encodeURIComponent(itemQ)}&a=${p.id}&b=0&${qs}`, {
                    signal: controller.signal
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const d = await r.json();
                const lines = d ? d.a.lines : [];
                popupContractsCache[cacheKey] = lines;
                renderLines(lines);
                if (marker.isPopupOpen()) {
                    centerPopupOnMap(marker, popup || marker.getPopup(), marker._targetZoom || map.getZoom());
                }
            } catch (error) {
                if (error && error.name === "AbortError") return;
                el.innerHTML = `<li class="more">Could not load items.</li>`;
            }
        },
        p => `<li draggable="true" data-id="${p.id}"><span class="drag-handle" title="Drag to a compare slot" aria-hidden="true">⠿</span>` +
             `<button class="row" data-id="${p.id}"><span class="name">${esc(smartCase(p.entities))}</span>` +
             `<span class="addr">${esc(p.address)}</span>` +
             `<span class="meta"><b>${p.n_items}</b> item${p.n_items === 1 ? "" : "s"}</span>` +
             itemPriceLines(p) + `</button>` +
             `<button class="cmpbtn" data-id="${p.id}" title="Add to comparison">` +
             `${CMP_ICONS.plus}<span>Compare</span></button></li>`,
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
        : `<span class="status-kicker">Item matches</span><strong>No purchases found</strong><span class="status-sub">Try a broader term such as “laptop” or “printer” or clear filters.</span>`;
}

async function refresh() {
    saveFilterState();

    const itemQ = $("item").value.trim();
    const mode = itemQ ? "item:" + itemQ : "agency";
    if (mode !== lastMode) {
        fitNext = true;
        lastMode = mode;
        selected = []; // a new search starts a fresh comparison
    }

    syncMapMode();

    try {
        await (itemQ ? loadItems(itemQ) : loadAgencies());
        drawTray();
    } catch (err) {
        console.error("Refresh failed:", err);
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

    const minB = $("minInput").value;
    const maxB = $("maxInput").value;

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
    const valOf = x => (x && typeof x === "object") ? x.name : x;
    const opts = (list, label) => `<option value="">${label}</option>` +
        (list || []).map(x => {
            const v = valOf(x);
            return v != null ? `<option value="${esc(v)}">${esc(v)}</option>` : "";
        }).join("");

    const keep = (id, html) => {
        const s = $(id), v = s.value;
        s.innerHTML = html;
        if ([...s.options].some(o => o.value === v)) s.value = v;
        else s.value = "";
    };

    const sortedCategories = [...(F.categories || [])].sort((a, b) =>
        String(valOf(a) ?? "").localeCompare(String(valOf(b) ?? ""), undefined, { sensitivity: "base" })
    );

    keep("f-region", opts(F.regions, "All Regions"));
    keep("f-province", opts((F.provinces || []).filter(x => !r || x.region === r), "All Provinces"));
    keep("f-city", opts((F.cities || []).filter(x => (!r || x.region === r) && (!pr || x.province === pr)), "All Cities"));
    keep("f-category", opts(sortedCategories, "All Categories"));
    keep("f-status", opts(F.statuses, "All Statuses"));

    $("agencylist").innerHTML = (F.agencies || [])
        .filter(x => (!r || x.region === r) && (!pr || x.province === pr) && (!c || x.city === c))
        .map(x => `<option value="${esc(valOf(x))}"></option>`).join("");

    if (typeof syncCustomSelect === "function") {
        Object.values(SEL).forEach(id => {
            if ($(id)) syncCustomSelect($(id));
        });
    }
    if (typeof renderAgencyMenu === "function") {
        renderAgencyMenu(false);
    }
}

function countFilters() {
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
    try { sessionStorage.removeItem(FILTER_STORAGE_KEY); } catch (e) {}

    // Reset price range
    $("minInput").value = "1000"; $("maxInput").value = "10000000";
    $("minb").value = "1000"; $("maxb").value = "10000000";
    updatePriceRange("min");

    if (FILTERS) fillFilters();
    countFilters();
    later();
};
if ($("applyF")) $("applyF").addEventListener("click", refresh);

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
    later();
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
    const tab = e.target.closest(".seg-tab[data-tab]");
    if (tab && !tab.disabled) {
        summaryTab = tab.dataset.tab;
        if ($("summary")._lastSummary) renderSummary($("summary")._lastSummary);
        return;
    }
    const target = e.target.closest("[data-id]");
    if (target) focusLoc(+target.dataset.id);
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
    if (trayCollapsed) {
        trayCollapsed = false;
        drawTray();
        return;
    }
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
    if (i >= 0) {
        selected.splice(i, 1);
    } else {
        selected.push({ id: p.id, entities: p.entities });
        if (selected.length > 2) selected.shift();
        trayCollapsed = false;
    }
    drawTray();
    markCompare();
}

function markCompare() {
    document.querySelectorAll(".cmpbtn[data-id]").forEach(b => {
        const on = selected.some(s => String(s.id) === b.dataset.id);
        const idle = b.classList.contains("pop-btn") ? "Add to comparison" : "Compare";
        b.classList.toggle("on", on);
        b.innerHTML = `${on ? CMP_ICONS.check : CMP_ICONS.plus}<span>${on ? "Added" : idle}</span>`;
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
        next.push({ id: filler.id, entities: filler.entities });
    }
    next[index] = { id: p.id, entities: p.entities };
    selected = next.slice(0, 2);
    trayCollapsed = false;
    drawTray();
    markCompare();
}

function drawTray() {
    const t = $("tray");
    if (!t) return;
    if (!$("item").value.trim()) {
        t.style.display = "none";
        t.classList.remove("is-collapsed");
        t.innerHTML = "";
        return;
    }
    t.style.display = "block";
    t.classList.toggle("is-collapsed", trayCollapsed);

    const slot = i => {
        const s = selected[i];
        return `<button type="button" class="tray-slot ${s ? "filled" : ""}" data-slot="${i}" ` +
               `title="${s ? "Click to remove, or drag another result to replace" : "Drag a result here"}">` +
               `<span class="slot-letter">${i === 0 ? "A" : "B"}</span>` +
               `<span class="slot-copy">${s ? `<b>${esc(smartCase(s.entities))}</b><small>Click to remove</small>` : `<b>Add a location</b><small>Drag here</small>`}</span>` +
               `<span class="slot-action" aria-hidden="true">${s ? "×" : "+"}</span></button>`;
    };

    t.innerHTML =
        `<div class="tray-head" id="trayHead">` +
          `<div class="tray-head-main">` +
            `<span class="tray-title">Compare prices</span>` +
            `<span class="tray-count">${selected.length}/2 selected</span>` +
          `</div>` +
          `<div class="tray-actions">` +
            `<button type="button" class="tray-clear" id="clrCmp" title="Clear selected locations" ${selected.length ? "" : "hidden"}>Clear</button>` +
            `<button type="button" class="tray-toggle" id="toggleTray" ` +
              `title="${trayCollapsed ? "Expand comparison tray" : "Collapse comparison tray"}" ` +
              `aria-label="${trayCollapsed ? "Expand comparison tray" : "Collapse comparison tray"}" ` +
              `aria-expanded="${!trayCollapsed}">` +
              `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ` +
                   `fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
                `<polyline points="6 9 12 15 18 9"></polyline>` +
              `</svg>` +
            `</button>` +
          `</div>` +
        `</div>` +
        `<div class="tray-body" ${trayCollapsed ? "hidden" : ""}>` +
          `<div class="tray-slots">${slot(0)}${slot(1)}</div>` +
          `<button class="btn tray-go" id="goCmp" ${selected.length < 2 ? "disabled" : ""}>Compare selected</button>` +
          `<div class="tray-tip">Drag a result into A or B, or use the compare buttons.</div>` +
        `</div>`;

    $("trayHead").onclick = e => {
        if (e.target.closest("#clrCmp")) return;
        trayCollapsed = !trayCollapsed;
        drawTray();
    };

    $("clrCmp").onclick = e => {
        e.stopPropagation();
        selected = [];
        drawTray();
        markCompare();
    };

    $("goCmp").onclick = showCompare;

    t.querySelectorAll(".tray-slot").forEach(btn => {
        btn.addEventListener("click", () => {
            const idx = Number(btn.dataset.slot);
            if (selected[idx]) {
                selected.splice(idx, 1);
                drawTray();
                markCompare();
            }
        });

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

    const renderLines = X => X.lines.length
        ? `<div class="cmp-entries">` +
            X.lines.slice(0, 10).map(l => {
                const meta = [smartCase(l.status), formatDate(l.published)]
                    .filter(Boolean).map(esc).join(" · ");
                const headlinePrice = l.comparable
                    ? peso(l.unit_budget)
                    : (l.item_budget != null ? peso(l.item_budget) : "n/a");

                return `<article class="drawer-contract cmp-entry">
                          <div class="dc-head">
                            <div>${refBadge(l.bid_ref, l.award_id)}</div>
                            <div class="dc-budget">${headlinePrice}</div>
                          </div>
                          <div class="dc-meta">
                            ${supplierLine(smartCase(l.awardee))}
                            ${meta ? `<div class="detail-meta">${meta}</div>` : ""}
                          </div>
                          <div class="cmp-table-wrap contract-table-wrap">
                            <table>
                              <colgroup>
                                <col class="col-item">
                                <col class="col-qty">
                                <col class="col-budget">
                              </colgroup>
                              <thead>
                                <tr>
                                  <th>Item Details</th>
                                  <th class="num">Qty</th>
                                  <th class="num">Indicative budget</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td class="item-cell">
                                    <div class="cmp-item-title">${esc(smartCase(l.item || l.item_name || "Item line"))}</div>
                                    ${itemSubLabel(l) ? `<div class="cmp-line-meta">${esc(smartCase(itemSubLabel(l)))}</div>` : ""}
                                  </td>
                                  <td class="num qty-cell">${num(l.quantity)} ${esc(l.uom || "")}</td>
                                  <td class="num price-cell">${drawerLinePrice(l)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </article>`;
            }).join("") +
          `</div>`
        : `<p class="cmp-empty">No matching contract line items found.</p>`;

    const renderCard = (slotLetter, X, Y, fallback) => `
        <div class="cmp-card">
            <div class="cmp-card-head">
                <span class="cmp-slot-pill">${slotLetter}</span>
                <div class="cmp-card-title-wrap">
                    <h3>${esc(smartCase(X.entities.join("; ")) || fallback)}</h3>
                    <p class="cmp-address">${esc(X.address || "No address listed")}</p>
                </div>
            </div>
            <div class="cmp-stats">
                ${renderStats(X, Y)}
            </div>
            <h4 class="cmp-section-title">Recent Contract Entries</h4>
            ${renderLines(X)}
        </div>`;

    const c = $("cmp");
    closeContractDrawer();
    c.hidden = false;
    c.innerHTML = `
        <div class="cmp-header">
            <div class="cmp-header-main">
                <h2>Price Benchmark Comparison</h2>
                <p class="cmp-subtitle">For: “${esc(smartCase(itemQ))}”</p>
            </div>
            <button type="button" class="btn ghost close-cmp" id="closeCmp">Close</button>
        </div>

        <div class="drawer-top-meta">
            <p class="drawer-note">
                <span class="price-tag tag-unit">Per-item est.</span> line-item estimate ·
                <span class="price-tag tag-lot">Whole lot</span> full bundle budget (budgets, not amounts paid)
            </p>
        </div>

        <div class="cmp-grid">
            ${renderCard("A", A, B, "Location A")}
            ${renderCard("B", B, A, "Location B")}
        </div>
    `;

    $("closeCmp").focus();
    $("closeCmp").onclick = () => { c.hidden = true; };
}

document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    $("cmp").hidden = true;
    closeContractDrawer();
});

const FILTER_STORAGE_KEY = "procurement-filters-v1";

function saveFilterState() {
    try {
        const state = {
            item: $("item").value,
            q: $("q").value,
            region: $("f-region").value,
            province: $("f-province").value,
            city: $("f-city").value,
            category: $("f-category").value,
            status: $("f-status").value,
            minb: $("minInput").value,
            maxb: $("maxInput").value,
        };
        sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
}

function restoreFilterState() {
    try {
        const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);

        if (s.item != null) {
            $("item").value = s.item;
            syncClearSearch();
        }
        if (s.q != null) {
            $("q").value = s.q;
        }

        // Restore cascading location dropdowns step-by-step so child options exist
        if (s.region && [...$("f-region").options].some(o => o.value === s.region)) {
            $("f-region").value = s.region;
            fillFilters();
        }
        if (s.province && [...$("f-province").options].some(o => o.value === s.province)) {
            $("f-province").value = s.province;
            fillFilters();
        }
        if (s.city && [...$("f-city").options].some(o => o.value === s.city)) {
            $("f-city").value = s.city;
            fillFilters();
        }

        if (s.category && [...$("f-category").options].some(o => o.value === s.category)) {
            $("f-category").value = s.category;
        }
        if (s.status && [...$("f-status").options].some(o => o.value === s.status)) {
            $("f-status").value = s.status;
        }

        if (typeof syncCustomSelect === "function") {
            Object.values(SEL).forEach(id => {
                if ($(id)) syncCustomSelect($(id));
            });
        }

        if (s.minb != null && s.maxb != null) {
            $("minb").value = s.minb;
            $("maxb").value = s.maxb;
            updatePriceRange("min", false);
        }

        // Sync agency × clear button if defined
        const clearAgencyBtn = $("clear-agency");
        if (clearAgencyBtn) {
            const hasAgency = $("q").value.trim() !== "";
            $("q").classList.toggle("has-value", hasAgency);
            clearAgencyBtn.hidden = !hasAgency;
        }

        countFilters();
    } catch (e) {}
}


const FILTERS_DATA_CACHE_KEY = "procurement-filters-data-v1";

function syncMapMode() {
    const mapMode = $("mapMode");
    if (!mapMode) return;
    const hasItem = Boolean($("item")?.value.trim());
    mapMode.innerHTML = hasItem
        ? '<span class="mode-kicker">View by:</span> Item'
        : '<span class="mode-kicker">View by:</span> Agency location';
}


// --- Price Range Slider Logic ---
const minSlider = $("minb");
const maxSlider = $("maxb");
const minInput = $("minInput");
const maxInput = $("maxInput");

function updatePriceRange(source, triggerRefresh = true) {
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
    if (triggerRefresh) later();
}

minSlider.addEventListener("input", () => updatePriceRange("min"));
maxSlider.addEventListener("input", () => updatePriceRange("max"));

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

function restoreInstantState() {
    try {
        const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);

        if (s.item != null) {
            $("item").value = s.item;
            syncClearSearch();
            syncMapMode();
        }
        if (s.q != null) {
            $("q").value = s.q;
            const clearAgencyBtn = $("clear-agency");
            if (clearAgencyBtn) {
                const hasAgency = $("q").value.trim() !== "";
                $("q").classList.toggle("has-value", hasAgency);
                clearAgencyBtn.hidden = !hasAgency;
            }
        }
        if (s.minb != null && s.maxb != null) {
            minSlider.value = s.minb;
            maxSlider.value = s.maxb;
            minInput.value = s.minb;
            maxInput.value = s.maxb;
            updatePriceRange("min", false);
        }
    } catch (e) {}
}

restoreInstantState();

// Hydrate immediately from cached /api/filters data if available (zero blank flash)
try {
    const cachedFiltersRaw = sessionStorage.getItem(FILTERS_DATA_CACHE_KEY);
    if (cachedFiltersRaw) {
        const cachedFilters = JSON.parse(cachedFiltersRaw);
        if (cachedFilters) {
            FILTERS = cachedFilters;
            fillFilters();
            restoreFilterState();
            if (cachedFilters.last_updated) {
                $("last-updated").textContent = cachedFilters.last_updated;
            }
        }
    }
} catch (e) {}

// Keep initial mode synced with restored search so initial refresh keeps DEFAULT_VIEW (same as Reset Zoom)
const initialItemQ = $("item").value.trim();
lastMode = initialItemQ ? "item:" + initialItemQ : "agency";
fitNext = false;

// Fetch fresh /api/filters in the background and sync
fetch("/api/filters").then(r => r.ok ? r.json() : null)
    .then(f => {
        if (f) {
            const prevSerialized = FILTERS ? JSON.stringify(FILTERS) : "";
            const nextSerialized = JSON.stringify(f);

            FILTERS = f;
            try { sessionStorage.setItem(FILTERS_DATA_CACHE_KEY, nextSerialized); } catch (e) {}

            if (prevSerialized !== nextSerialized) {
                fillFilters();
                restoreFilterState();
            }

            $("last-updated").textContent = f.last_updated || "Unknown Date";
        }
    })
    .catch(() => {
        if (!FILTERS) {
            $("last-updated").textContent = "Offline";
        }
    })
    .finally(refresh);

function updateDataDate() {
    const el = $("dataDate");
    if (!el) return;

    const today = new Date();
    el.textContent = new Intl.DateTimeFormat("en-PH", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "Asia/Manila"
    }).format(today);
}

updateDataDate();