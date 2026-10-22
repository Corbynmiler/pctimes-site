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
      sectionWaitingOnEmail(buckets.waitingOnEmail),
      sectionNotes(),
    );
  } else {
    root.append(
      sectionSheet(buckets.all),
      sectionNotes(),
    );
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

// ─── Section: Needs sending today ──────────────────────────────────────
function sectionNeedsSending(items) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Needs sending today", items.length,
    "Chase emails ready to go. Review the wording, press Send to copy it to your clipboard, then paste into email."));
  if (items.length === 0) {
    sec.append(el("div", { class: "section__empty" }, "Nothing to chase right now. Nice."));
    return sec;
  }
  const stack = el("div", { class: "draft-stack" });
  for (const d of items) stack.append(sendDraftCard(d));
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
  actions.append(
    btn("📋 Send (copy to clipboard) & mark as chased", "btn--primary", () => sendDraft(d, ta.value)),
    btn("Open in email", "btn btn--ghost", () => {
      const href = `mailto:${encodeURIComponent(d.contrib.email)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(ta.value)}`;
      window.location.href = href;
    }),
    d.isEdited ? btn("Reset to template", "btn", () => {
      delete state.editedDrafts[d.editKey];
      writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
      render();
    }) : null,
    btn("Skip this cycle", "btn btn--danger-ghost", () => {
      if (confirm(`Skip ${d.contrib.organisation}'s chase for ${fmtShort(d.slot.issue_date)}? (The slot stays, no email will be drafted.)`)) {
        updateSlotStatus(d.roster.key, d.slot, "skipped", `Skipped from chaser on ${todayISONZ()}`);
      }
    }),
  );
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

// ─── Section: Waiting on email ─────────────────────────────────────────
function sectionWaitingOnEmail(items) {
  if (items.length === 0) return document.createDocumentFragment();
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Waiting on email", items.length,
    "Would be chased soon — but we don't have the contributor's email yet. Preview what the chase would say, then add the email in the Roster CMS tab."));
  const stack = el("div", { class: "draft-stack" });
  for (const d of items) stack.append(waitingCard(d));
  sec.append(stack);
  return sec;
}

function waitingCard(d) {
  const art = el("article", { class: "draft draft--waiting" });
  const head = el("header", { class: "draft__head" });
  head.append(
    el("div", { class: "draft__meta" },
      el("span", { class: "pill pill--roster" }, d.roster.label),
      "To:",
      el("strong", { class: "draft__to" }, d.contrib.display_name || d.contrib.organisation),
      el("span", { class: "muted draft__email" }, "— no email on file yet"),
      el("span", { class: "badge", "data-status": "pending" }, "Needs email"),
    ),
    el("div", { class: "draft__subject" }, d.subject),
  );
  art.append(head);
  art.append(el("pre", { class: "draft__preview" }, d.body));
  const actions = el("footer", { class: "draft__actions" });
  const addEmail = el("a", {
    class: "btn btn--primary",
    href: `/admin/#/collections/rosters/entries/${d.roster.key}`,
    target: "_blank",
    rel: "noopener",
  }, "Add email in Roster CMS →");
  actions.append(
    addEmail,
    btn("Copy email body", "btn btn--ghost", () => {
      navigator.clipboard.writeText(d.body).then(
        () => toast("Draft body copied."),
        () => toast("Couldn't copy — select the text instead.", true),
      );
    }),
  );
  art.append(actions);
  return art;
}

// ─── Section: Spreadsheet ──────────────────────────────────────────────
function sectionSheet(rows) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Full roster", rows.length,
    "Everything in order, like your spreadsheet. Click any row to mark it done, change its status, or jump into the CMS."));

  // Filters
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

  // Filter rows
  const filtered = rows.filter((r) => {
    const s = r.slot.status;
    const inUpcoming = ACTIVE_STATUSES.has(s) &&
      r.issueDays != null && r.issueDays >= -14; // show the last couple of weeks + future
    if (state.sheetFilter === "upcoming" && !inUpcoming) return false;
    if (state.sheetFilter === "done" && !DONE_STATUSES.has(s)) return false;
    if (state.sheetFilter === "missing" && !(ACTIVE_STATUSES.has(s) && !r.contrib.email && !r.contrib.self_authored)) return false;
    if (state.sheetSearch) {
      const hay = `${r.contrib.organisation} ${r.contrib.display_name} ${r.contrib.email}`.toLowerCase();
      if (!hay.includes(state.sheetSearch)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    sec.append(el("div", { class: "section__empty" }, "No slots match this filter."));
    return sec;
  }

  // Build table
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
  for (const row of filtered.slice(0, 200)) tbody.append(sheetRow(row));
  table.append(tbody);
  wrap.append(table);
  sec.append(wrap);
  if (filtered.length > 200) sec.append(el("p", { class: "muted" }, `Showing first 200 of ${filtered.length}.`));
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
