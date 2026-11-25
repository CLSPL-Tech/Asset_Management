# Asset Manager - setup (about 20 minutes)

Files: `index.html`, `app.js`, `config.js` (the web app), `schema.sql` (the database), `asset_import_template.csv` (example import file).

## 1. Create a free Supabase account and project
1. Go to supabase.com, click **Start your project**, sign in with GitHub or email.
2. Click **New project**. Name it, use **Generate a password** and save it, choose the Mumbai region, Free plan. Leave "Enable Data API" and "Automatically expose new tables" ticked.
3. Wait 1 to 2 minutes.

## 2. Create the tables
1. Left bar > **SQL Editor** > **New query**.
2. Paste ALL of `schema.sql` and click **Run**. "Success" means done.
3. If you ever get a newer `schema.sql`, run it the same way. It is safe to run again; it does not delete data.

## 3. Copy your two keys into the app
1. **Project Settings** (gear) > **API Keys** / **Data API**.
2. Copy the **Project URL** and the **anon public** key (never the service_role key).
3. Paste them into `config.js` between the quotes. `LABEL_TITLE` is the text printed on every QR label (set to "CLSPL Asset").

## 4. Make sign-up easy
**Authentication** > **Sign In / Providers** > **Email**: turn **Confirm email** off.

## 5. Put the app online (needed for phone camera and location)
Netlify Drop: app.netlify.com/drop, drag the folder holding `index.html`, `app.js` and `config.js`. You get an https address. Optionally put that address into `APP_URL` in `config.js` and upload again, so QR codes always use it.

## 6. First login
1. In the app type your name, email, password and click **Create account**. You see "Waiting for approval".
2. In Supabase SQL Editor run (use your email):
   `update profiles set role = 'procurement' where email = 'you@example.com';`
3. Sign out and in again. Other people create their own accounts; give them a role in the **Users** tab. Until then they see nothing.

## 7. Normal use
- **Properties tab (Procurement):** add each property, its geo location ("Use my current location" while standing there), store location, and rooms. Rooms can be added in bulk (101, 102, Lobby).
- **Add asset:** fill the form. "Number of copies" creates that many separate assets, each with its own tag and QR.
  - **Bought first, placed later:** Procurement can leave **Property** as "Not assigned". Room and status stay empty, and the asset shows as **Unassigned**.
  - **Assigning:** the Projects team opens the asset (Assets tab, filter **Unassigned**) and fills **Property, Room (or Store) and Status**. All three are required; once an asset is assigned it always has a status. After saving, the label page opens for that asset.
  - **Printing:** only assigned assets print labels, because the label shows property and room. Until assigned, an asset cannot be audited, transferred or have its status changed.
- **Import tab:** upload an Excel or CSV file (format below).
- **Print QR tab:** pick Property, Room, Asset. Up to 100 labels show per page; use Next labels for more. Each label reads "CLSPL Asset", the QR, the tag number (AST-00012), item, property and room.
- **Scan tab (all roles):** scan the QR, or type the tag number. The auditor can change status and transfer to another room, another property, or a property's store.

## Import file format
Excel (.xlsx) or CSV, first sheet, **row 1 = these headers exactly** (small letters, underscores), in any order:

| Header | Required? | What to enter | Example |
|---|---|---|---|
| item_type | Yes | What the item is | Chair |
| description | No | Make / model / serial | Voltas 1.5 ton |
| property | If placed | Property name exactly as in the Properties tab. Empty = not assigned yet | Property A |
| room | If placed | Room name exactly as in the app, or STORE. Empty = not assigned yet | Lobby |
| status | If placed | working, repairable or damaged. Empty = not assigned yet | working |
| purchase_date | No | YYYY-MM-DD (DD/MM/YYYY also works) | 2025-04-15 |
| purchase_cost | No | Cost of ONE item, numbers only | 2500 |
| vendor | No | Vendor name | ABC Furniture |
| warranty_until | No | Last day of warranty | 2027-04-14 |
| notes | No | Any note | |
| quantity | No | Identical items this row creates, each with its own tag and QR (blank = 1, max 10,000) | 10 |

Rules:
- The columns **property, room and status must exist** in row 1 even if the cells are empty (this catches misspelled headers).
- **Not placed yet:** leave property, room and status all empty. **Placed:** property, room and status must all be filled. A row with only some of them is rejected.
- The property must already exist. A room must exist too, unless you are Procurement and tick "Create rooms that do not exist yet".
- The whole file is checked first and every mistake is listed by row number. Nothing is saved until the file is clean.
- Spelling of property and room is matched ignoring capital letters.
- In Excel, set date columns to Text or type dates as 2025-04-15. The screen shows the first rows after parsing so you can check dates before importing.
- Big files: 500 assets are saved per request, so 100,000 assets takes a few minutes. Import one property at a time, from a computer, and keep the tab open.
- After import, press **Print their QR labels**. Unassigned assets in the file are skipped on that page.

## Upgrading to a newer version
1. Supabase > SQL Editor > paste the new `schema.sql` > Run. It is safe on top of existing data.
2. On GitHub, upload the new `app.js` and `index.html` (Add file > Upload files, same names, commit).
3. **Do not upload `config.js` again** unless the keys changed. The copy in the zip may hold placeholders, and uploading it would break the live site.
4. Hard-refresh the app (Ctrl+F5). GitHub Pages can take a minute or two to update.

## Free-tier notes
- Free Supabase: about 500 MB database (enough for 100,000 assets), about 1 GB photo storage, no automatic backups, pauses after about a week of no use. Photos are optional; use them for valuable items. For all assets with photos, daily backups and no pausing, use Pro (about $25 a month).
- Photos are shrunk before upload and kept in a public bucket: anyone with the exact photo link can view it.


## Version 4 changes

**Upgrade:** (1) Supabase > SQL Editor > paste the new `schema.sql` > Run (safe on existing data). (2) On GitHub upload only `app.js` and `index.html`. Do NOT upload `config.js` again (it holds your keys). Optional: add the line `LABEL_MM: 50,` to your own config.js; 50 is the default. (3) Hard refresh with Ctrl+F5.

**Labels:** 50 mm (5 cm) square, 3 across and 5 down = 15 per A4 sheet; 90 labels (6 sheets) show at a time, use "Next labels" for more. In the print window choose A4, Scale 100%, Margins None, and untick "Headers and footers". Use A4 sticker sheets with 15 labels of 50 x 50 mm, or print on plain paper and cut along the dashed lines. Check the first sheet on plain paper before using stickers.

**Assigning one asset:** two buttons, "Assign" (stays on the asset) and "Assign and print label".

**Bulk assign:** Assets > Property filter = "Unassigned". A Bulk assign box appears (Procurement and Projects only).
- Put them all in one place: choose property, room (or Store), status. Tick rows in the list to assign only those, or leave nothing ticked and enter How many (blank = all matching). Use the Item filter, e.g. Chair.
- Spread across rooms: set the Item filter (e.g. Chair), items per room (e.g. 2), tick the rooms that should receive items (all start ticked, untick the ones to exclude; Store only if you tick it). Items are taken in tag order. If there are not enough assets for every ticked room, nothing is assigned.
- After a run, a "Print labels for these" button appears. Nothing prints automatically.

**Limits:** copies per asset form and `quantity` per import row are now up to 10,000 (saved in batches of 500).

## Version 5 changes

**Upgrade:** (1) Supabase > SQL Editor > paste the new `schema.sql` > Run (safe on existing data). (2) On GitHub upload only `app.js` and `index.html`. Do NOT upload `config.js`. (3) Hard refresh with Ctrl+F5.

**Audited OK:** open an asset (scan its QR) > Audit card > optionally add a note > **Audited OK**. Auditor, Projects and Procurement can do this. Each press is saved in the asset's **Audit history** with date, time, name, and the place and status the asset had at that moment (GPS too if the phone allows it). The latest audit shows on the asset page and in a **Last audited** column on the Assets list. Unassigned assets cannot be audited.

**Audit filters (Assets list):** Audit = "Audited at least once", "Never audited", or "Not audited since..." with a date (assets never audited are included). The Summary shows audited and not-audited counts, per property too.

**Bulk delete (Procurement only):** Assets list > open "Bulk delete". Tick rows, or leave nothing ticked and set filters; all assets matching the filters are deleted together with their history. More than 20 assets needs you to type DELETE. At least one tick or filter is required, so "delete everything" is not possible by accident. This cannot be undone.

**Login page:** "New user?" now has its own Name, Email and Password boxes, separate from the sign-in boxes.

## Version 6 changes (audit must be done at the property)

**Upgrade:** (1) Supabase > SQL Editor > paste the new `schema.sql` > Run. (2) On GitHub upload only `app.js` and `index.html`. Do NOT upload `config.js`. (3) Hard refresh with Ctrl+F5.

**Audit radius:** Properties > each property now has an **Audit radius** (metres, default 500). Procurement can change it (use a larger value for a big campus). Make sure every property has its latitude and longitude saved ("Use my current location" while standing at the property).

**How auditing now works:** when an auditor opens an asset (scan), the app checks their location automatically.
- At the recorded property (within its radius): **Audited OK** is enabled.
- At a different property: a prompt says the asset is recorded at X but you are at Y, with a one-step **Transfer to Y now** (choose room or Store). **Audited OK** stays disabled until the transfer is done.
- Away from every property: **Audited OK** is disabled and the app says how far you are.
- Location cannot be read, or the recorded property has no pin: the audit is allowed and the entry is marked **location not verified** (shown in the Audit history and on the asset page).
The same rule is enforced in the database, so it cannot be skipped. If two properties are within each other's radius, the recorded property wins.

## Version 7 changes

**Upgrade:** (1) Supabase > SQL Editor > paste the new `schema.sql` > Run. (2) On GitHub upload `app.js`, `index.html` (and `asset_import_template.csv` if you keep a copy there). Do NOT upload `config.js`. (3) Hard refresh with Ctrl+F5.

**Name, size, description:** the Add / Edit asset form now has **Name** (optional, e.g. "Executive chair") and **Size** (optional, e.g. "6 x 3 ft", "King", "1.5 ton") next to **Description**. Item type stays as the group used for counts and summaries (Chair, Split AC). Name and size show in the asset list, the asset page, and on the QR label (the label shows the name if there is one, otherwise the item type). Search finds assets by name.

**Photo:** already available. In Add / Edit asset use the Photo box (on a phone it opens the camera). It is resized to about 1 MB or less before upload. Photos for all 100,000 assets need the Supabase Pro plan.

**Projects team and rooms:** the Projects role now has a **Rooms** tab where it can add and delete rooms for any property. Only Procurement can add or edit properties themselves.

**To audit tab (Auditor, Projects, Procurement):** choose a property and how to count "not audited" (never audited, or not audited in the last 30 / 90 / 180 / 365 days). You get every room and the Store with how many assets are not audited. Tap a room to open the list of exactly those assets, then scan each one at the property and press Audited OK. "Show all of them" lists the whole property. (The Assets list also still has the Audit filter.)

**Import file:** two new optional columns, `name` and `size`, right after `item_type`. Existing files that do not have them still work. Download the new template from the Import tab or use `asset_import_template.csv`.

## Version 8 changes

**Upgrade:** (1) Supabase > SQL Editor > paste the new `schema.sql` > Run. (2) On GitHub upload only `app.js` (and `index.html` if you want to be safe). Do NOT upload `config.js`. (3) Hard refresh with Ctrl+F5.

**Properties tab (Procurement and Projects) is now one screen: property > rooms > assets.**
1. The first screen lists every property with its asset counts (total, working, repairable, damaged, audited) and room count. Procurement also gets **+ Add property** here.
2. Tap a property: its rooms and the Store, with asset counts and how many were never audited. Buttons: all assets of this property, and To audit. Procurement can edit the property (name, pin, radius, store) under "Edit property". Procurement and Projects can add and delete rooms.
3. Tap a room: the assets in that room (50 per page). Tap an asset to open it. Procurement and Projects get **Print labels for this room**.
The Assets tab stays for searching across all properties.

**Report tab (all roles): audited vs not audited.**
- Choose All properties or one property, and what counts as audited: audited at least once, or audited in the last 30 / 90 / 180 / 365 days.
- Shows assets placed, audited, not audited and % audited, by property; with a property chosen, also by room (including the Store). Below that is the list of not-audited assets (first 200 on screen).
- **Download Excel** gives a file with three sheets: By property, By room, and Not audited assets (the full list, not just 200).
- Assets not assigned to a property yet are left out because they cannot be audited.

## Version 9 changes (properties and assets in one tab)

**Upgrade:** only `app.js` and `index.html` changed (no database change, no new `schema.sql` needed if you ran the v8 one). Upload both to GitHub. Do NOT upload `config.js`. Hard refresh with Ctrl+F5.

The separate **Properties** tab is gone. Everything is in the **Assets** tab:
- **Property chips** at the top: All, each property with its asset count, and "Not assigned yet". Tap one to filter the list.
- **Room chips** appear when a property is chosen: All rooms, each room, and the Store, with counts. Tap one to filter to that room.
- **Settings and rooms** (opens under the chips when a property is chosen): Procurement can edit the property (name, store, map pin, audit radius). Procurement and Projects can add rooms and delete rooms. Procurement adds a new property under "+ Add property" when All is selected.
- **Print labels for these** (Procurement and Projects, when a property is chosen) prints the labels of the assets currently shown, for example one room.
- Search, item, status and audit filters, bulk assign (on "Not assigned yet"), bulk delete and + Add asset work as before.
Old bookmarks to the Properties page open the Assets tab.

## Upgrading to v10 (Settings, floors, categories, deactivate, graphs)

1. Supabase > SQL Editor > paste all of the new `schema.sql` > Run. It is safe to run again; existing data is kept.
2. Upload the new `app.js` and `index.html` to GitHub (do not replace `config.js`). Hard refresh with Ctrl+F5.

What is new:
- **Settings tab** (Procurement and Projects): Company (name, GST, heading printed on QR labels), Properties, Floors, Rooms (property > floor > room type, then room numbers; `201-210` creates ten rooms), Room types, Asset categories and items. Only Procurement edits company and property details.
- Existing rooms stay as they are and show "no floor" until you set one.
- **Add asset**: choose Category, then Item, then optionally Property > Floor > Room. After saving you stay on the asset list; no QR screen appears.
- **Print QR**: choose directly by property, floor, room, category, item, tag number range, or a single asset.
- **Bulk assign**: pick property, then floor and room type to narrow the room list; spread mode groups rooms by floor.
- **Nothing is deleted any more.** Assets, rooms, floors and properties are deactivated and can be reactivated. Procurement ticks "Show deactivated" on the asset list to see and reactivate assets. A room cannot be deactivated while it has active assets, a floor while it has active rooms, a property while it has active rooms or assets.
- **Colours and graphs**: Summary (condition and audited donuts, audited vs not audited by property, top items), Report, and To audit (per-room bars).
- **Import**: optional `category` column; new categories and items are added to Settings automatically.
