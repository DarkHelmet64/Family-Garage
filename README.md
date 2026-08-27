# Family Garage

A vehicle log for a family's cars: fill up the tank, type in the pump reading,
and the site works out your MPG. It also keeps track of service — what's due
when, what's overdue, and what you've already had done and paid for.

No build step, no framework — plain HTML/CSS/JS, hosted for free on GitHub
Pages, data stored for free in Firebase Firestore. It updates live on every
device, so a fill-up logged at the pump is on the kitchen iPad before you're
home.

## How it works

- **Garage** (the site's root URL): every vehicle with its average MPG, its
  odometer, and a badge when something is **due soon** or **overdue**.
- **Vehicle page** (`?vehicle=<id>`): average MPG up top with a chart of your
  recent fill-ups, then the numbers that come out of the log (best, worst, cost
  per mile, average price per gallon, total spent on fuel), then service, then
  the gas log itself.
- **Add a vehicle** (`?new`): a name is all that's required; year/make/model
  and a starting odometer are optional.
- Tapping any row in the gas log or the service list opens it for editing, and
  that sheet is also where you delete it.
- Already keeping this in a spreadsheet? **More > Import from a spreadsheet**
  reads an `.xlsx` or `.csv` — fill-ups or service records — and works out the
  columns for itself. See [Importing from a spreadsheet](#importing-from-a-spreadsheet).

There's no PIN or login: anyone with the link can read and write. See the
security note at the bottom.

## One-time setup

### 1. Create a free Firebase project

1. Go to <https://console.firebase.google.com/> and create a new project
   (the free "Spark" plan is all you need).
2. In the project, click the **Web** icon (`</>`) to register a new web app.
   You don't need Firebase Hosting for this — just registering the app.
3. Firebase will show you a code snippet with an `import ... from "firebase/app"`
   line and a `const firebaseConfig = { ... }` object. **Only copy the values
   inside `firebaseConfig`** (apiKey, authDomain, projectId, etc.) — ignore
   the `import` line and the `initializeApp(...)` call, those are for a
   different (bundler-based) project setup and will break this site if pasted
   in as-is.
4. Open `firebase-config.js` in this repo and replace the `YOUR_...`
   placeholders inside `export const firebaseConfig = { ... }` with the ones you
   copied. Leave the `export const firebaseConfig = {` line and the file
   structure as they are.

### 2. Turn on Firestore

1. In the Firebase console, go to **Build > Firestore Database** and click
   **Create database** (choose any nearby region, "production mode" is fine).
2. Go to the **Rules** tab and replace the default rules with the contents of
   [`firestore.rules`](./firestore.rules) from this repo, then **Publish**.

### 3. Host it for free on GitHub Pages

1. In this repository on GitHub, go to **Settings > Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch",
   pick `main` and folder `/ (root)`.
3. Save. GitHub will give you a URL like
   `https://darkhelmet64.github.io/Family-Garage/` — that's your app. The
   first deploy takes a minute or two.

### 4. Add your vehicles

Open the URL, tap **More > + Add a vehicle**, and fill in a name. Do that for
each car. **More > Show QR code** gives you a QR code for the site — print it
and stick it in the glovebox, so logging a fill-up at the pump is one scan
instead of hunting for a link.

## The gas log

Tap **⛽ Log fill-up** every time you buy gas and enter:

- **Odometer** — the reading on the dash when you pulled in.
- **Gallons** and **total cost** — straight off the pump or the receipt.
- **Date** and **station** (optional).
- **Filled the tank all the way** — leave this checked if you filled it up.

### How MPG is worked out

MPG is measured **between full tanks**. When you fill the tank all the way, you
know exactly how much fuel the last stretch of driving used: it's however much
it took to fill it back up. So each full-tank fill-up gets:

> miles since the last full tank ÷ gallons put in since then

A few things follow from that, and they're all deliberate:

- **Your first fill-up has no MPG.** There's no full tank before it to measure
  from. The second one is your first real number.
- **Partial fills don't get their own MPG** — you don't know how empty the tank
  was. Uncheck "filled the tank all the way" and those gallons simply roll into
  the next full tank, which keeps the numbers honest if you top off.
- **The average is weighted by gallons**, not an average of the per-fill-up
  numbers. A 400-mile road trip counts for more than a 30-mile errand, which is
  what you'd want.
- **Order comes from the odometer, not the date you typed it in.** A receipt you
  find in the glovebox a month later slots into the right place in the sequence.

If you enter an odometer reading lower than the highest one on record, the app
stops and asks — that's almost always a typo, and a bad reading throws off every
MPG figure after it.

**Cost per mile** and **average price per gallon** come out of the same log, so
they show up on their own once you've logged a couple of tanks.

### Readings that get left out

A gas log collects two kinds of strange number, and only one of them is worth
ignoring:

- **Bad data.** Usually a fill-up that never got logged — the next tank then
  gets credited with two tanks' worth of miles and reports roughly **double**
  the real MPG. A mistyped odometer misses by more still.
- **Real driving.** Towing a trailer, a winter of school runs, a mountain trip.
  Genuinely unusual, genuinely yours, and it belongs in your numbers.

So a reading is set aside when it's **at least double this vehicle's usual** —
double, triple, quadruple, or more. That's the shape of a missed fill-up, and
it's out of reach of any real driving, which rarely moves fuel economy by more
than a third. A tank at 21 MPG in a van that normally does 30 stays in and
becomes your honest "worst"; a tank at 60 does not.

"Usual" is measured from the calmer half of your log, not from all of it. Taken
across every reading, the yardstick would be inflated by the very numbers it's
meant to catch — with five ordinary tanks and one missed fill-up, the missed
one *is* the top of the range. It takes five readings before any of this
applies; below that there's nothing to compare against. Separately, anything
under 5 MPG is treated as a typo whatever the rest of the log says, since no
car has ever done that.

**Nothing is hidden or deleted.** A reading that isn't counted still sits in the
gas log with its MPG struck through and a note saying why, and still appears on
the chart in grey. It's left out of the average, best, worst, and cost per mile
— the figures a bad number would distort — while **total fuel spent and total
gallons still count every drop**, because that's money you actually spent.

**You have the final say.** Tap any fill-up and there's a *Count this toward
your averages* tick box: turn a set-aside reading back on, or drop one the app
was happy with. Your choice sticks, and readings you've ruled on personally are
kept out of working out what "usual" means, so one deliberate oddity can't move
the bar for everything else.

## Importing from a spreadsheet

If you've been keeping this in Excel, Numbers, or Google Sheets, you don't have
to retype it. Open a vehicle, tap **More > Import from a spreadsheet**, choose
**⛽ Fill-ups** or **🔧 Service records**, and pick an `.xlsx` or a `.csv`.

Nothing is written until you've seen what it made of the file. The sheet that
comes up shows how many records it found, the first few exactly as they'll be
saved, and every row it's leaving out with the reason why — then the columns it
matched, in case any of them need pointing somewhere else.

It works out the layout for you:

- **Column names don't have to match anything.** For a gas log: Date, Fill Date,
  Odometer, Odo Reading, Mileage, Gallons, Litres, Total, Amount, Price/Gal,
  Partial?, Station. For service: Service, Work Done, Maintenance, Date
  Serviced, Completed, Odo, Cost, Amount, Shop, Garage, Performed By, Notes,
  Next Due, Due At. All recognised, in any order. Anything it gets wrong you can
  change with the dropdowns, and the preview updates as you do.
- **The header doesn't have to be row 1.** Title rows and blank lines above it
  are fine, and a workbook with several tabs opens on the one that actually
  looks like a fuel log.
- **Dates in any of the usual shapes** — real Excel dates, `2026-03-14`,
  `3/14/2026`, `14/03/2026`, `March 14, 2026`. If the column is
  day-first, one unambiguous row (anything above the 12th in front) sets the
  whole column that way.
Rows it can't use (a totals line at the bottom, a fill-up with no odometer
reading) are listed by their real row number in the spreadsheet, so you can go
look at row 14 and see row 14.

**Importing the same file twice is safe.** A record already in the log is
recognised and skipped rather than added again, so you can re-import after
adding a few rows and only the new ones come across. Rows repeated *within* the
file are caught the same way, and reported separately so you can tell which is
which.

### Fill-ups

- **Litres are converted to gallons**, with the box already ticked if the
  column is named that way. Untick it if it's wrong; the gallons in the preview
  change straight away.
- **No total-cost column?** If the sheet records the pump price per gallon
  instead, the cost of each stop is worked out from that.
- **Full vs. partial tanks** come from a Full Tank or Partial column, whichever
  the sheet has. With neither, every row is treated as a full tank — that's what
  most logs record, and it's what MPG needs.
- A fill-up counts as one you already have when its **date and odometer** match.

Once the fill-ups land, MPG, cost per mile, and the rest are recalculated over
the whole history, imported and hand-entered alike.

### Service records

A service sheet is usually history — what was done, when, and what it cost — but
plenty of them carry a "next due" column as well, so both come across in one go:

- A row with a **date done or an odometer reading** becomes **history**, with
  its cost, shop, and notes.
- A row with **only a next-due date or mileage** becomes a **scheduled job**,
  and turns up in the Service list (and on the garage badge) like one you'd
  entered by hand.
- A row with a name but no date, mileage, or due date can't be placed, so it's
  left out and listed.

Two records count as the same one when the **service name, date, and odometer**
all match — so two oil changes a year apart both come across, but importing the
same sheet twice doesn't double them.

Repeat intervals aren't set by an import, even if the sheet has a column for
them. A history of twelve oil changes would otherwise schedule twelve identical
reminders. Set the interval once, on the next service you log or mark done, and
it carries forward from there.

### If the file won't open

- **`.xls`** (the pre-2007 binary format) isn't readable here — open it and use
  **File > Save As** to make an `.xlsx`, then import that.
- Anything else that won't parse: export the sheet as **CSV** and import that
  instead. It goes through a completely separate reader, and every feature above
  works the same way.

## Service

Tap **🔧 Add service** for either:

- **Schedule something coming up** — a name ("Oil change", "State inspection"),
  and a due date, a due mileage, or both. Whichever comes first is what the
  reminder goes by.
- **Log service already done** — what it was, when, the odometer, what it cost,
  and which shop.

Open services are sorted with the most pressing first and color-coded: red for
**overdue** (the date has passed, or you've driven past the mileage), amber for
**due soon** (within 30 days or 500 miles), plain for everything further out.
The garage list shows the same badge on the vehicle, so you can see the truck
needs something without opening it.

When you log a completed service you can also set **do it again in ___ miles**
or **___ months**. That schedules the next one right then — log an oil change at
49,240 miles with "again in 5,000 miles", and "Oil change, due at 54,240 mi"
appears on the list. **Mark done** on a scheduled service does the same thing:
it fills in today's date and your current odometer, and rolls the next one
forward if the service repeats.

Nothing here sends notifications — there's no server to send them. The app knows
what's due whenever you open it, which is what the badge on the garage list is
for.

### Receipt photos

A completed service record can carry photos of the receipt. They're added in the
same sheet you log the work in — **+ Photo** under *Receipt photos* — so a
receipt can go on as the service is logged rather than after saving and
reopening it. The same sheet is where you'd add one later: tap the record, add
the photo, save.

Tap a thumbnail to see it full size, which is also where **Remove** is. A record
with receipts shows a 📎 and a count in the service list, and deleting the record
takes its photos with it.

**Where they're stored.** Beside the record in Firestore, not in Cloud Storage.
Cloud Storage on a newly created Firebase project generally wants a billing
account attached, which this app is built to avoid — worth checking in your own
console if you'd rather have full-resolution originals. Keeping them in
Firestore means no bucket, no CORS setup, and no second set of rules.

The trade is a size ceiling: a Firestore document tops out at 1 MiB, so each
photo is resized and re-compressed in your browser until it's comfortably under
that. A 7 MB, 2400×3200 phone photo comes out around 200 KB at 1050×1400 —
plenty to read a receipt, and no loss that matters for black text on white
paper. Photos are rotated the right way up on the way in, since phones record
orientation separately from the pixels.

At roughly 200 KB each, Firestore's free 1 GiB holds a few thousand receipts.
The photos are only fetched when you open a record, so a long service history
stays quick to scroll.

## Security note

This app has no server of its own — it's static files talking directly to
Firestore, which keeps it free and simple. That means anyone with the link can
read your logs and add to them. There's no password.

Treat the link like an unlisted shared document: fine for your own family's
vehicles, not for anything you'd mind a stranger reading. Don't post it
publicly. (The repo being public is fine — your data lives in Firebase, not in
the repo. The Firebase config in `firebase-config.js` is meant to be public;
Firestore rules, not that config, are what control access.)

## Local development

No build step is required. Any static file server works, e.g.:

```bash
npx serve .
```

Then open the printed URL. Firestore reads/writes will work as soon as
`firebase-config.js` and the Firestore rules are set up (steps above).

### What's in here

| File | What it does |
| --- | --- |
| `index.html` | The page shell — loads the stylesheet and `app.js`. |
| `app.js` | Screens, forms, and everything that talks to Firestore. |
| `stats.js` | The MPG and service-due math, kept free of Firestore and the DOM. |
| `import.js` | Reading fill-ups or service records out of a spreadsheet: matching columns, checking rows, and the preview before anything is saved. One flow, with a profile per record type. |
| `photos.js` | Shrinking a photographed receipt down to something that fits beside its record. |
| `xlsx.js` | A small .xlsx reader — unzips the file and pulls values out of the sheet XML, with no library. |
| `csv.js` | A CSV reader, for the "just export it as CSV" path. |
| `format.js` | Formatting money, miles, gallons, and dates. |
| `ui.js` | Modals, toasts, the QR code, and the MPG chart. |
| `firebase-config.js` | Your Firebase project's config (you fill this in). |
| `firestore.rules` | The database rules to paste into the Firebase console. |
