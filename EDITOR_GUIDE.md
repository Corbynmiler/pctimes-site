# How to update the Pōhutukawa Coast Times website

Hi Leanne — here's everything you need to keep the site up to date.
You log into one page (`/admin`) and the site rebuilds itself.

---

## Logging in

You log in with a **GitHub account**. Don't worry — you don't need to know what
GitHub is. It's just the service that quietly stores your website.

1. Go to **pctimes.co.nz/admin**.
2. Click **Sign in with GitHub**.
3. **First time only**: GitHub will ask you to authorise "Sveltia CMS" — click
   **Authorize**. (Corbyn will set up your GitHub account in advance and walk
   you through this once.)
4. You'll see a left-hand menu with sections like 📰 *This week's paper*,
   🗂 *Previous issues*, 💼 *Advertising*, etc.

> The browser remembers you. After the first login it should just open up
> straight to the editor.

---

## Publishing the weekly paper (the one you'll do every Friday)

This is the only thing you need to do most weeks.

1. Open **📰 This week's paper → Current issue**.
2. Update **Issue number** (e.g. 1620 → 1621).
3. Update **Date of this issue** (the Friday it goes out).
4. Click **Upload this week's paper PDF** → choose the new PDF on your computer.
5. (Optional) Click **Front page image** → upload a photo or screenshot of the front page.
6. Under **In this issue**, type a few headlines — one per line. Drag the ≡ icon to reorder.
7. Click the **Save** / **Publish** button at the top.

That's it. The site rebuilds in about 30–60 seconds. Refresh `pctimes.co.nz/latest-issue/` and you'll see the new edition.

### About the "Read online" flipbook field

If you ever set up a flipbook (Issuu, Yumpu, Flipsnack etc.), paste its URL into the **Read online (flipbook) URL** field. The site will automatically add a "Read online" button alongside the PDF.

Leave the field empty and the site just uses the standard PDF viewer — exactly like now.

---

## Moving last week's issue into the back-issues list

Optional — only if you want it to show in *Previous issues*:

1. Open **🗂 Previous issues → Back-issues list**.
2. Click **+ Add Recent issue** at the top of the list.
3. Type the issue number, date, and click the PDF picker to upload (or select) the PDF.
4. Save.

You can drag items in the list to reorder. To remove the oldest one, click the **×** next to it.

---

## Updating the Property Guide

In **📰 This week's paper**, scroll to the **Property Guide** section at the bottom:

- Tick / untick **Show the Property Guide on the site?**
- Update the **Month / date label** (e.g. "May 2026")
- Upload the new PDF

---

## Updating the rate card

1. Open **💼 Advertising → Advertising page**.
2. Scroll to **Rate card → Upload rate card PDF**, click it, upload the new card.
3. Update **Last updated** (e.g. "May 2026").
4. Save.

You can also update the **Why advertise** bullets, rates, and the manager's contact details from this section.

---

## Updating the team / "Our People"

Open **👥 Team / Our People → Team**:

- Edit anyone's name, role, photo or bio.
- Click **+ Add Team member** to add someone new.
- Click the **×** next to a member to remove them.
- Drag items in the list to reorder.

Production partners (Content Room, NZME) live in their own short list below the team.

---

## Updating contact details / address / phones / emails

Open **⚙️ Site settings → General settings**, scroll to **Contact details**, edit the fields, save. This updates the footer, About page and Contact page automatically.

---

## Adding a community event

1. Open **📅 Community → Community calendar**.
2. Click **+ Add Event** at the top of the *Events list*.
3. Fill in title, date, optional time / location / description.
4. Save.

To remove an old event, click its **×**.

---

## Changing the home page hero / gallery

Open **🏠 Home page → Home page**:

- **Hero** — the big banner at the top. Change the headline, subhead, background photo, or the two button labels.
- **Photo gallery** — the strip of local photos. Add/remove/reorder.
- **About strip** — the short paragraph in the middle of the home page.

---

## Editing the About page

Open **ℹ️ About page → About page**. Each section has a heading and a body. The body supports **bold**, *italic*, and links — use the toolbar at the top of the editor.

---

## Common questions

**"I uploaded a PDF but the site still shows the old one."**
Wait 30–60 seconds, then refresh the page in your browser (hold Shift while clicking refresh). Netlify rebuilds the site every time you save.

**"How big can the PDFs be?"**
Anything under about 20 MB is fine. Most weekly papers are around 5 MB.

**"I made a mistake — can I undo it?"**
Yes. Every save is tracked. Ring Corbyn and he can roll the site back in about a minute.

**"Can I edit on my iPad?"**
Yes — `/admin` works on iPad and laptop. (Phones too, but the editor's easier on a bigger screen.)

**"Do I have to fill in every field?"**
No. Anything marked *(optional)* can be left blank. The site handles missing things gracefully.

---

## Leaving notes for other editors

At the bottom of every section in the admin you'll find a collapsed
**Notes for editors** box. Click to expand. Whatever you type there is
visible to anyone editing the site in `/admin` but **never** shown on the
public website.

Use it for things like *"Melody, this rate card is out of date — please
upload May 2026 version"* or *"remember the deadlines PDF needs updating
every January"*. Handy if Leanne ever invites collaborators.

---

## If something looks broken

Don't panic — nothing you do in `/admin` can break the site permanently. Ring Corbyn.
