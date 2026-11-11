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

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;


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

const refLine = (ref, right, text, awardId = null, awardee = null) => {
    const awardeeHtml = awardee ? `<div style="font-size: 11px; color: var(--muted, #64748b); margin-top: 4px; padding-left: 4px;"><strong>Supplier:</strong> ${esc(awardee)}</div>` : "";

    // Conditional rendering for the badge
    const badgeHtml = awardId 
        ? `<a href="https://philgeps.gov.ph/Indexes/viewAwardNotice/${esc(awardId)}" target="_blank" rel="noopener noreferrer" class="ref-link" title="Click to view full details">
             <span class="ref">${esc(awardId)} ↗</span>
           </a>`
        : `<span class="ref" style="cursor: help;" title="Bid Reference Number">${esc(ref)}</span>`;

    return `<li><div class="top">` +
    badgeHtml +
    `<span class="amt">${right}</span></div><div class="t">${text}</div>${awardeeHtml}</li>`;
};


// --- Data Fetching (Agencies & Items) ---
async function loadAgencies() {
    const params = filterParams(false);
    
    const res = await fetch("/api/pins?" + params);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    
    render(data,
        p => `<div class="pop"><h2>${esc(p.entities)}</h2><div class="addr">${esc(p.address)}</div>` +
             `<dl><dt>Contracts</dt><dd>${p.contracts}</dd>` +
             `<dt>Total budget</dt><dd>${peso(p.total_budget)}</dd></dl>` +
             `<ul class="refs" id="refs-${p.id}"><li class="more">Loading contracts...</li></ul></div>`,
async (p, marker) => {
    try {
        const r = await fetch(
            `/api/pins/${p.id}/contracts?limit=10&${filterParams(false)}`
        );

        if (!r.ok) {
            throw new Error(`HTTP ${r.status}`);
        }

        const rows = await r.json();

        // Get the currently open popup belonging to this marker
        const popupEl = marker.getPopup()?.getElement();
        if (!popupEl) return;

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

        const popupEl = marker.getPopup()?.getElement();
        const el = popupEl?.querySelector(`#refs-${p.id}`);

        if (el) {
            el.innerHTML =
                `<li class="more">Could not load contracts. Please try again.</li>`;
        }
    }
},

        p => `<li><button class="row" data-id="${p.id}"><span class="name">${esc(p.entities)}</span>` +
             `<span class="addr">${esc(p.address)}</span>` +
             `<span class="meta"><b>${p.contracts}</b> contracts, ${peso(p.total_budget)}</span></button></li>`,
        (a, b) => b.total_budget - a.total_budget
    );
    
    const n = data.features.length;
    $("status").innerHTML = n ? `<b>Overall Summary</b><br><span style="color:#64748b; font-size:12px">${n} location${n === 1 ? "" : "s"} found</span>`
        : "No agencies match. Clear a filter or adjust criteria.";
}

async function loadItems(itemQ) {
    const params = filterParams(true);

    params.set("min_budget", $("minInput").value);
    params.set("max_budget", $("maxInput").value);

    const res = await fetch(
        `/api/items/pins?q=${encodeURIComponent(itemQ)}&${params.toString()}`
    );
    if (!res.ok) { $("status").textContent = "Type at least 2 characters to search items."; return; }
    const data = await res.json();
    
    render(data,
        p => `<div class="pop"><h2>${esc(p.entities)}</h2><div class="addr">${esc(p.address)}</div>` +
             `<dl><dt>Matching items</dt><dd>${p.n_items}${p.total_qty ? ` (${num(p.total_qty)} units)` : ""}</dd>` +
             (p.n_comparable 
             ? (p.min_unit === p.max_unit 
                 ? `<dt>Per unit</dt><dd>${peso(p.min_unit)}</dd>`
                 : `<dt>Per unit</dt><dd>${peso(p.min_unit)} to ${peso(p.max_unit)}</dd><dt>Median</dt><dd>${peso(p.median_unit)}</dd>`)
             : `<dt>Per unit</dt><dd>Not Available</dd>`) + `</dl>` +
             `<ul class="refs" id="refs-${p.id}"><li class="more">Loading items...</li></ul>` +
             `<button class="btn" id="cmp-${p.id}" style="width:100%; margin-top:10px;">Add to comparison</button></div>`,
        async p => {
            const b = $(`cmp-${p.id}`);
            if (b) b.onclick = () => addCompare(p);
            const el = $(`refs-${p.id}`);
            try {
                const r = await fetch(`/api/items/compare?q=${encodeURIComponent(itemQ)}&a=${p.id}&b=0&${filterParams(true)}`);
                const d = r.ok ? await r.json() : null;
                const lines = d ? d.a.lines : [];
                el.innerHTML = lines.length
                    ? lines.slice(0, 10).map(l => // Add l.awardee at the very end
refLine(l.bid_ref, l.comparable ? peso(l.unit_budget) + " each" : (l.item_budget != null ? peso(l.item_budget) + " total" : "n/a"), `${esc(l.item)}, ${num(l.quantity)} ${esc(l.uom || "")}`, l.award_id, l.awardee
                      )).join("") + 
                      (lines.length > 10 ? `<li class="more">Showing 10 of ${lines.length} items</li>` : "")
                    : `<li class="more">No items to show.</li>`;
            } catch { el.innerHTML = `<li class="more">Could not load items.</li>`; }
        },
        p => `<li><button class="row" data-id="${p.id}"><span class="name">${esc(p.entities)}</span>` +
             `<span class="addr">${esc(p.address)}</span>` +
             `<span class="meta"><b>${p.n_items}</b> item${p.n_items === 1 ? "" : "s"}, ` +
             (p.n_comparable ? `median ${peso(p.median_unit)} per unit` : "no per-unit price") + `</span></button>` +
             `<button class="cmpbtn" data-id="${p.id}">Compare Location</button></li>`,
        (a, b) => (a.median_unit ?? Infinity) - (b.median_unit ?? Infinity)
    );
    
    const n = data.features.length;
    $("status").innerHTML = n
        ? `<b>Results for "${itemQ}"</b><br><span style="color:#64748b; font-size:12px">${n} location${n === 1 ? "" : "s"} found</span>` +
          (data.truncated ? "<br><small style='color:var(--hot)'>Results capped; try being more specific.</small>" : "")
        : `No purchases found for "${itemQ}".`;
}

async function refresh() {
    const itemQ = $("item").value.trim();
    const mode = itemQ ? "item:" + itemQ : "agency";
    if (mode !== lastMode) { fitNext = true; lastMode = mode; }
    try { 
        await (itemQ ? loadItems(itemQ) : loadAgencies()); 
    } catch { 
        $("status").textContent = "Could not reach the server. Check that it is running."; 
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
["q"].forEach(id => $(id).addEventListener("input", countFilters));
$("clearF").onclick = () => {
    Object.values(SEL).forEach(id => { $(id).value = ""; });
    $("q").value = ""; 
    // Reset Price range
    $("minInput").value = "1000"; $("maxInput").value = "10000000";
    $("minb").value = "1000"; $("maxb").value = "10000000";
    updatePriceRange("min");

    // reset the search item
    // $("item").value ="";
    
    if (FILTERS) fillFilters();
    countFilters(); 
    later();
};
if($("applyF")) $("applyF").addEventListener("click", refresh);

// Typeahead for Items
let sugTimer = null;
$("item").addEventListener("input", () => {
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

$("list").addEventListener("click", e => {
    const c = e.target.closest(".cmpbtn");
    if (c) return addCompare(props[c.dataset.id]);
    const r = e.target.closest(".row");
    if (r) focusLoc(+r.dataset.id);
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
    document.querySelectorAll(".cmpbtn").forEach(b => {
        const on = selected.some(s => String(s.id) === b.dataset.id);
        b.classList.toggle("on", on); b.textContent = on ? "Selected" : "Compare Location";
    });
}

function drawTray() {
    const t = $("tray");
    t.style.display = selected.length ? "flex" : "none";
    if (!selected.length) return;
    
    const text = selected.length === 2 
        ? `<span class="tray-agency" title="${esc(selected[0].entities)}"><b>${esc(selected[0].entities)}</b></span> <span class="vs">vs</span> <span class="tray-agency" title="${esc(selected[1].entities)}"><b>${esc(selected[1].entities)}</b></span>`
        : `<span class="tray-agency" title="${esc(selected[0].entities)}"><b>${esc(selected[0].entities)}</b></span> <span class="vs">...</span> <span style="color:#94a3b8; white-space:nowrap;">pick one more</span>`;

    const fullTitle = selected.map(s => s.entities).join(" vs ");

    t.innerHTML = `<div class="tray-text" title="${esc(fullTitle)}">${text}</div>` +
        `<button class="btn" id="goCmp" ${selected.length < 2 ? "disabled" : ""}>Compare</button>` +
        `<button class="btn tray-clr" id="clrCmp">Clear</button>`;
        
    $("clrCmp").onclick = () => { selected = []; drawTray(); markCompare(); };
    $("goCmp").onclick = showCompare;
}

async function showCompare() {
    const itemQ = $("item").value.trim();
    if (selected.length < 2 || !itemQ) return;
    
    const res = await fetch(`/api/items/compare?q=${encodeURIComponent(itemQ)}&a=${selected[0].id}&b=${selected[1].id}&${filterParams(true)}`);
    if (!res.ok) return;
    
    const d = await res.json(), A = d.a, B = d.b;
    const lo = (x, y) => (x != null && y != null && x < y) ? "cmp-cheaper" : "";
    
    const formatDate = (dateStr) => {
        if (!dateStr) return "";
        const d = new Date(dateStr);
        return isNaN(d) ? dateStr : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    };

const renderLines = (X) => X.lines.length
        ? `<div class="cmp-table-wrap"><table>
             <thead><tr><th>Item Details</th><th>Qty</th><th>Per Unit</th></tr></thead>
             <tbody>` +
             X.lines.slice(0, 10).map(l => `
               <tr>
                 <td>
                   <div class="cmp-item-title">${esc(l.item)}</div>
                   <!-- Awardee tag added right below the title -->
                   ${l.awardee ? `<div style="font-size: 11px; color: var(--muted, #64748b); margin-top: 4px;"><strong>Supplier:</strong> ${esc(l.awardee)}</div>` : ""}
                   <div class="cmp-meta-badges">
                     ${l.award_id 
                       ? `<a href="https://philgeps.gov.ph/Indexes/viewAwardNotice/${esc(l.award_id)}" target="_blank" rel="noopener noreferrer" class="ref-link" title="Click to view full details">
                            <span class="ref">${esc(l.award_id)} ↗</span>
                          </a>` 
                       : `<span class="ref" style="cursor: help;" title="Bid Reference Number">${esc(l.bid_ref)}</span>`
                     }
                     ${l.status ? `<span class="cmp-status-badge">${esc(l.status)}</span>` : ""}
                     ${l.published ? `<span class="cmp-date">${formatDate(l.published)}</span>` : ""}
                   </div>
                 </td>
                 <td class="num">${num(l.quantity)} ${esc(l.uom || "")}</td>
                 <td class="num font-semibold">${l.comparable ? peso(l.unit_budget) : (l.item_budget != null ? peso(l.item_budget): "n/a")}</td>
               </tr>`).join("") +
             `</tbody></table></div>`
        : `<p class="cmp-empty">No matching contract line items found.</p>`;

    const c = $("cmp");
    c.hidden = false;
    c.innerHTML = `
        <div class="cmp-header">
            <div style="flex: 0 0 80%;">
                <h2>Price Benchmark Comparison</h2>
                <p class="cmp-subtitle">For: "${esc(itemQ)}"</p>
            </div>
            <button class="btn ghost" id="closeCmp" style="flex: 0 0 20%; width: auto;">Close</button>
        </div>

        <div class="cmp-grid">
            <!-- Location A Card -->
            <div class="cmp-card">
                <h3>${esc(A.entities.join("; ") || "Location A")}</h3>
                <p class="cmp-address">${esc(A.address || "No address listed")}</p>
                <div class="cmp-stats">
                    <div class="stat-row"><span>Items Found</span> <b>${num(A.n_items)}</b></div>
                    <div class="stat-row"><span>Lowest Unit</span> <b class="${lo(A.min_unit, B.min_unit)}">${peso(A.min_unit)}</b></div>
                    <div class="stat-row"><span>Median Unit</span> <b class="${lo(A.median_unit, B.median_unit)}">${peso(A.median_unit)}</b></div>
                    <div class="stat-row"><span>Highest Unit</span> <b class="${lo(A.max_unit, B.max_unit)}">${peso(A.max_unit)}</b></div>
                </div>
                <h4 class="cmp-section-title">Recent Contract Entries</h4>
                ${renderLines(A)}
            </div>

            <!-- Location B Card -->
            <div class="cmp-card">
                <h3>${esc(B.entities.join("; ") || "Location B")}</h3>
                <p class="cmp-address">${esc(B.address || "No address listed")}</p>
                <div class="cmp-stats">
                    <div class="stat-row"><span>Items Found</span> <b>${num(B.n_items)}</b></div>
                    <div class="stat-row"><span>Lowest Unit</span> <b class="${lo(B.min_unit, A.min_unit)}">${peso(B.min_unit)}</b></div>
                    <div class="stat-row"><span>Median Unit</span> <b class="${lo(B.median_unit, A.median_unit)}">${peso(B.median_unit)}</b></div>
                    <div class="stat-row"><span>Highest Unit</span> <b class="${lo(B.max_unit, A.max_unit)}">${peso(B.max_unit)}</b></div>
                </div>
                <h4 class="cmp-section-title">Recent Contract Entries</h4>
                ${renderLines(B)}
            </div>
        </div>
        
        <p class="cmp-note">Note: Per-unit prices reflect approved agency budget allocations divided by quantity, not final payouts.</p>
    `;

    $("closeCmp").focus();
    $("closeCmp").onclick = () => { c.hidden = true; };
}

document.addEventListener("keydown", e => { if (e.key === "Escape") $("cmp").hidden = true; });


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