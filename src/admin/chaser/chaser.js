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
const CROSSWORD_RESULT_KEY = "pct-chaser-crossword-result-v1";
const CROSSWORD_SWAPLOG_KEY = "pct-chaser-crossword-swaplog-v1";
const CROSSWORD_HELP_DISMISSED_KEY = "pct-chaser-crossword-help-dismissed-v1";
// v2: the levels were redefined (Standard now matches the paper's usual puzzle), so earlier picks reset.
const CROSSWORD_DIFFICULTY_KEY = "pct-chaser-crossword-difficulty-v2";
const CLUE_BATCH_SIZE = 3;             // answers per write-clues call (run in parallel); small batches keep each call well inside the time limit
const DIFFICULTIES = [
  { key: "standard", label: "Standard", hint: "Like the paper's usual crossword: short, plain clues, interesting answers." },
  { key: "challenging", label: "Challenging", hint: "Same style, but about half the clues have a twist. No specialist knowledge needed." },
  { key: "fiendish", label: "Fiendish", hint: "Lots of misdirection. Expect to need a crossing letter or two." },
];

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
  tab: readLS(TAB_KEY, "chaser"), // chaser | roster | crossword
  editedDrafts: readLS(EDIT_DRAFT_KEY, {}),
  sheetFilter: readLS(SHEET_FILTER_KEY, "upcoming"), // upcoming | all | done | missing
  sheetSearch: "",
  savingContrib: null, // key being saved, for optimistic UI
  crosswordResult: readLS(CROSSWORD_RESULT_KEY, null),
  crosswordBusy: false,
  crosswordError: null,
  crosswordProgress: null, // { stage: "grid" } | { stage: "clues", done, total }
  crosswordDifficulty: readLS(CROSSWORD_DIFFICULTY_KEY, "standard"),
  crosswordQuota: null,    // this week's allowance, from the server
  crosswordQuotaTried: false,
  showAnswers: false,
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
];

function sectionCrossword() {
  const sec = el("section", { class: "section" });

  const hasResult = !!state.crosswordResult;

  sec.append(sectionHead(
    hasResult ? "Crossword — this week's puzzle" : "Crossword — examples + generate",
    hasResult ? undefined : 2,
    hasResult
      ? "Review the clues, hit Generate if you'd like a different puzzle, then download the grid and copy the clues for InDesign."
      : "Hi Aunty L. Two examples at the bottom showing the format. Press the Generate button to produce a real puzzle you could actually publish."
  ));

  // Generate control bar — always visible, main entry point
  const bar = el("div", { class: "crossword-generate" });
  const p = state.crosswordProgress;
  const busyLabel = !p || p.stage === "grid" ? "⏳ Building the grid…"
    : `⏳ Writing clues… ${p.done} of ${p.total} batches`;
  loadQuota();
  const outOfPuzzles = puzzlesLeft() === 0;
  const idleLabel = !state.auth ? "🔒 Sign in to the CMS first"
    : outOfPuzzles ? "Weekly puzzle limit reached" : "🎲 Generate a new puzzle";
  const generateBtn = btn(state.crosswordBusy ? busyLabel : idleLabel,
    "btn--primary", (ev) => { ev.preventDefault(); runGenerate(); });
  if (state.crosswordBusy || !state.auth || outOfPuzzles) generateBtn.disabled = true;
  bar.append(generateBtn, difficultyPicker());
  if (hasResult && !state.crosswordBusy) {
    bar.append(btn("Show examples again", "btn btn--ghost", (ev) => {
      ev.preventDefault();
      state.crosswordResult = null;
      writeLS(CROSSWORD_RESULT_KEY, null);
      render();
    }));
  }
  const r = state.crosswordResult;
  const levelName = (key) => (DIFFICULTIES.find((d) => d.key === key) || {}).label;
  bar.append(el("span", { class: "muted crossword-generate__status" },
    state.crosswordBusy
      ? "Each clue is written, then fact-checked. About half a minute."
      : hasResult
        ? `Generated ${new Date(r.generated_at).toLocaleString("en-NZ")}${r.difficulty ? ` · ${levelName(r.difficulty)}` : ""}`
        : "Takes about half a minute"));
  sec.append(bar);
  const allowance = quotaLine();
  if (allowance) sec.append(el("p", { class: "crossword-quota muted" }, allowance));

  if (state.crosswordError) {
    const errBanner = el("div", { class: "banner banner--warn" });
    errBanner.innerHTML = `<strong>Something went wrong:</strong> ${escapeHtml(state.crosswordError)}`;
    sec.append(errBanner);
  }

  if (hasResult) {
    sec.append(generatedCrossword(state.crosswordResult));
    sec.append(crosswordHelp());
  } else {
    const banner = el("div", { class: "banner banner--info" });
    banner.innerHTML = `<strong>Preview mode</strong> — the two puzzles below are hand-written examples showing the format. Hit the Generate button above to produce a real one.`;
    sec.append(banner);
    const grid = el("div", { class: "crossword-grid" });
    for (const p of EXAMPLE_PUZZLES) grid.append(crosswordExample(p));
    sec.append(grid);
  }

  // Next-step CTA, written for Leanne
  const foot = el("div", { class: "crossword-foot" });
  foot.innerHTML = `
    <h3>How it works each week</h3>
    <ol>
      <li><span><strong>Generate.</strong> Pick a difficulty and click the button. A fresh grid and numbered clue list appear in about half a minute.</span></li>
      <li><span><strong>Read through and tweak.</strong> Don't love a clue? Click the ↻ next to it and just that one is rewritten. The grid stays exactly as it is.</span></li>
      <li><span><strong>Download and copy into InDesign.</strong> Download the grid (PDF or JPG, exactly 80 × 80 mm) and copy the clues. Same again for the answer key on page 8.</span></li>
    </ol>
    <p>Every clue is checked by a separate editor pass for accuracy, fairness and NZ English before it reaches you, so you shouldn't see wrong or ambiguous ones. If one slips through, the ↻ fixes it.</p>
    <p class="muted">Happy to run it as a free trial for a few weeks. If the quality isn't there, let me know and we tune it or drop it. Your current vendor can stay in place until you're sure.</p>
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

  // Toolbar: copy clues to clipboard in the format Leanne already uses
  const bar = el("div", { class: "crossword-card__bar" });
  bar.append(btn("📋 Copy clues", "btn--small btn--ghost", () => {
    const text = cluesToText(p);
    navigator.clipboard.writeText(text).then(
      () => toast("Clues copied — paste straight into InDesign."),
      () => toast("Couldn't copy — select the text below instead.", true),
    );
  }));
  art.append(bar);

  const clueCols = el("div", { class: "crossword-card__clues" });
  clueCols.append(cluesList("Across", p.across), cluesList("Down", p.down));
  art.append(clueCols);

  return art;
}

function cluesToText(p) {
  const fmt = (list) => list.map((c) => `${c.n}. ${c.clue} (${c.len})`).join("\n");
  return `Across\n${fmt(p.across)}\n\nDown\n${fmt(p.down)}`;
}

function answersToText(p) {
  const fmt = (list) => list.map((c) => `${c.n}. ${c.answer || "?"}`).join("\n");
  return `Across\n${fmt(p.across)}\n\nDown\n${fmt(p.down)}`;
}

// ─── Weekly allowance (enforced by the server; shown here) ─────────────
// Crossword calls need the CMS sign-in, and each new puzzle / clue rewrite
// comes out of a weekly allowance kept on the server, so it can't be
// bypassed from the browser. See netlify/crossword/guard.mjs.
function crosswordHeaders() {
  const h = { "content-type": "application/json" };
  if (state.auth) h.authorization = `Bearer ${state.auth.token}`;
  return h;
}
function puzzlesLeft() {
  const q = state.crosswordQuota;
  return !q || q.exempt ? Infinity : Math.max(0, q.puzzles_limit - q.puzzles_used);
}
function rewritesLeft() {
  const q = state.crosswordQuota;
  return !q || q.exempt ? Infinity : Math.max(0, q.rewrites_limit - q.rewrites_used);
}
function quotaLine() {
  const q = state.crosswordQuota;
  if (!state.auth) return "Crosswords need your CMS sign-in. Open the CMS, sign in, then come back.";
  if (!q) return "";
  if (q.exempt) return "Owner account: what you make here isn't counted against Leanne's weekly allowance.";
  return `${puzzlesLeft()} of ${q.puzzles_limit} new puzzles left this week · ` +
    `${rewritesLeft()} of ${q.rewrites_limit} clue rewrites left · resets ${q.resets}`;
}
async function loadQuota() {
  if (!state.auth || state.crosswordQuotaTried) return;
  state.crosswordQuotaTried = true;
  try {
    const res = await fetch("/.netlify/functions/crossword-quota", { headers: crosswordHeaders(), cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { state.crosswordQuota = data; render(); }
  } catch { /* the server still enforces the allowance */ }
}

// ─── Generate: calls the Netlify function, stores result in state ──────
async function runGenerate() {
  if (!state.auth) { toast("Sign in to the CMS first, then come back.", true); return; }
  const left = puzzlesLeft();
  if (state.crosswordResult && left !== Infinity) {
    const ok = confirm(
      (left === 1 ? "This uses your last new puzzle for this week.\n\n" : `This uses 1 of your ${left} new puzzles left this week.\n\n`) +
      "If it's just a few clues you don't like, the ↻ next to each one rewrites that clue on its own.\n\n" +
      "Make a brand new puzzle?");
    if (!ok) return;
  }

  state.crosswordBusy = true;
  state.crosswordError = null;
  state.crosswordProgress = { stage: "grid" };
  render();
  try {
    // Step 1: the grid and its answers (instant, no AI).
    const res = await fetch("/.netlify/functions/generate-crossword", { headers: crosswordHeaders(), cache: "no-store" });
    const grid = await res.json().catch(() => ({}));
    if (grid.quota) state.crosswordQuota = grid.quota;
    if (!res.ok) throw new Error(grid.error || `Request failed (${res.status})`);

    // Step 2: clues, written and fact-checked in small parallel batches so
    // no single request gets near the server's time limit.
    const difficulty = state.crosswordDifficulty;
    const entries = [...grid.across, ...grid.down];
    const answers = [...new Set(entries.map((e) => e.answer))];
    const batches = [];
    for (let i = 0; i < answers.length; i += CLUE_BATCH_SIZE) batches.push(answers.slice(i, i + CLUE_BATCH_SIZE));
    const progress = { stage: "clues", done: 0, total: batches.length };
    state.crosswordProgress = progress;
    render();

    const swapLog = readLS(CROSSWORD_SWAPLOG_KEY, []).slice(-10);
    const clueBy = {};
    const unchecked = new Set();
    let failedBatches = 0;
    await Promise.all(batches.map(async (batch) => {
      try {
        const data = await writeClueBatch(grid.puzzle_id, batch, difficulty, swapLog);
        for (const c of data.clues || []) clueBy[c.answer] = c.clue;
        if (!data.checked) batch.forEach((a) => unchecked.add(a));
      } catch (e) {
        failedBatches++;
        console.warn("clue batch failed:", e);
      }
      progress.done++;
      render();
    }));
    if (failedBatches === batches.length) {
      // Hand the puzzle back so a failed attempt doesn't use up the week's allowance.
      try {
        const rel = await fetch("/.netlify/functions/crossword-quota", {
          method: "POST", headers: crosswordHeaders(), body: JSON.stringify({ release: grid.puzzle_id }),
        });
        if (rel.ok) state.crosswordQuota = await rel.json();
      } catch { /* refunded automatically when the next puzzle is made */ }
      throw new Error("Couldn't write the clues just now, so this attempt hasn't used up a puzzle. Please try again in a minute.");
    }

    for (const e of entries) {
      e.clue = clueBy[e.answer] || "";
      if (e.clue && unchecked.has(e.answer)) e._unchecked = true;
    }
    grid.difficulty = difficulty;
    state.crosswordResult = grid;
    writeLS(CROSSWORD_RESULT_KEY, grid);
    const missing = entries.filter((e) => !e.clue).length;
    toast(missing
      ? `Puzzle ready, but ${missing} clue${missing === 1 ? "" : "s"} need${missing === 1 ? "s" : ""} writing. Press the ↻ next to ${missing === 1 ? "it" : "each"}.`
      : "Fresh puzzle ready — review the clues below.", !!missing);
  } catch (e) {
    state.crosswordError = e.message;
  } finally {
    state.crosswordBusy = false;
    state.crosswordProgress = null;
    render();
  }
}

// One batch of answers → clues. Retries once, because a single slow or
// failed request shouldn't cost Leanne the whole puzzle.
async function writeClueBatch(puzzleId, answers, difficulty, swapLog) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/.netlify/functions/write-clues", {
        method: "POST",
        headers: crosswordHeaders(),
        body: JSON.stringify({ puzzle_id: puzzleId, answers, difficulty, swap_log: swapLog }),
      });
      const data = await res.json().catch(() => ({}));
      // Sign-in, expired-puzzle and limit errors won't change on a retry.
      if ([400, 401, 403, 429].includes(res.status)) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.final = true;
        throw err;
      }
      // Clue functions stream, so a failure can arrive as {error} with a 200.
      if (!res.ok || data.error || !Array.isArray(data.clues)) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (e.final) break;
    }
  }
  throw lastErr;
}

function difficultyPicker() {
  const wrap = el("div", { class: "crossword-difficulty", role: "group", "aria-label": "Difficulty" });
  wrap.append(el("span", { class: "crossword-difficulty__label" }, "Difficulty"));
  for (const d of DIFFICULTIES) {
    const b = el("button", {
      class: "crossword-difficulty__opt",
      type: "button",
      title: d.hint,
      "aria-pressed": state.crosswordDifficulty === d.key ? "true" : "false",
    }, d.label);
    b.disabled = state.crosswordBusy;
    b.addEventListener("click", () => {
      state.crosswordDifficulty = d.key;
      writeLS(CROSSWORD_DIFFICULTY_KEY, d.key);
      render();
    });
    wrap.append(b);
  }
  const current = DIFFICULTIES.find((d) => d.key === state.crosswordDifficulty) || DIFFICULTIES[0];
  wrap.append(el("span", { class: "crossword-difficulty__hint muted" }, current.hint));
  return wrap;
}

// ─── Single-clue regen: replaces one clue without touching the grid ────
async function runRegenClue(entry, direction) {
  const r = state.crosswordResult;
  if (!r) return;
  if (!state.auth) { toast("Sign in to the CMS first, then come back.", true); return; }
  if (rewritesLeft() === 0) { toast("This week's clue rewrites are used up. They reset on Monday.", true); return; }
  entry._regenerating = true;
  render();
  try {
    const swapLog = readLS(CROSSWORD_SWAPLOG_KEY, []);
    const res = await fetch("/.netlify/functions/regenerate-clue", {
      method: "POST",
      headers: crosswordHeaders(),
      body: JSON.stringify({
        answer: entry.answer,
        rejected_clue: entry.clue,
        difficulty: r.difficulty || state.crosswordDifficulty,
        swap_log: swapLog.slice(-10),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.quota) state.crosswordQuota = data.quota;
    if (!res.ok || data.error || !data.clue) throw new Error(data.error || `Request failed (${res.status})`);
    // Log the swap so future clues lean towards Leanne's taste. A blank
    // clue being filled in isn't a rejection, so it isn't logged.
    if (entry.clue) {
      swapLog.push({
        answer: entry.answer,
        rejected: entry.clue,
        kept: data.clue,
        when: Date.now(),
      });
      writeLS(CROSSWORD_SWAPLOG_KEY, swapLog.slice(-100));
    }
    entry.clue = data.clue;
    entry._unchecked = data.checked === false;
    entry._regenerating = false;
    writeLS(CROSSWORD_RESULT_KEY, r);
    render();
    toast(`Clue updated for ${entry.answer}.`);
  } catch (e) {
    entry._regenerating = false;
    render();
    toast(`Couldn't rewrite that clue: ${e.message}`, true);
  }
}

// ─── Help section at the bottom of the generated-puzzle view ──────────
function crosswordHelp() {
  const dismissed = readLS(CROSSWORD_HELP_DISMISSED_KEY, false);
  const wrap = el("section", { class: "crossword-help" });

  if (dismissed) {
    const toggle = btn("Show tips again", "btn btn--ghost btn--small", () => {
      writeLS(CROSSWORD_HELP_DISMISSED_KEY, false);
      render();
    });
    wrap.append(toggle);
    return wrap;
  }

  wrap.classList.add("crossword-help--open");
  const head = el("div", { class: "crossword-help__head" });
  head.append(
    el("h3", { class: "crossword-help__title" }, "How this page works"),
    (() => {
      const b = btn("Got it", "btn btn--ghost btn--small", () => {
        writeLS(CROSSWORD_HELP_DISMISSED_KEY, true);
        render();
      });
      return b;
    })(),
  );
  wrap.append(head);

  const q = state.crosswordQuota;
  const puzzleLimit = q ? q.puzzles_limit : 2;
  const rewriteLimit = q ? q.rewrites_limit : 20;
  const steps = [
    {
      icon: "🎲",
      title: "Generate a new puzzle",
      body: `Fresh grid and clues, in about half a minute. Every clue is written, then checked by a separate editor for accuracy and fairness. You get ${puzzleLimit} new puzzles a week (resets Monday), so if it's only a few clues, rewrite those instead.`,
    },
    {
      icon: "↻",
      title: "Rewrite a single clue",
      body: `Don't love a clue? Click the ↻ next to it and just that one is rewritten and checked, in about 15 seconds. Up to ${rewriteLimit} a week. The grid and the other clues stay as they are.`,
    },
    {
      icon: "📋",
      title: "Copy for InDesign",
      body: "Copy clues gives you the numbered Across/Down list ready to paste into the paper. Copy answer key gives you the solution block for page 8.",
    },
    {
      icon: "📐",
      title: "Download the grid",
      body: "Under each grid there's a PDF and a JPG button. Both come out at exactly 80 × 80 mm and print sharp — no screenshots needed. PDF is the best one for InDesign.",
    },
    {
      icon: "🧠",
      title: "Learns your taste",
      body: "Every time you rewrite a clue, the system quietly remembers what you kept and what you rejected. Over a few weeks the clue style drifts towards what you actually like — no settings to tweak.",
    },
    {
      icon: "🎚",
      title: "Difficulty",
      body: "Standard, Challenging or Fiendish, next to the Generate button. Standard is like the paper's usual crossword: short, plain clues with interesting answers. Challenging gives about half the clues a twist; Fiendish twists almost all of them. Pick the level before you generate.",
    },
  ];

  const grid = el("div", { class: "crossword-help__grid" });
  for (const s of steps) {
    const card = el("div", { class: "crossword-help__card" });
    card.append(
      el("div", { class: "crossword-help__icon" }, s.icon),
      el("div", { class: "crossword-help__body" },
        el("strong", {}, s.title),
        el("p", {}, s.body),
      ),
    );
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

// ─── Render: the generated puzzle (two grids — empty + answer key) ────
function generatedCrossword(r) {
  const art = el("article", { class: "crossword-card" });

  // Parse the rows (strings with letters or '#') into a cells-style structure
  const cells = r.rows.map((row) => row.split("").map((c) => (c === "#" ? null : c)));
  const emptyCells = cells.map((row) => row.map((c) => (c === null ? null : "")));

  const gridsWrap = el("div", { class: "crossword-grids" });

  // The empty grid — for the main paper layout
  const emptyBlock = el("div", { class: "crossword-grid-block" });
  emptyBlock.append(el("h4", {}, "Grid (for the paper — 80×80 mm)"));
  emptyBlock.append(renderCrosswordSVG(emptyCells, r.numbers, r.size));
  emptyBlock.append(gridDownloads(emptyCells, r, false, "grid"));
  gridsWrap.append(emptyBlock);

  // The filled answer-key grid — for page 8
  const answerBlock = el("div", { class: "crossword-grid-block" });
  answerBlock.append(el("h4", {}, "Answer key (for page 8)"));
  answerBlock.append(renderCrosswordSVG(cells, r.numbers, r.size, { showLetters: true }));
  answerBlock.append(gridDownloads(cells, r, true, "answers"));
  gridsWrap.append(answerBlock);

  art.append(gridsWrap);

  // Toolbar: copy clues, copy answer key
  const bar = el("div", { class: "crossword-card__bar" });
  bar.append(btn("📋 Copy clues (for paper)", "btn--small btn--primary", () => {
    navigator.clipboard.writeText(cluesToText(r)).then(
      () => toast("Clues copied — paste into InDesign."),
      () => toast("Couldn't copy — select the text instead.", true),
    );
  }));
  bar.append(btn("📋 Copy answer key", "btn--small btn--ghost", () => {
    navigator.clipboard.writeText(answersToText(r)).then(
      () => toast("Answer key copied."),
      () => toast("Couldn't copy.", true),
    );
  }));
  art.append(bar);

  // Clue list (with per-clue regenerate buttons on the generated puzzle)
  const clueCols = el("div", { class: "crossword-card__clues" });
  clueCols.append(
    cluesList("Across", r.across, { regenable: true }),
    cluesList("Down", r.down, { regenable: true }),
  );
  art.append(clueCols);

  // Footnote
  art.append(el("p", { class: "muted", style: "margin-top:0.75rem; font-size:0.85rem;" },
    `If one clue is off, click the ↻ next to it and I'll rewrite just that one. Hit Generate for a whole new puzzle if the grid itself isn't working for you.`));

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

function renderCrosswordSVG(cells, numbers, size, opts) {
  const showLetters = !!(opts && opts.showLetters);
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
      if (showLetters && cells[r][c]) {
        const lt = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lt.setAttribute("x", x + cell / 2); lt.setAttribute("y", y + cell / 2 + 5.5);
        lt.setAttribute("font-size", "14"); lt.setAttribute("font-family", "Lora, Georgia, serif");
        lt.setAttribute("text-anchor", "middle");
        lt.setAttribute("fill", "#1A1A1A");
        lt.textContent = cells[r][c];
        svg.appendChild(lt);
      }
    }
  }
  return svg;
}

// ─── Print downloads: PDF (vector) + JPG (600 dpi), both exactly 80×80 mm ──
// Built entirely in the browser — nothing leaves the page.
const PRINT_MM = 80;
const JPG_DPI = 600;
// Helvetica-Bold advance widths (per 1000 em) for centring answer letters.
const HELV_BOLD_W = { A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611 };

// Shared geometry, in whatever unit `side` is given in (pt for PDF, px for JPG).
function printGeometry(side, size, unitsPerPt) {
  const outer = 1.0 * unitsPerPt;   // 1 pt outer border
  const inner = 0.4 * unitsPerPt;   // 0.4 pt cell rules
  const inset = outer / 2;          // keep the outer stroke inside the page
  const grid = side - outer;
  const cell = grid / size;
  return { outer, inner, inset, grid, cell, numSize: cell * 0.3, letterSize: cell * 0.55 };
}

function gridToPDF(cells, numbers, size, showLetters) {
  const W = PRINT_MM * 72 / 25.4;   // 80 mm in points
  const g = printGeometry(W, size, 1);
  const f = (n) => String(Math.round(n * 1000) / 1000);
  // PDF origin is bottom-left; row 0 is at the top.
  const cellX = (c) => g.inset + c * g.cell;
  const cellTop = (r) => W - g.inset - r * g.cell;
  const ops = ["0 g"];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c] === null) ops.push(`${f(cellX(c))} ${f(cellTop(r) - g.cell)} ${f(g.cell)} ${f(g.cell)} re`);
    }
  }
  ops.push("f", `0 G ${f(g.inner)} w`);
  for (let i = 1; i < size; i++) {
    const x = cellX(i), y = cellTop(i);
    ops.push(`${f(x)} ${f(g.inset)} m ${f(x)} ${f(W - g.inset)} l`);
    ops.push(`${f(g.inset)} ${f(y)} m ${f(W - g.inset)} ${f(y)} l`);
  }
  ops.push("S", `${f(g.outer)} w ${f(g.inset)} ${f(g.inset)} ${f(g.grid)} ${f(g.grid)} re S`);
  ops.push("BT", `/F1 ${f(g.numSize)} Tf`);
  for (const [key, num] of Object.entries(numbers)) {
    const [r, c] = key.split(",").map(Number);
    const x = cellX(c) + g.cell * 0.07;
    const y = cellTop(r) - g.cell * 0.06 - g.numSize * 0.72;
    ops.push(`1 0 0 1 ${f(x)} ${f(y)} Tm (${num}) Tj`);
  }
  ops.push("ET");
  if (showLetters) {
    ops.push("BT", `/F2 ${f(g.letterSize)} Tf`);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const ch = cells[r][c];
        if (!ch || !HELV_BOLD_W[ch]) continue;
        const w = HELV_BOLD_W[ch] / 1000 * g.letterSize;
        const x = cellX(c) + g.cell / 2 - w / 2;
        const y = cellTop(r) - g.cell / 2 - g.letterSize * 0.718 / 2 - g.cell * 0.06;
        ops.push(`1 0 0 1 ${f(x)} ${f(y)} Tm (${ch}) Tj`);
      }
    }
    ops.push("ET");
  }
  const content = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(W)}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  // Everything is ASCII, so string length == byte offset.
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: "application/pdf" });
}

async function gridToJPG(cells, numbers, size, showLetters) {
  const px = Math.round(PRINT_MM / 25.4 * JPG_DPI);
  const g = printGeometry(px, size, JPG_DPI / 72);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c] === null) ctx.fillRect(g.inset + c * g.cell, g.inset + r * g.cell, g.cell, g.cell);
    }
  }
  ctx.strokeStyle = "#000";
  ctx.lineWidth = g.inner;
  ctx.beginPath();
  for (let i = 1; i < size; i++) {
    const p = g.inset + i * g.cell;
    ctx.moveTo(p, g.inset); ctx.lineTo(p, px - g.inset);
    ctx.moveTo(g.inset, p); ctx.lineTo(px - g.inset, p);
  }
  ctx.stroke();
  ctx.lineWidth = g.outer;
  ctx.strokeRect(g.inset, g.inset, g.grid, g.grid);
  ctx.font = `${g.numSize}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const [key, num] of Object.entries(numbers)) {
    const [r, c] = key.split(",").map(Number);
    ctx.fillText(String(num), g.inset + c * g.cell + g.cell * 0.07,
      g.inset + r * g.cell + g.cell * 0.06 + g.numSize * 0.72);
  }
  if (showLetters) {
    ctx.font = `bold ${g.letterSize}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const ch = cells[r][c];
        if (!ch) continue;
        ctx.fillText(ch, g.inset + c * g.cell + g.cell / 2,
          g.inset + r * g.cell + g.cell / 2 + g.letterSize * 0.718 / 2 + g.cell * 0.06);
      }
    }
  }
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));
  // Stamp 600 dpi into the JFIF header so InDesign places it at 80 mm, not
  // at 72 dpi (which would come in ~667 mm wide).
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isJFIF = bytes[2] === 0xFF && bytes[3] === 0xE0 &&
    String.fromCharCode(bytes[6], bytes[7], bytes[8], bytes[9]) === "JFIF";
  if (isJFIF) {
    bytes[13] = 1; // units: dots per inch
    bytes[14] = JPG_DPI >> 8; bytes[15] = JPG_DPI & 255;
    bytes[16] = JPG_DPI >> 8; bytes[17] = JPG_DPI & 255;
  }
  return new Blob([bytes], { type: "image/jpeg" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function gridDownloads(cells, r, showLetters, kind) {
  const wrap = el("div", { class: "crossword-dl" });
  const base = `pct-crossword-${kind}-${todayISONZ()}`;
  wrap.append(btn("⬇ PDF", "btn--small btn--ghost", () => {
    downloadBlob(gridToPDF(cells, r.numbers, r.size, showLetters), `${base}.pdf`);
  }));
  wrap.append(btn("⬇ JPG", "btn--small btn--ghost", async () => {
    try {
      downloadBlob(await gridToJPG(cells, r.numbers, r.size, showLetters), `${base}.jpg`);
    } catch (e) {
      toast(`Couldn't make the JPG: ${e.message}`, true);
    }
  }));
  wrap.append(el("span", { class: "muted crossword-dl__note" }, "80 × 80 mm, print quality"));
  return wrap;
}

function cluesList(heading, items, opts) {
  const regenable = !!(opts && opts.regenable);
  const col = el("div", { class: "crossword-clues" });
  col.append(el("h4", {}, heading));
  const ol = el("ol");
  for (const it of items) {
    const li = el("li", {});
    li.append(
      el("span", { class: "crossword-clues__num" }, `${it.n}.`),
      " ",
      it.clue
        ? el("span", {}, it.clue)
        : el("span", { class: "crossword-clues__missing" }, "No clue yet. Press ↻ to write one"),
      " ",
      el("span", { class: "muted" }, `(${it.len})`),
    );
    if (it.clue && it._unchecked) {
      li.append(" ", el("span", {
        class: "crossword-clues__flag",
        title: "The fact-check step ran out of time for this one. Give it a quick read, or press ↻.",
      }, "not fact-checked"));
    }
    if (regenable && it.answer) {
      const b = el("button", {
        class: "crossword-clues__regen",
        title: it._regenerating ? "Rewriting…" : "Rewrite this clue",
        "aria-label": `Rewrite clue for ${it.answer}`,
      }, it._regenerating ? "…" : "↻");
      const noneLeft = rewritesLeft() === 0;
      b.disabled = !!it._regenerating || noneLeft;
      if (noneLeft) b.title = "This week's clue rewrites are used up. They reset on Monday.";
      b.addEventListener("click", () => runRegenClue(it, heading));
      li.append(" ", b);
    }
    ol.append(li);
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
