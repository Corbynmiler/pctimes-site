// Chaser — the "needs sending today" view + full roster spreadsheet.
// Phase 1: review and copy. The Send button copies the email to the clipboard
// and flips status to "chased" when Leanne confirms it was sent. No SMTP yet.
//
// Reads : /admin-data/roster.json   (built by Eleventy from YAML)
// Writes: GitHub Contents API using the editor's Sveltia OAuth token.

/* global jsyaml */

// ─── Config ────────────────────────────────────────────────────────────
const REPO = "Corbynmiler/pctimes-site";
const BRANCH = "main";
const DATA_URL = "/admin-data/roster.json";
const TZ = "Pacific/Auckland";
const EDIT_DRAFT_KEY = "pct-chaser-draft-edits-v1";
const SHEET_FILTER_KEY = "pct-chaser-sheet-filter-v1";
const TAB_KEY = "pct-chaser-tab-v1";

// ─── Date helpers ──────────────────────────────────────────────────────
const monthShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLong  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const dayLong    = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function todayISONZ() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function parseISO(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

function daysBetween(aISO, bISO) {
  const a = parseISO(aISO), b = parseISO(bISO);
  if (!a || !b) return null;
  const au = Date.UTC(a.year, a.month - 1, a.day);
  const bu = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bu - au) / 86400000);
}

function weekdayOf(iso) {
  const p = parseISO(iso);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function fmtLong(iso) {
  const p = parseISO(iso);
  if (!p) return iso || "";
  return `${dayLong[weekdayOf(iso)]} ${p.day} ${monthLong[p.month - 1]}`;
}
function fmtShort(iso) {
  const p = parseISO(iso);
  if (!p) return iso || "";
  return `${p.day} ${monthShort[p.month - 1]}`;
}

// ─── Status labels ─────────────────────────────────────────────────────
const STATUS_LABEL = {
  pending: "Pending",
  draft_ready: "Draft ready",
  chased: "Chased",
  followed_up: "Followed up",
  received: "Received",
  not_supplying: "Not supplying",
  skipped: "Skipped",
  overdue: "Overdue",
  self: "Self-written",
};

const DONE_STATUSES = new Set(["received", "not_supplying", "skipped"]);
const ACTIVE_STATUSES = new Set(["pending", "draft_ready", "chased", "followed_up"]);

// ─── Template rendering (deterministic) ────────────────────────────────
function renderTemplate(tpl, vars) {
  const r = (s) => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  return { subject: r(tpl.subject), body: r(tpl.body) };
}

// ─── Auth: reuse the Sveltia GitHub OAuth token ───────────────────────
function getAuth() {
  const candidates = ["sveltia-cms.user", "decap-cms-user", "netlify-cms-user"];
  for (const key of candidates) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (user && user.token) {
        return { token: user.token, login: user.login || user.name || "editor" };
      }
    } catch { /* ignore malformed */ }
  }
  return null;
}

// ─── GitHub API ────────────────────────────────────────────────────────
async function ghGet(path, token) {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = decodeURIComponent(escape(atob(json.content.replace(/\s/g, ""))));
  return { sha: json.sha, content };
}
async function ghPut(path, { content, sha, message, token }) {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    sha, branch: BRANCH,
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── State ─────────────────────────────────────────────────────────────
const state = {
  auth: null,
  data: null,
  tab: readLS(TAB_KEY, "chaser"), // chaser | roster
  editedDrafts: readLS(EDIT_DRAFT_KEY, {}),
  sheetFilter: readLS(SHEET_FILTER_KEY, "upcoming"), // upcoming | all | done | missing
  sheetSearch: "",
  savingContrib: null, // key being saved, for optimistic UI
};
function readLS(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* noop */ } }
function slotKey(rosterKey, slot) { return `${rosterKey}:${slot.issue_date}`; }

// ─── Boot ──────────────────────────────────────────────────────────────
async function boot() {
  state.auth = getAuth();
  renderWhoAmI();
  renderBanner();
  wireTabs();
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load roster data (${res.status})`);
    state.data = await res.json();
  } catch (e) {
    document.getElementById("content").innerHTML =
      `<div class="section__empty" style="color:var(--red-dark)">Could not load /admin-data/roster.json: ${escapeHtml(e.message)}</div>`;
    return;
  }
  render();
}

function wireTabs() {
  document.querySelectorAll(".shell__tab").forEach((btn) => {
    btn.setAttribute("aria-selected", btn.dataset.tab === state.tab ? "true" : "false");
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      writeLS(TAB_KEY, state.tab);
      document.querySelectorAll(".shell__tab").forEach((b) =>
        b.setAttribute("aria-selected", b.dataset.tab === state.tab ? "true" : "false"));
      render();
    });
  });
}

function renderWhoAmI() {
  const el = document.getElementById("whoami");
  if (!el) return;
  el.textContent = state.auth ? `Signed in as ${state.auth.login}` : "Not signed in";
}

function renderBanner() {
  const b = document.getElementById("banner");
  if (!b) return;
  if (state.auth) {
    b.innerHTML = `<strong>Phase 1</strong> — nothing sends automatically. The <em>Send</em> button copies the email to your clipboard and marks the slot as chased when you confirm.`;
    b.hidden = false;
  } else {
    b.innerHTML = `You're not signed in. Open <a href="/admin/">the admin</a>, sign in with GitHub, then come back here.`;
    b.hidden = false;
  }
}

// ─── Render orchestration ──────────────────────────────────────────────
function render() {
  const root = document.getElementById("content");
  root.innerHTML = "";
  if (!state.data || !state.data.rosters) {
    root.innerHTML = `<p class="loading">No roster data.</p>`;
    return;
  }
  const today = todayISONZ();
  const buckets = bucketise(today);

  if (state.tab === "chaser") {
    root.append(
      sectionNeedsSending(buckets.drafts),
      sectionNotes(),
    );
  } else if (state.tab === "roster") {
    root.append(
      sectionSheet(buckets.all),
      sectionNotes(),
    );
  } else if (state.tab === "crossword") {
    root.append(sectionCrossword());
  }
}

function bucketise(today) {
  const drafts = [];
  const waitingOnEmail = [];
  const all = [];

  for (const roster of state.data.rosters) {
    const byKey = Object.fromEntries((roster.contributors || []).map((c) => [c.key, c]));
    const lead = roster.default_lead_days ?? 10;

    for (const slot of roster.slots || []) {
      const contrib = byKey[slot.contributor_key] || {
        organisation: slot.contributor_key, display_name: "(unknown)", email: "", self_authored: false,
      };
      const dueDays = daysBetween(today, slot.due_date);
      const issueDays = daysBetween(today, slot.issue_date);
      const row = { roster, slot, contrib, dueDays, issueDays };

      // Row state for tinting
      row.state = computeState(row);
      all.push(row);

      // Draft candidates
      const actionable = ACTIVE_STATUSES.has(slot.status);
      const inWindow = actionable && !contrib.self_authored
        && dueDays != null && dueDays <= lead && dueDays >= -3
        && issueDays != null && issueDays >= -1;

      if (inWindow) {
        const tplKey = pickTemplate(roster, slot);
        const tpl = state.data.chase_templates?.[tplKey];
        if (tpl) {
          const rendered = renderTemplate(tpl, {
            display_name: contrib.display_name || contrib.organisation,
            organisation: contrib.organisation,
            due_date_long: fmtLong(slot.due_date),
            due_date_short: fmtShort(slot.due_date),
            issue_date_long: fmtLong(slot.issue_date),
            issue_date_short: fmtShort(slot.issue_date),
          });
          const editKey = slotKey(roster.key, slot) + ":" + tplKey;
          const edited = state.editedDrafts[editKey];
          const draft = {
            ...row,
            tplKey,
            editKey,
            subject: edited?.subject ?? rendered.subject,
            body: edited?.body ?? rendered.body,
            isEdited: !!edited,
          };
          if (contrib.email) drafts.push(draft);
          else waitingOnEmail.push(draft);
        }
      }
    }
  }

  const byDate = (a, b) => (a.slot.issue_date || "").localeCompare(b.slot.issue_date || "");
  drafts.sort(byDate);
  waitingOnEmail.sort(byDate);
  all.sort(byDate);
  return { drafts, waitingOnEmail, all };
}

function pickTemplate(roster, slot) {
  const base = roster.template_key || roster.key;
  const alreadyChased = (slot.chase_log || []).some((e) => e.template && e.template.endsWith("_first"));
  return alreadyChased || slot.status === "chased" ? `${base}_followup` : `${base}_first`;
}

function computeState(row) {
  const s = row.slot.status;
  if (DONE_STATUSES.has(s)) return "done";
  if (row.contrib.self_authored) return "self";
  if (!row.contrib.email) return "missing";
  if (row.dueDays != null && row.dueDays < 0 && ACTIVE_STATUSES.has(s)) return "overdue";
  if (row.dueDays != null && row.dueDays <= 7 && row.dueDays >= 0 && ACTIVE_STATUSES.has(s)) return "due";
  return "normal";
}

// ─── Section: Needs sending this week ──────────────────────────────────
function sectionNeedsSending(items) {
  const sec = el("section", { class: "section" });
  // Most urgent first: overdue slots climb to the top, then by closest due date.
  const sorted = items.slice().sort((a, b) => (a.dueDays ?? 999) - (b.dueDays ?? 999));
  sec.append(sectionHead("Needs sending this week", sorted.length,
    "Chases that need to go out. Review, press Send to copy to your clipboard, then paste into email."));
  if (sorted.length === 0) {
    sec.append(el("div", { class: "section__empty" }, "Nothing to chase this week. Nice."));
    return sec;
  }
  const stack = el("div", { class: "draft-stack" });
  for (const d of sorted) stack.append(sendDraftCard(d));
  sec.append(stack);
  return sec;
}

function sendDraftCard(d) {
  const art = el("article", { class: "draft" });
  const head = el("header", { class: "draft__head" });
  const meta = el("div", { class: "draft__meta" },
    el("span", { class: "pill pill--roster" }, d.roster.label),
    "To:",
    el("strong", { class: "draft__to" }, d.contrib.display_name || d.contrib.organisation),
    el("span", { class: "muted draft__email" }, d.contrib.email),
    el("span", { class: "badge", "data-status": d.dueDays < 0 ? "overdue" : "pending" },
      d.dueDays === 0 ? "due today" : d.dueDays > 0 ? `due in ${d.dueDays}d` : `${-d.dueDays}d overdue`),
  );
  head.append(meta, el("div", { class: "draft__subject" }, d.subject));
  art.append(head);

  const ta = el("textarea", { class: "draft__textarea", rows: "7", spellcheck: "true" });
  ta.value = d.body;
  ta.addEventListener("input", () => {
    state.editedDrafts[d.editKey] = { subject: d.subject, body: ta.value };
    writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
  });
  art.append(ta);

  const actions = el("footer", { class: "draft__actions" });
  actions.append(btn("📋 Send (copy to clipboard) & mark as chased", "btn--primary", () => sendDraft(d, ta.value)));
  actions.append(btn("Open in email client", "btn btn--ghost", () => {
    const href = `mailto:${encodeURIComponent(d.contrib.email)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(ta.value)}`;
    window.location.href = href;
  }));
  if (d.isEdited) {
    actions.append(btn("Reset to template", "btn", () => {
      delete state.editedDrafts[d.editKey];
      writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
      render();
    }));
  }
  actions.append(btn("Skip this cycle", "btn btn--danger-ghost btn--small", () => {
    if (confirm(`Skip ${d.contrib.organisation}'s chase for ${fmtShort(d.slot.issue_date)}? (The slot stays, no chase goes out.)`)) {
      updateSlotStatus(d.roster.key, d.slot, "skipped", `Skipped from chaser on ${todayISONZ()}`);
    }
  }));
  art.append(actions);
  return art;
}

async function sendDraft(d, bodyText) {
  const text = `Subject: ${d.subject}\n\nTo: ${d.contrib.email}\n\n${bodyText}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast("Couldn't access clipboard — select the text manually.", true);
    return;
  }
  toast(`Copied — paste into an email to ${d.contrib.email}`);
  if (!state.auth) {
    toast("Note: not signed in, so I can't mark it as chased. Sign into /admin/ first for that.", true);
    return;
  }
  await mutateRoster(d.roster.key, (r) => {
    const idx = r.slots.findIndex((s) => s.issue_date === d.slot.issue_date && s.contributor_key === d.slot.contributor_key);
    if (idx === -1) throw new Error("Slot not found");
    const slot = r.slots[idx];
    slot.status = slot.status === "chased" ? "followed_up" : "chased";
    slot.chase_log = slot.chase_log || [];
    slot.chase_log.push({
      at: new Date().toISOString(),
      by: state.auth.login,
      channel: "manual_copy",
      template: d.tplKey,
      subject: d.subject,
      body: bodyText,
    });
    return `chore(roster): chase sent — ${d.contrib.organisation} (${d.slot.issue_date})`;
  });
  delete state.editedDrafts[d.editKey];
  writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
}

// ─── Section: Spreadsheet (per-roster tables) ─────────────────────────
function sectionSheet(rows) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Rosters", rows.length,
    "Each roster is kept separate, like Leanne's spreadsheets. Click the yellow 'add' cells to type in emails — they save automatically."));

  // Filters (apply to both tables)
  const bar = el("div", { class: "filters" });
  const FILTERS = [
    { key: "upcoming", label: "Upcoming + active" },
    { key: "missing", label: "Needs email" },
    { key: "done", label: "Done & cancelled" },
    { key: "all", label: "All" },
  ];
  for (const f of FILTERS) {
    const c = el("button", {
      class: "filters__chip",
      "aria-pressed": state.sheetFilter === f.key ? "true" : "false",
    }, f.label);
    c.addEventListener("click", () => {
      state.sheetFilter = f.key;
      writeLS(SHEET_FILTER_KEY, f.key);
      render();
    });
    bar.append(c);
  }
  const search = el("input", {
    class: "filters__search",
    type: "search",
    placeholder: "Search organisation, contact or email…",
  });
  search.value = state.sheetSearch;
  search.addEventListener("input", (e) => {
    state.sheetSearch = e.target.value.toLowerCase();
    render();
  });
  bar.append(search);
  sec.append(bar);

  // Partition by roster
  const byRoster = new Map();
  for (const r of state.data.rosters) byRoster.set(r.key, { roster: r, rows: [] });
  for (const row of rows) {
    const bucket = byRoster.get(row.roster.key);
    if (!bucket) continue;
    // Apply filters
    const s = row.slot.status;
    const inUpcoming = ACTIVE_STATUSES.has(s) && row.issueDays != null && row.issueDays >= -14;
    if (state.sheetFilter === "upcoming" && !inUpcoming) continue;
    if (state.sheetFilter === "done" && !DONE_STATUSES.has(s)) continue;
    if (state.sheetFilter === "missing" && !(ACTIVE_STATUSES.has(s) && !row.contrib.email && !row.contrib.self_authored)) continue;
    if (state.sheetSearch) {
      const hay = `${row.contrib.organisation} ${row.contrib.display_name} ${row.contrib.email}`.toLowerCase();
      if (!hay.includes(state.sheetSearch)) continue;
    }
    bucket.rows.push(row);
  }

  // Render one table per roster
  for (const { roster, rows: list } of byRoster.values()) {
    const block = el("div", { class: "roster-block" });
    const head = el("div", { class: "roster-block__head" });
    head.append(
      el("h3", { class: "roster-block__title" }, roster.label),
      el("span", { class: "muted" }, `${list.length} shown`),
      el("div", { class: "roster-block__actions" },
        btn("+ Add slot", "btn--small btn--ghost", () => showAddSlotForm(block, roster)),
        btn("+ Add contributor", "btn--small btn--ghost", () => showAddContributorForm(block, roster)),
      ),
    );
    block.append(head);

    if (list.length === 0) {
      block.append(el("div", { class: "section__empty" },
        roster.slots && roster.slots.length === 0
          ? "No slots in this roster yet."
          : "No slots match the current filter."));
    } else {
      const wrap = el("div", { class: "sheet-wrap" });
      const table = el("table", { class: "sheet" });
      const thead = el("thead");
      thead.append(el("tr", {},
        el("th", {}, "Dates"),
        el("th", {}, "Organisation / contact"),
        el("th", {}, "Email"),
        el("th", {}, "Status"),
        el("th", {}, "Timing"),
        el("th", { style: "text-align:right" }, "Actions"),
      ));
      table.append(thead);
      const tbody = el("tbody");
      for (const row of list.slice(0, 100)) tbody.append(sheetRow(row));
      table.append(tbody);
      wrap.append(table);
      block.append(wrap);
      if (list.length > 100) block.append(el("p", { class: "muted" }, `Showing first 100 of ${list.length}.`));
    }
    sec.append(block);
  }

  return sec;
}

function sheetRow(row) {
  const tr = el("tr", { class: `row row--${row.state}` });

  // Dates
  const dates = el("td", { class: "col-dates" });
  dates.append(
    el("div", { class: "col-dates__due" }, `Due ${fmtShort(row.slot.due_date)}`),
    el("div", { class: "col-dates__pub" }, `Issue ${fmtShort(row.slot.issue_date)}`),
  );

  // Org / contact
  const org = el("td", { class: "col-org" });
  org.append(
    el("strong", { class: "col-org__name" }, row.contrib.organisation),
    el("div", { class: "col-org__contact" }, row.contrib.display_name || ""),
  );

  // Email — inline editable
  const email = emailCell(row);

  // Status
  const statusVal = row.state === "overdue" ? "overdue"
    : row.contrib.self_authored ? "self" : row.slot.status;
  const status = el("td", { class: "col-status" },
    el("span", { class: "badge", "data-status": statusVal }, STATUS_LABEL[statusVal] || statusVal));

  // Timing
  const timing = el("td", { class: "col-timing" }, (() => {
    const s = row.slot.status;
    if (s === "received") return "received";
    if (s === "not_supplying") return "cancelled";
    if (s === "skipped") return "skipped";
    if (row.contrib.self_authored) return "no chase needed";
    if (row.dueDays == null) return "";
    if (row.dueDays === 0) return "due today";
    return row.dueDays > 0 ? `due in ${row.dueDays}d` : `${-row.dueDays}d overdue`;
  })());

  // Actions
  const actions = el("td", { class: "col-actions" });
  if (!DONE_STATUSES.has(row.slot.status)) {
    actions.append(
      btn("Received", "btn--small btn--primary", () =>
        updateSlotStatus(row.roster.key, row.slot, "received", `Received on ${todayISONZ()}`)),
      " ",
      btn("Not supplying", "btn--small btn--danger-ghost", () => {
        if (confirm(`Mark ${row.contrib.organisation} as not supplying for ${fmtShort(row.slot.issue_date)}?`)) {
          updateSlotStatus(row.roster.key, row.slot, "not_supplying", `Not supplying this cycle (${todayISONZ()})`);
        }
      }),
    );
  } else {
    actions.append(btn("Reopen", "btn--small btn--ghost", () =>
      updateSlotStatus(row.roster.key, row.slot, "pending", `Reopened on ${todayISONZ()}`)));
  }

  tr.append(dates, org, email, status, timing, actions);
  return tr;
}

// ─── Inline add: contributor + slot ────────────────────────────────────
function slugify(s) {
  return String(s || "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function showAddContributorForm(block, roster) {
  // Replace any existing add-form in this block
  const existing = block.querySelector(".roster-block__addform");
  if (existing) existing.remove();

  const form = el("form", { class: "roster-block__addform" });
  form.append(
    el("div", { class: "addform__title" }, `+ New contributor for ${roster.label}`),
    inputField("Organisation", "organisation", "text", true),
    inputField("Contact name (optional)", "display_name", "text", false),
    inputField("Email (optional — you can add later)", "email", "email", false),
    checkField("Self-written (never chase, e.g. Leanne writes it herself)", "self_authored"),
  );
  const actions = el("div", { class: "addform__actions" });
  actions.append(
    btn("Save", "btn--primary", (ev) => { ev.preventDefault(); handleAddContributor(form, roster, block); }),
    btn("Cancel", "btn btn--ghost", (ev) => { ev.preventDefault(); form.remove(); }),
  );
  form.append(actions);
  form.addEventListener("submit", (ev) => { ev.preventDefault(); handleAddContributor(form, roster, block); });
  block.querySelector(".roster-block__head").after(form);
  form.querySelector('input[name="organisation"]').focus();
}

async function handleAddContributor(form, roster, block) {
  const data = Object.fromEntries(new FormData(form));
  const organisation = (data.organisation || "").trim();
  if (!organisation) { toast("Organisation is required.", true); return; }
  if (!state.auth) { toast("Sign into /admin/ first.", true); return; }

  let key = slugify(organisation);
  // Ensure uniqueness
  const existingKeys = new Set((roster.contributors || []).map((c) => c.key));
  if (existingKeys.has(key)) {
    let i = 2;
    while (existingKeys.has(`${key}_${i}`)) i++;
    key = `${key}_${i}`;
  }

  try {
    await mutateRoster(roster.key, (r) => {
      r.contributors = r.contributors || [];
      r.contributors.push({
        key,
        organisation,
        display_name: (data.display_name || "").trim(),
        email: (data.email || "").trim(),
        self_authored: !!data.self_authored,
        notes: "",
      });
      return `chore(roster): add contributor ${organisation} to ${roster.label}`;
    });
    toast(`Added ${organisation}.`);
    form.remove();
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
}

function showAddSlotForm(block, roster) {
  const existing = block.querySelector(".roster-block__addform");
  if (existing) existing.remove();

  const contribs = (roster.contributors || []).slice().sort((a, b) => a.organisation.localeCompare(b.organisation));
  const form = el("form", { class: "roster-block__addform" });
  form.append(
    el("div", { class: "addform__title" }, `+ New slot for ${roster.label}`),
    inputField("Issue date (Friday it's published, YYYY-MM-DD)", "issue_date", "date", true),
    inputField("Due date (when copy is needed, YYYY-MM-DD)", "due_date", "date", true),
    (() => {
      const wrap = el("label", { class: "addform__row" });
      wrap.append(el("span", {}, "Contributor"));
      const sel = el("select", { name: "contributor_key", required: true });
      sel.append(el("option", { value: "" }, "— pick a contributor —"));
      for (const c of contribs) {
        sel.append(el("option", { value: c.key }, `${c.organisation}${c.display_name ? ' · ' + c.display_name : ''}`));
      }
      wrap.append(sel);
      return wrap;
    })(),
  );
  const actions = el("div", { class: "addform__actions" });
  actions.append(
    btn("Save", "btn--primary", (ev) => { ev.preventDefault(); handleAddSlot(form, roster, block); }),
    btn("Cancel", "btn btn--ghost", (ev) => { ev.preventDefault(); form.remove(); }),
  );
  form.append(actions);
  form.addEventListener("submit", (ev) => { ev.preventDefault(); handleAddSlot(form, roster, block); });
  block.querySelector(".roster-block__head").after(form);
  form.querySelector('input[name="issue_date"]').focus();
}

async function handleAddSlot(form, roster, block) {
  const data = Object.fromEntries(new FormData(form));
  if (!data.issue_date || !data.due_date || !data.contributor_key) { toast("Fill all fields.", true); return; }
  if (!state.auth) { toast("Sign into /admin/ first.", true); return; }
  try {
    await mutateRoster(roster.key, (r) => {
      r.slots = r.slots || [];
      r.slots.push({
        issue_date: data.issue_date,
        due_date: data.due_date,
        contributor_key: data.contributor_key,
        status: "pending",
        notes: "",
        chase_log: [],
      });
      r.slots.sort((a, b) => (a.issue_date || "").localeCompare(b.issue_date || ""));
      return `chore(roster): add slot ${data.issue_date} (${data.contributor_key}) to ${roster.label}`;
    });
    toast(`Added slot for ${fmtShort(data.issue_date)}.`);
    form.remove();
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
}

function inputField(label, name, type, required) {
  const wrap = el("label", { class: "addform__row" });
  wrap.append(el("span", {}, label));
  const inp = el("input", { type, name, required: required ? "" : null });
  wrap.append(inp);
  return wrap;
}

function checkField(label, name) {
  const wrap = el("label", { class: "addform__row addform__row--check" });
  const inp = el("input", { type: "checkbox", name });
  wrap.append(inp, " ", el("span", {}, label));
  return wrap;
}

// ─── Inline email editing ──────────────────────────────────────────────
function emailCell(row) {
  const td = el("td", { class: "col-email" + (row.contrib.email ? "" : " col-email--missing") });
  if (row.contrib.self_authored) {
    td.textContent = "self-written";
    return td;
  }
  const current = row.contrib.email || "";
  const input = el("input", {
    class: "col-email__input",
    type: "email",
    value: current,
    placeholder: "add email…",
    "aria-label": `Email for ${row.contrib.organisation}`,
  });
  if (!state.auth) {
    input.disabled = true;
    input.title = "Sign in via /admin/ to edit";
  }
  let saved = current;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = saved; input.blur(); }
  });
  input.addEventListener("blur", async () => {
    const v = input.value.trim();
    if (v === saved) return;
    if (!state.auth) { input.value = saved; toast("Sign into /admin/ first.", true); return; }
    const saving = el("span", { class: "col-email__saving" }, "saving…");
    td.append(saving);
    input.disabled = true;
    try {
      await updateContributorEmail(row.roster.key, row.contrib.key, v);
      saved = v;
      toast(`Saved email for ${row.contrib.organisation}`);
      // render() will replace the row with fresh data; this cell will be rebuilt.
    } catch (e) {
      input.value = saved;
      toast(`Save failed: ${e.message}`, true);
    } finally {
      input.disabled = false;
      saving.remove();
    }
  });
  td.append(input);
  return td;
}

async function updateContributorEmail(rosterKey, contributorKey, newEmail) {
  await mutateRoster(rosterKey, (r) => {
    const c = (r.contributors || []).find((c) => c.key === contributorKey);
    if (!c) throw new Error(`contributor ${contributorKey} not found`);
    c.email = newEmail;
    return `chore(roster): update email for ${c.organisation || contributorKey}`;
  });
}

// ─── Section: Crossword examples (scaffold for AI generation pipeline) ─
// Two hand-crafted example puzzles so Leanne can judge the format before
// we wire up the real pipeline (classical grid filler + LLM clues, see
// research notes). Everything here is static today — no generation yet.
const EXAMPLE_PUZZLES = [
  {
    key: "classic",
    title: "Example 1 — general knowledge",
    subtitle: "Standard 13×13 'quick' crossword. This uses the exact clue set from the Team Brie / Ray White puzzle Aunty L sent — just to show what the AI would output in your current style.",
    size: 13,
    // Symmetric (180°) grid. '#' = black, '.' = white.
    rows: [
      "###..........",
      "###.#.#.#.#.#",
      ".............",
      ".#.#.#...#.#.",
      "....#...#....",
      ".#...##...#.#",
      "..#.....#..##",
      "#.#...##...#.",
      "....#...#....",
      ".#.#...#.#.#.",
      ".............",
      "#.#.#.#.#.###",
      "..........###",
    ],
    across: [
      { n: 1, clue: "Star watcher", len: 10 },
      { n: 8, clue: "Follow orders", len: 4 },
      { n: 9, clue: "Mixed collection", len: 10 },
      { n: 10, clue: "Eager and attentive", len: 4 },
      { n: 11, clue: "Thin layer", len: 6 },
      { n: 13, clue: "Arab ruler", len: 4 },
      { n: 14, clue: "Proof", len: 8 },
      { n: 18, clue: "Short musical drama", len: 8 },
      { n: 23, clue: "Without", len: 4 },
      { n: 25, clue: "Verse", len: 6 },
      { n: 26, clue: "Musical symbol", len: 4 },
      { n: 27, clue: "Play down", len: 10 },
      { n: 28, clue: "Boast", len: 4 },
      { n: 29, clue: "In all places", len: 10 },
    ],
    down: [
      { n: 2, clue: "Method", len: 6 },
      { n: 3, clue: "Person involved in rowdy disturbance", len: 6 },
      { n: 4, clue: "Character", len: 6 },
      { n: 5, clue: "Breakfast food", len: 6 },
      { n: 6, clue: "Turn", len: 6 },
      { n: 7, clue: "Valiant", len: 6 },
      { n: 11, clue: "Blocking vote", len: 4 },
      { n: 12, clue: "Pleasing", len: 4 },
      { n: 15, clue: "Tank", len: 3 },
      { n: 16, clue: "Leavened Indian bread", len: 4 },
      { n: 17, clue: "Compass point", len: 4 },
      { n: 19, clue: "Meagre (amount)", len: 6 },
      { n: 20, clue: "Place of safety", len: 6 },
      { n: 21, clue: "Walk unsteadily", len: 6 },
      { n: 22, clue: "Off the correct path", len: 6 },
      { n: 23, clue: "Inform", len: 6 },
      { n: 24, clue: "Castrate", len: 6 },
    ],
  },
  {
    key: "standard",
    title: "Example 2 — standard quick crossword",
    subtitle: "A plain non-themed 13×13 — this is the sort of thing you'd see every week, no gimmicks. Mix of easy and medium clues.",
    size: 13,
    rows: [
      ".....#.......",
      ".#.#.#.#.#.#.",
      ".............",
      ".#.#.#...#.#.",
      "....#.....#..",
      ".#...#.#.....",
      "...#.......#.",
      ".....#.#...#.",
      "..#.....#....",
      ".#.#...#.#.#.",
      ".............",
      ".#.#.#.#.#.#.",
      ".......#.....",
    ],
    across: [
      { n: 1, clue: "Soldier's room at the barracks", len: 5 },
      { n: 5, clue: "Opposite of west", len: 7 },
      { n: 10, clue: "Heavy book", len: 4 },
      { n: 11, clue: "Second-hand", len: 4 },
      { n: 12, clue: "Walked briskly", len: 8 },
      { n: 14, clue: "Trumpeting ocean mammal", len: 8 },
      { n: 15, clue: "What a sail catches", len: 4 },
      { n: 17, clue: "Alternative to coffee", len: 3 },
      { n: 18, clue: "Freshwater fish, often smoked", len: 6 },
      { n: 20, clue: "Common house pet", len: 3 },
      { n: 23, clue: "Oven for drying hops", len: 4 },
      { n: 25, clue: "Of the stars (adj.)", len: 7 },
      { n: 27, clue: "Garden tool for levelling soil", len: 4 },
      { n: 28, clue: "Hidden treasure, as from pirates", len: 5 },
    ],
    down: [
      { n: 1, clue: "Light meal between main meals", len: 5 },
      { n: 2, clue: "French for 'yes'", len: 3 },
      { n: 3, clue: "Flat-topped Spanish hat", len: 7 },
      { n: 4, clue: "Hole punched in a belt", len: 6 },
      { n: 6, clue: "At this moment", len: 3 },
      { n: 7, clue: "Formal dance", len: 4 },
      { n: 8, clue: "Yearly", len: 6 },
      { n: 9, clue: "Opera solo", len: 4 },
      { n: 13, clue: "Opposite of empty", len: 4 },
      { n: 16, clue: "Not often found", len: 4 },
      { n: 19, clue: "Mountain in Greek myth, home of the gods", len: 7 },
      { n: 21, clue: "Make amends", len: 5 },
      { n: 22, clue: "Pitched tent camp", len: 6 },
      { n: 24, clue: "Needle hole", len: 3 },
      { n: 26, clue: "Baby's bed", len: 3 },
    ],
  },
  {
    key: "coastal",
    title: "Example 3 — themed, local flavour",
    subtitle: "A smaller 11×11 with a Pōhutukawa Coast theme. Shows how we can add weekly themes (summer, school holidays, local events) on top of the standard quick-crossword format.",
    size: 11,
    rows: [
      "..#.......#",
      ".##.#.#.##.",
      "...........",
      "#.#.##.#.#.",
      ".....#.....",
      "..#.....#..",
      ".....#.....",
      ".#.#.##.#.#",
      "...........",
      ".##.#.#.##.",
      "#.......#..",
    ],
    across: [
      { n: 1, clue: "Big red bloom seen on the Coast at Christmas", len: 10 },
      { n: 10, clue: "Boat place with pontoons", len: 6 },
      { n: 11, clue: "Local __: our weekly paper", len: 5 },
      { n: 13, clue: "Opposite of ebb", len: 4 },
      { n: 14, clue: "Grain used in porridge", len: 4 },
      { n: 16, clue: "What waves do on the shore", len: 5 },
      { n: 18, clue: "Loud blow from a ship's horn", len: 5 },
      { n: 20, clue: "Shellfish prized by Kiwis", len: 4 },
      { n: 22, clue: "Beach ball sport, popular at Beachlands", len: 10 },
    ],
    down: [
      { n: 2, clue: "The 'Ō' in Pōhutukawa, as a vowel mark", len: 6 },
      { n: 3, clue: "Weekend market setup", len: 5 },
      { n: 4, clue: "Seagull's cousin", len: 4 },
      { n: 5, clue: "Sand castle tool", len: 6 },
      { n: 6, clue: "South island fruit, kiwi's namesake", len: 8 },
      { n: 7, clue: "What the paper is delivered to", len: 5 },
      { n: 8, clue: "Fish and __", len: 5 },
      { n: 9, clue: "Harbour vessel", len: 4 },
      { n: 12, clue: "Ocean swell", len: 4 },
      { n: 15, clue: "Māori word for sea", len: 2 },
      { n: 17, clue: "Local rugby code", len: 5 },
      { n: 19, clue: "Maraetai __: our main beach", len: 5 },
      { n: 21, clue: "Crab's weapon", len: 5 },
    ],
  },
];

function sectionCrossword() {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Crossword — examples for you to look at", 3,
    "Hi Aunty L. Three example puzzles below showing what your weekly crossword could look like. Have a read of the clues, look at the grid shape — would you be happy publishing something like this each week?"));

  const banner = el("div", { class: "banner banner--info" });
  banner.innerHTML = `<strong>These are preview mock-ups</strong> — nothing is live yet. Just a visual to help you decide if this direction works.`;
  sec.append(banner);

  const grid = el("div", { class: "crossword-grid" });
  for (const p of EXAMPLE_PUZZLES) grid.append(crosswordExample(p));
  sec.append(grid);

  // Next-step CTA, written for Leanne
  const foot = el("div", { class: "crossword-foot" });
  foot.innerHTML = `
    <h3>How it would work each week</h3>
    <ol>
      <li><strong>Click Generate</strong> and in a few seconds you get a fresh filled grid + numbered clue list — the 80×80mm size you print at, ready for InDesign.</li>
      <li><strong>Read through and tweak.</strong> Don't love a clue? Click it and ask for another one, or write your own. The grid stays fixed; only the wording changes.</li>
      <li><strong>Export</strong> — one file for the grid + clues, one file for the answer key (page 8). Drop them into the layout the same way you do now.</li>
    </ol>
    <p>About 15 minutes of your time each week, instead of waiting on the vendor's email. Includes a quality-check step that solves every clue against the grid before it reaches you, so you shouldn't see ambiguous or silly ones — if any slip through, you just click "give me another".</p>
    <h3 style="margin-top: 1.25rem;">Cost</h3>
    <p>If you're happy with the direction, I can fold this into your existing website bill — <strong>NZ$60/month total (website + crossword)</strong>, instead of the ~NZ$90/month you pay the current vendor plus the website. That covers as many regenerations as you want each week. Happy to run it as a free trial for a few weeks first — if the quality isn't there you let me know and we tune it or drop it, no change to anything. The current vendor can stay in place until you're sure.</p>
  `;
  sec.append(foot);
  return sec;
}

function crosswordExample(p) {
  const art = el("article", { class: "crossword-card" });
  art.append(
    el("h3", { class: "crossword-card__title" }, p.title),
    el("p", { class: "crossword-card__subtitle muted" }, p.subtitle),
  );

  // Build grid + compute numbers
  const { cells, numbers } = computeGrid(p.rows);
  const svg = renderCrosswordSVG(cells, numbers, p.size);
  art.append(svg);

  const clueCols = el("div", { class: "crossword-card__clues" });
  clueCols.append(cluesList("Across", p.across), cluesList("Down", p.down));
  art.append(clueCols);

  return art;
}

function computeGrid(rows) {
  const size = rows.length;
  const cells = rows.map((r) => r.split("").map((c) => c === "#" ? null : c === "." ? "" : c));
  const numbers = {};
  let n = 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c] === null) continue;
      const startsAcross = (c === 0 || cells[r][c - 1] === null) &&
        (c + 1 < size && cells[r][c + 1] !== null);
      const startsDown = (r === 0 || cells[r - 1][c] === null) &&
        (r + 1 < size && cells[r + 1][c] !== null);
      if (startsAcross || startsDown) {
        numbers[`${r},${c}`] = n++;
      }
    }
  }
  return { cells, numbers };
}

function renderCrosswordSVG(cells, numbers, size) {
  const cell = 24;
  const w = cell * size;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "crossword-svg");
  svg.setAttribute("viewBox", `0 0 ${w + 1} ${w + 1}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = c * cell, y = r * cell;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x); rect.setAttribute("y", y);
      rect.setAttribute("width", cell); rect.setAttribute("height", cell);
      rect.setAttribute("stroke", "#1A1A1A");
      rect.setAttribute("stroke-width", "0.75");
      rect.setAttribute("fill", cells[r][c] === null ? "#1A1A1A" : "#ffffff");
      svg.appendChild(rect);
      if (cells[r][c] === null) continue;
      const num = numbers[`${r},${c}`];
      if (num) {
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", x + 2); t.setAttribute("y", y + 7);
        t.setAttribute("font-size", "6"); t.setAttribute("font-family", "Inter, sans-serif");
        t.setAttribute("fill", "#1A1A1A");
        t.textContent = num;
        svg.appendChild(t);
      }
    }
  }
  return svg;
}

function cluesList(heading, items) {
  const col = el("div", { class: "crossword-clues" });
  col.append(el("h4", {}, heading));
  const ol = el("ol");
  for (const it of items) {
    ol.append(el("li", {},
      el("span", { class: "crossword-clues__num" }, `${it.n}.`),
      " ",
      el("span", {}, it.clue),
      " ",
      el("span", { class: "muted" }, `(${it.len})`),
    ));
  }
  col.append(ol);
  return col;
}

// ─── Section: Notes ────────────────────────────────────────────────────
function sectionNotes() {
  const sec = el("section", { class: "notes" });
  sec.append(el("h3", {}, "Notes"));
  const bits = [];
  for (const roster of state.data.rosters) {
    const notes = roster.editor_notes;
    if (notes && String(notes).trim()) {
      bits.push(el("p", {}, el("strong", {}, `${roster.label}: `), String(notes)));
    }
  }
  if (bits.length === 0) {
    sec.append(el("p", { class: "muted" },
      "No notes yet. Leave notes for yourself (or anyone else editing) in the Roster CMS tab, under 'Notes for editors'. They'll appear here next time the site rebuilds."));
  } else {
    for (const b of bits) sec.append(b);
  }
  return sec;
}

// ─── Mutations ─────────────────────────────────────────────────────────
async function updateSlotStatus(rosterKey, slotRef, newStatus, note) {
  await mutateRoster(rosterKey, (r) => {
    const idx = r.slots.findIndex((s) => s.issue_date === slotRef.issue_date && s.contributor_key === slotRef.contributor_key);
    if (idx === -1) throw new Error("Slot not found in current roster file");
    r.slots[idx].status = newStatus;
    if (note) {
      r.slots[idx].notes = r.slots[idx].notes ? `${r.slots[idx].notes}; ${note}` : note;
    }
    return `chore(roster): ${rosterKey} slot ${slotRef.issue_date} → ${newStatus}`;
  });
  toast(`Status updated → ${STATUS_LABEL[newStatus] || newStatus}`);
}

async function mutateRoster(rosterKey, mutator) {
  if (!state.auth) {
    toast("Sign into /admin/ first, then come back.", true);
    throw new Error("not signed in");
  }
  const path = `src/_data/rosters/${rosterKey}.yml`;
  const fresh = await ghGet(path, state.auth.token);
  const parsed = jsyaml.load(fresh.content);
  const message = mutator(parsed);
  const yamlOut =
    "# Edited via /admin/chaser/ or /admin/#/collections/rosters.\n\n" +
    jsyaml.dump(parsed, { lineWidth: 100, noRefs: true });
  await ghPut(path, { content: yamlOut, sha: fresh.sha, message, token: state.auth.token });

  // Optimistic in-memory update
  const roster = state.data.rosters.find((r) => r.key === rosterKey);
  if (roster) {
    roster.contributors = parsed.contributors;
    roster.slots = parsed.slots;
  }
  render();
}

// ─── UI primitives ─────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function btn(label, cls, onClick) {
  const b = el("button", { class: `btn ${cls || ""}` }, label);
  b.addEventListener("click", onClick);
  return b;
}
function sectionHead(title, count, sub) {
  const h = el("div", { class: "section__head" });
  const t = el("h2", { class: "section__title" }, title);
  if (count !== undefined) t.append(el("span", { class: "section__count" }, String(count)));
  h.append(t);
  if (sub) h.append(el("span", { class: "section__sub muted" }, sub));
  return h;
}
function toast(msg, isError) {
  const t = el("div", { class: `toast${isError ? " toast--error" : ""}` }, msg);
  document.getElementById("toast-host").append(t);
  setTimeout(() => t.remove(), 4000);
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ─── Go ────────────────────────────────────────────────────────────────
boot();
