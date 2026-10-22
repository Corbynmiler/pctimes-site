// Roster dashboard — PC Times admin.
// Phase 1: review-and-copy only. No email sending.
//
// Reads:  /admin-data/roster.json      (built by Eleventy from YAML)
// Writes: GitHub Contents API           (uses the editor's Sveltia OAuth token)
//
// Everything is intentionally dependency-light: js-yaml loaded from CDN,
// otherwise vanilla JS. No framework. Keeps the admin surface small, the
// code easy for the next editor to understand, and avoids any build step.

/* global jsyaml */

// ─── Config ────────────────────────────────────────────────────────────
const REPO = "Corbynmiler/pctimes-site";
const BRANCH = "main";
const DATA_URL = "/admin-data/roster.json";
const TZ = "Pacific/Auckland";
const EDIT_DRAFT_KEY = "pct-roster-draft-edits-v1"; // localStorage, per-browser
const APPROVED_KEY = "pct-roster-approved-v1";       // localStorage, per-browser

// ─── Date helpers (Pacific/Auckland canonical) ─────────────────────────
const monthShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLong  = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
const dayLong    = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function todayISONZ() {
  // yyyy-mm-dd in Pacific/Auckland
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

// ─── Status helpers ────────────────────────────────────────────────────
const STATUS_LABEL = {
  pending: "Pending",
  draft_ready: "Draft ready",
  approved_pending_send: "Approved — awaiting email",
  chased: "Chased",
  followed_up: "Followed up",
  received: "Received",
  not_supplying: "Not supplying",
  skipped: "Skipped",
  overdue: "Overdue",
};

// ─── Template rendering (deterministic — no AI) ────────────────────────
function renderTemplate(tpl, vars) {
  const out = { subject: "", body: "" };
  const r = (s) => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  out.subject = r(tpl.subject);
  out.body = r(tpl.body);
  return out;
}

// ─── Auth: reuse the Sveltia GitHub OAuth token ────────────────────────
// Sveltia stores the current user under 'sveltia-cms.user' in localStorage,
// as a JSON string with { backendName, token, login, name, ... }.
// We piggy-back on that so there's exactly one login flow for the editor.
function getAuth() {
  const candidates = ["sveltia-cms.user", "decap-cms-user", "netlify-cms-user"];
  for (const key of candidates) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (user && user.token) {
        return { token: user.token, login: user.login || user.name || "editor", source: key };
      }
    } catch { /* ignore malformed */ }
  }
  return null;
}

// ─── GitHub API helpers ────────────────────────────────────────────────
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
    sha,
    branch: BRANCH,
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
  return await res.json();
}

// ─── App state ─────────────────────────────────────────────────────────
const state = {
  auth: null,
  data: null,       // { rosters: [...], chase_templates: {...} }
  shas: {},         // path -> current sha from GitHub (populated on first write)
  filter: "actionable",   // default hides received/not_supplying/skipped
  search: "",
  editedDrafts: readLS(EDIT_DRAFT_KEY, {}),  // keyed by `${rosterKey}:${issue_date}`
  approvedMap: readLS(APPROVED_KEY, {}),      // same keying
};

function readLS(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function writeLS(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore quota */ }
}

function slotKey(rosterKey, slot) { return `${rosterKey}:${slot.issue_date}`; }

// ─── Load + boot ───────────────────────────────────────────────────────
async function boot() {
  state.auth = getAuth();
  renderBanner();
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load roster data (${res.status})`);
    state.data = await res.json();
  } catch (e) {
    showError(`Failed to load /admin-data/roster.json: ${e.message}. If this is the first deploy of the Roster feature, the site may still be rebuilding.`);
    return;
  }
  render();
}

// ─── Banner (status strip) ─────────────────────────────────────────────
function renderBanner() {
  const b = document.getElementById("banner");
  const bits = [];
  bits.push(`<strong>⚠ Email sending is not connected yet</strong> — Phase 1 is review-and-copy. Approving a draft puts it on your clipboard; you still need to send it from your normal email.`);
  if (state.auth) {
    bits.push(`Signed in as <strong>${escapeHtml(state.auth.login)}</strong>.`);
  } else {
    bits.push(`Not signed in — <a href="/admin/">log in via the CMS editor</a>, then come back here.`);
  }
  b.className = "banner banner--warn";
  b.innerHTML = bits.join(" &nbsp;·&nbsp; ");
  b.hidden = false;
}

// ─── Rendering ─────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (!state.data || !state.data.rosters) {
    app.innerHTML = `<p class="loading">No roster data.</p>`;
    return;
  }

  const today = todayISONZ();
  const buckets = bucketise(today);

  app.append(
    sectionNeedsAttention(buckets.needsAttention, today),
    sectionDrafts(buckets.drafts),
    sectionUpcoming(buckets.upcoming, today),
    sectionAll(buckets.all),
    sectionContributorsMissingEmail(buckets.missingEmails),
  );
}

// Compute everything the UI needs from the raw roster data.
function bucketise(today) {
  const needsAttention = [];
  const drafts = [];
  const upcoming = {}; // rosterKey -> [rows]
  const all = [];
  const missingEmails = [];

  for (const roster of state.data.rosters) {
    const byKey = Object.fromEntries(roster.contributors.map((c) => [c.key, c]));
    upcoming[roster.key] = [];
    for (const c of roster.contributors) {
      if (!c.self_authored && !c.email) missingEmails.push({ roster: roster.label, contributor: c });
    }

    for (const slot of roster.slots) {
      const contrib = byKey[slot.contributor_key] || { organisation: slot.contributor_key, display_name: "(unknown)", email: "", self_authored: false };
      const dueDays = daysBetween(today, slot.due_date);
      const issueDays = daysBetween(today, slot.issue_date);
      const row = { roster, slot, contrib, dueDays, issueDays };

      all.push(row);

      // Needs attention: upcoming + no action + overdue
      const inWindow = dueDays != null && dueDays >= -3 && issueDays != null && issueDays >= -2;
      const actionable = ["pending", "draft_ready", "chased"].includes(slot.status);
      const sKey = slotKey(roster.key, slot);
      const approvedAt = state.approvedMap[sKey];
      row.approvedAt = approvedAt;

      if (inWindow && actionable && !contrib.self_authored) {
        needsAttention.push(row);
      }

      // Drafts ready: needs a chase, has contributor email, within lead_days window,
      // and not more than a few days past the due date (so we don't draft chases
      // for historical slots that just weren't marked received in the sheet).
      const lead = roster.default_lead_days ?? 10;
      const shouldDraft =
        actionable &&
        !contrib.self_authored &&
        contrib.email &&
        dueDays != null &&
        dueDays <= lead &&
        dueDays >= -3 &&
        issueDays != null &&
        issueDays >= -1;

      if (shouldDraft) {
        const tplKey = pickTemplate(roster, slot);
        const tpl = state.data.chase_templates[tplKey];
        if (tpl) {
          const rendered = renderTemplate(tpl, {
            display_name: contrib.display_name || contrib.organisation,
            organisation: contrib.organisation,
            due_date_long: fmtLong(slot.due_date),
            due_date_short: fmtShort(slot.due_date),
            issue_date_long: fmtLong(slot.issue_date),
            issue_date_short: fmtShort(slot.issue_date),
          });
          const editKey = sKey + ":" + tplKey;
          const edited = state.editedDrafts[editKey];
          drafts.push({
            ...row,
            tplKey,
            tplLabel: tpl.label || tplKey,
            editKey,
            subject: edited?.subject ?? rendered.subject,
            body: edited?.body ?? rendered.body,
            isEdited: !!edited,
          });
        }
      }

      // Upcoming: next 42 days
      if (issueDays != null && issueDays >= -1 && issueDays <= 42) {
        upcoming[roster.key].push(row);
      }
    }

    upcoming[roster.key].sort((a, b) => (a.slot.issue_date || "").localeCompare(b.slot.issue_date || ""));
  }

  needsAttention.sort((a, b) => (a.slot.issue_date || "").localeCompare(b.slot.issue_date || ""));
  drafts.sort((a, b) => (a.slot.issue_date || "").localeCompare(b.slot.issue_date || ""));
  all.sort((a, b) => (a.slot.issue_date || "").localeCompare(b.slot.issue_date || ""));

  return { needsAttention, drafts, upcoming, all, missingEmails };
}

function pickTemplate(roster, slot) {
  const base = roster.template_key || roster.key;
  // If already chased once, next step is followup; otherwise first.
  const alreadyChased = (slot.chase_log || []).some((e) => e.template && e.template.endsWith("_first"));
  return alreadyChased || slot.status === "chased" ? `${base}_followup` : `${base}_first`;
}

// ───── Section: Needs attention ────────────────────────────────────────
function sectionNeedsAttention(rows, today) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Needs attention", rows.length, "Slots due in the next couple of weeks that still need chasing."));

  if (rows.length === 0) {
    sec.append(el("div", { class: "section__empty" }, "Nothing urgent — nice."));
    return sec;
  }

  const grid = el("div", { class: "slot-grid" });
  for (const row of rows) grid.append(slotCard(row, today));
  sec.append(grid);
  return sec;
}

// ───── Section: Drafts ready ───────────────────────────────────────────
function sectionDrafts(drafts) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Drafts ready", drafts.length, "Review, edit if needed, then copy to your email."));

  if (drafts.length === 0) {
    sec.append(el("div", { class: "section__empty" }, "No chase drafts right now."));
    return sec;
  }

  const stack = el("div", { class: "draft-stack" });
  for (const d of drafts) stack.append(draftCard(d));
  sec.append(stack);
  return sec;
}

// ───── Section: Upcoming ───────────────────────────────────────────────
function sectionUpcoming(byRoster) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Upcoming — next 6 weeks", undefined, "Everything in the pipeline, both rosters."));

  for (const roster of state.data.rosters) {
    const rows = byRoster[roster.key] || [];
    const block = el("div", { class: "upcoming__roster" });
    const head = el("div", { class: "upcoming__roster-head" });
    head.append(
      el("h3", { class: "upcoming__roster-name" }, roster.label),
      el("span", { class: "muted" }, `${rows.length} upcoming`),
    );
    block.append(head);

    if (rows.length === 0) {
      block.append(el("div", { class: "section__empty" }, roster.key === "schools"
        ? "Schools roster not populated yet — add contributors + slots via the CMS or send Corbyn the Google Sheet."
        : "Nothing upcoming."));
    } else {
      const list = el("div", { class: "upcoming__list" });
      for (const row of rows) list.append(upcomingRow(row));
      block.append(list);
    }
    sec.append(block);
  }

  return sec;
}

// ───── Section: All slots (filter + search) ────────────────────────────
function sectionAll(rows) {
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("All slots", rows.length, "Full history — filter by status, search by name."));

  const bar = el("div", { class: "filters" });
  const FILTERS = [
    { key: "actionable", label: "Actionable" },
    { key: "all", label: "All" },
    { key: "pending", label: STATUS_LABEL.pending },
    { key: "chased", label: STATUS_LABEL.chased },
    { key: "received", label: STATUS_LABEL.received },
    { key: "not_supplying", label: STATUS_LABEL.not_supplying },
  ];
  const chips = FILTERS.map(({ key, label }) => {
    const c = el("button", { class: "filters__chip", "aria-pressed": state.filter === key ? "true" : "false" }, label);
    c.addEventListener("click", () => { state.filter = key; render(); });
    return c;
  });
  const search = el("input", { class: "filters__search", type: "search", placeholder: "Search organisation or name…" });
  search.value = state.search;
  search.addEventListener("input", (e) => { state.search = e.target.value.toLowerCase(); render(); });
  bar.append(...chips, search);
  sec.append(bar);

  const ACTIONABLE = new Set(["pending", "draft_ready", "chased", "followed_up"]);
  const filtered = rows.filter((r) => {
    if (state.filter === "actionable" && !ACTIONABLE.has(r.slot.status)) return false;
    else if (state.filter !== "actionable" && state.filter !== "all" && r.slot.status !== state.filter) return false;
    if (state.search) {
      const haystack = `${r.contrib.organisation} ${r.contrib.display_name} ${r.contrib.email}`.toLowerCase();
      if (!haystack.includes(state.search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    sec.append(el("div", { class: "section__empty" }, "No slots match."));
    return sec;
  }

  const list = el("div", { class: "upcoming__list" });
  for (const row of filtered.slice(0, 100)) list.append(upcomingRow(row, { showActions: true }));
  if (filtered.length > 100) sec.append(el("p", { class: "muted" }, `Showing first 100 of ${filtered.length}.`));
  sec.append(list);
  return sec;
}

function sectionContributorsMissingEmail(entries) {
  if (entries.length === 0) return document.createDocumentFragment();
  const sec = el("section", { class: "section" });
  sec.append(sectionHead("Contributors without an email", entries.length, "These contributors cannot be chased until an email is added via the CMS editor."));
  const list = el("ul", { style: "list-style: disc; padding-left: 1.2rem; color: var(--muted); margin: 0;" });
  for (const e of entries) {
    list.append(el("li", {},
      el("strong", {}, `${e.contributor.organisation}`),
      ` — ${e.contributor.display_name || "(no contact)"} — `,
      el("em", {}, e.roster),
    ));
  }
  sec.append(list);
  return sec;
}

// ─── Card builders ────────────────────────────────────────────────────
function sectionHead(title, count, sub) {
  const h = el("div", { class: "section__head" });
  const t = el("h2", { class: "section__title" }, title);
  if (count !== undefined) t.append(el("span", { class: "section__count" }, String(count)));
  h.append(t);
  if (sub) h.append(el("span", { class: "section__sub muted" }, sub));
  return h;
}

function slotCard(row, today) {
  const tpl = document.getElementById("tpl-slot-card").content.cloneNode(true);
  const art = tpl.querySelector(".slot-card");
  const due = parseISO(row.slot.due_date);
  art.querySelector(".slot-card__dayNum").textContent = due ? due.day : "—";
  art.querySelector(".slot-card__month").textContent = due ? monthShort[due.month - 1] : "";
  art.querySelector(".slot-card__pub").innerHTML = `Due <strong>${fmtShort(row.slot.due_date)}</strong><br>Issue ${fmtShort(row.slot.issue_date)}`;
  art.querySelector(".slot-card__org").textContent = row.contrib.organisation;
  art.querySelector(".slot-card__contact").textContent = row.contrib.display_name || "";
  const status = row.dueDays != null && row.dueDays < 0 && !["received", "not_supplying", "skipped"].includes(row.slot.status) ? "overdue" : row.slot.status;
  const badge = art.querySelector(".slot-card__status");
  badge.textContent = STATUS_LABEL[status] || status;
  badge.setAttribute("data-status", status);
  if (status === "overdue") art.classList.add("slot-card--overdue");
  art.querySelector(".slot-card__email").textContent = row.contrib.email || "no email on file";
  if (row.slot.notes) {
    const n = art.querySelector(".slot-card__notes");
    n.hidden = false;
    n.textContent = row.slot.notes;
  }
  const actions = art.querySelector(".slot-card__actions");
  renderSlotActions(actions, row);
  return art;
}

function upcomingRow(row, { showActions = false } = {}) {
  const wrap = el("div", { class: "upcoming__row" });
  if (row.dueDays != null && row.dueDays < 0 && !["received", "not_supplying", "skipped"].includes(row.slot.status)) {
    wrap.classList.add("upcoming__row--overdue");
  }
  wrap.append(
    el("div", { class: "upcoming__row-date" }, fmtShort(row.slot.issue_date)),
    (() => {
      const who = el("div", { class: "upcoming__row-who" });
      who.append(
        el("strong", {}, row.contrib.organisation),
        el("span", { class: "muted" }, row.contrib.display_name || "(no contact)"),
      );
      return who;
    })(),
    (() => {
      const status = row.dueDays != null && row.dueDays < 0 && !["received", "not_supplying", "skipped"].includes(row.slot.status) ? "overdue" : row.slot.status;
      const b = el("span", { class: "badge", "data-status": status }, STATUS_LABEL[status] || status);
      return b;
    })(),
    el("div", { class: "upcoming__row-days" }, (() => {
      // For completed/retired slots, show a neutral descriptor rather than overdue days.
      if (row.slot.status === "received") return "received";
      if (row.slot.status === "not_supplying") return "cancelled";
      if (row.slot.status === "skipped") return "skipped";
      if (row.dueDays == null) return "";
      if (row.dueDays === 0) return "due today";
      return row.dueDays > 0 ? `due in ${row.dueDays}d` : `${-row.dueDays}d overdue`;
    })()),
  );
  if (showActions) {
    const bar = el("div", { class: "slot-card__actions", style: "grid-column: 1 / -1" });
    renderSlotActions(bar, row);
    wrap.append(bar);
  }
  return wrap;
}

function draftCard(d) {
  const tpl = document.getElementById("tpl-draft-card").content.cloneNode(true);
  const art = tpl.querySelector(".draft-card");
  art.querySelector(".draft-card__name").textContent = d.contrib.display_name || d.contrib.organisation;
  art.querySelector(".draft-card__email").textContent = d.contrib.email;
  art.querySelector(".draft-card__subject").textContent = d.subject;
  art.querySelector(".badge--roster").textContent = d.roster.label;
  const statusEl = art.querySelector(".draft-card__status");
  statusEl.setAttribute("data-status", d.approvedAt ? "approved_pending_send" : "draft_ready");
  statusEl.textContent = d.approvedAt ? "Approved — awaiting email" : STATUS_LABEL.draft_ready;

  const ta = art.querySelector(".draft-card__textarea");
  ta.value = d.body;
  ta.addEventListener("input", () => {
    state.editedDrafts[d.editKey] = { subject: d.subject, body: ta.value };
    writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
  });

  const actions = art.querySelector(".draft-card__actions");

  const btnCopy = btn("Copy email", "btn--primary", () => {
    const text = `Subject: ${d.subject}\n\n${ta.value}`;
    navigator.clipboard.writeText(text).then(
      () => toast(`Copied — paste into an email to ${d.contrib.email}`),
      () => toast("Clipboard blocked — select the text to copy manually.", true),
    );
    state.approvedMap[slotKey(d.roster.key, d.slot)] = new Date().toISOString();
    writeLS(APPROVED_KEY, state.approvedMap);
    render();
  });

  const btnMailto = btn("Open in email client", "btn--ghost", () => {
    const href = `mailto:${encodeURIComponent(d.contrib.email)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(ta.value)}`;
    window.location.href = href;
  });

  const btnMarkChased = btn("I sent it — mark chased", "btn--primary", () => markChased(d, ta.value));
  const btnReset = btn("Reset to template", "btn", () => {
    delete state.editedDrafts[d.editKey];
    writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
    render();
  });
  const btnSkip = btn("Skip this cycle", "btn btn--danger-ghost", () => {
    if (confirm(`Skip ${d.contrib.organisation}'s chase for ${fmtShort(d.slot.issue_date)}? (The slot stays, no email will be drafted.)`)) {
      updateSlotStatus(d.roster.key, d.slot, "skipped", `Skipped from drafts panel on ${todayISONZ()}`);
    }
  });

  actions.append(btnCopy, btnMailto, btnMarkChased);
  if (d.isEdited) actions.append(btnReset);
  actions.append(btnSkip);

  return art;
}

function renderSlotActions(container, row) {
  container.innerHTML = "";
  const s = row.slot.status;
  if (!["received", "not_supplying", "skipped"].includes(s)) {
    container.append(btn("Mark received", "btn--small btn--primary", () =>
      updateSlotStatus(row.roster.key, row.slot, "received", `Received on ${todayISONZ()}`),
    ));
    container.append(btn("Not supplying", "btn--small btn--danger-ghost", () => {
      if (confirm(`Mark ${row.contrib.organisation} as not supplying for ${fmtShort(row.slot.issue_date)}?`)) {
        updateSlotStatus(row.roster.key, row.slot, "not_supplying", `Not supplying this cycle (${todayISONZ()})`);
      }
    }));
  } else {
    container.append(btn("Reopen", "btn--small btn--ghost", () =>
      updateSlotStatus(row.roster.key, row.slot, "pending", `Reopened on ${todayISONZ()}`),
    ));
  }
}

// ─── Mutations ─────────────────────────────────────────────────────────
async function markChased(d, bodyText) {
  const now = new Date().toISOString();
  await mutateRoster(d.roster.key, (r) => {
    const idx = r.slots.findIndex((s) => s.issue_date === d.slot.issue_date && s.contributor_key === d.slot.contributor_key);
    if (idx === -1) throw new Error("Slot not found in current roster file");
    const slot = r.slots[idx];
    slot.status = slot.status === "chased" ? "followed_up" : "chased";
    slot.chase_log = slot.chase_log || [];
    slot.chase_log.push({
      at: now,
      by: state.auth?.login || "unknown",
      channel: "manual_copy",
      template: d.tplKey,
      subject: d.subject,
      body: bodyText,
    });
    return `chore(roster): chase sent for ${d.roster.label} — ${d.contrib.organisation} (${d.slot.issue_date})`;
  });
  // Clear the local draft edits + approved marker — the chase is done.
  delete state.editedDrafts[d.editKey];
  delete state.approvedMap[slotKey(d.roster.key, d.slot)];
  writeLS(EDIT_DRAFT_KEY, state.editedDrafts);
  writeLS(APPROVED_KEY, state.approvedMap);
  toast(`Marked as chased — ${d.contrib.organisation}`);
}

async function updateSlotStatus(rosterKey, slotRef, newStatus, note) {
  await mutateRoster(rosterKey, (r) => {
    const idx = r.slots.findIndex((s) => s.issue_date === slotRef.issue_date && s.contributor_key === slotRef.contributor_key);
    if (idx === -1) throw new Error("Slot not found in current roster file");
    r.slots[idx].status = newStatus;
    if (note) {
      r.slots[idx].notes = r.slots[idx].notes ? `${r.slots[idx].notes}; ${note}` : note;
    }
    return `chore(roster): ${r.roster.label} slot ${slotRef.issue_date} → ${newStatus}`;
  });
  toast(`Status updated → ${STATUS_LABEL[newStatus] || newStatus}`);
}

// mutateRoster — fetch latest YAML from GitHub, apply `mutator`, commit back.
// mutator receives the parsed roster object and returns a commit message.
async function mutateRoster(rosterKey, mutator) {
  if (!state.auth) {
    toast("Sign in to the CMS first, then come back.", true);
    throw new Error("not signed in");
  }
  const path = `src/_data/rosters/${rosterKey}.yml`;
  const fresh = await ghGet(path, state.auth.token);
  const parsed = jsyaml.load(fresh.content);
  const message = mutator(parsed);
  const yamlOut =
    "# Edited via /admin/roster/. Also editable via the CMS at /admin/cms/.\n\n" +
    jsyaml.dump(parsed, { lineWidth: 100, noRefs: true });
  await ghPut(path, { content: yamlOut, sha: fresh.sha, message, token: state.auth.token });

  // Optimistic in-memory update so the UI reflects immediately,
  // Netlify's rebuild will catch up within a minute.
  const roster = state.data.rosters.find((r) => r.roster.key === rosterKey);
  if (roster) {
    roster.contributors = parsed.contributors;
    roster.slots = parsed.slots;
  }
  render();
}

// ─── UI primitives ────────────────────────────────────────────────────
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
function toast(msg, isError) {
  const t = el("div", { class: `toast${isError ? " toast--error" : ""}` }, msg);
  document.getElementById("toast-host").append(t);
  setTimeout(() => t.remove(), 4000);
}
function showError(msg) {
  document.getElementById("app").innerHTML = `<div class="section__empty" style="color:var(--red-dark)">${escapeHtml(msg)}</div>`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ─── Go ───────────────────────────────────────────────────────────────
boot();
