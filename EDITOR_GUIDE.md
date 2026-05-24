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

This is the only thing you need to do most weeks. **No need to move the old one
to the archive** — the newest issue is automatically "this week's paper" and the
previous one drops into "Previous issues" by itself.

1. Open **📰 Issues** in the sidebar.
2. Click **+ New Issue** at the top of the list.
3. **Issue number** — e.g. 1621.
4. **Date of this issue** — the Friday it goes out.
5. **Upload paper PDF** — choose the new PDF on your computer.
6. (Optional) **Front page image** — upload a photo or screenshot of page 1.
7. **In this issue** — type a few headlines, one per line. Drag the ≡ to reorder.
8. Click **Save** / **Publish** at the top.

That's it. The site rebuilds in about 30–60 seconds. Refresh `pctimes.co.nz` and
the new edition is the headline; the previous one slides into Previous Issues.

### About the "Read online" flipbook field

If you ever set up a flipbook (Issuu, Yumpu, Flipsnack etc.), paste its URL
into the **Read online (flipbook) URL** field. The site adds a "Read online"
button alongside the PDF. Leave the field empty and the site uses the standard
PDF viewer.

### Editing a past issue

In **📰 Issues**, click any issue in the list to edit its details. The "Previous
issues" archive on the public site updates immediately when you save.

### Removing an issue

Open the issue → click **Delete** (top right of the editor). The card disappears
from the archive next time the site rebuilds.

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

There are two patterns:

**A) One-off event** (a date in the future, like a quiz night or fundraiser)
1. Open **📅 Community → Community calendar**.
2. Click **+ Add Event**.
3. Fill in **title**, **date** (and optionally time / location / description).
4. Save.

**B) Recurring weekly group** (Mondays / Tuesdays / Saturdays / etc.)
1. Click **+ Add Event**.
2. Set the **title** to the weekday (e.g. *Mondays*).
3. **Leave date, time and location blank.**
4. In **description**, type each activity on its own line starting with a `•`:
   ```
   • CASUAL BADMINTON: 7.30-9pm, Te Puru Centre, $7.

   • COASTAL PLAYGROUP, 5 Jacobs Way, Maraetai. 9am–12pm.
   ```
5. Save. The site turns those `•` lines into a clean bullet list automatically.

To remove an item, click its **×**.

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
