# Family Garage

A vehicle log for a family's cars: fill up the tank, type in the pump reading,
and the site works out your MPG. It also keeps track of service — what's due
when, what's overdue, and what you've already had done and paid for.

No build step, no framework — plain HTML/CSS/JS, hosted for free on GitHub
Pages, data stored for free in Firebase Firestore. It updates live on every
device, so a fill-up logged at the pump is on the kitchen iPad before you're
home.

Built phone-first, and past **768px wide it opens up for a tablet**: the
reading column widens, and the three screens that are really a flat set of
interchangeable cards — the garage's own vehicles, its look-ahead grouped by
vehicle, and the parts shelf — grid two across instead of stretching one card
to fill the space. Everything else (a vehicle's own page, forms, the schedule,
the gas log) stays the single column it always was, just with more room around
it — those already read top to bottom rather than as a set of peers, and
forcing them into a grid would fight that. A form still opens as the same
centered dialog it always has; it was never meant to fill the width.

## How it works

- **Garage** (the site's root URL): every vehicle with its average MPG and its
  odometer. Its service status isn't repeated on the card — **Coming up** just
  below already covers what's overdue and due soon across the whole garage,
  counted by vehicle. See [What's coming up](#whats-coming-up).
- Every action sits at the top of what it acts on rather than under it: a
  page's own action beside its heading (**More** on the garage, **+ Add a
  service** on the schedule, **+ Add a part** on the shelf), and a section's on
  its section heading (**Log as one visit** on Service, **Show all** on the gas
  log). A list growing longer never pushes its own control further down the
  page.
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

**Rows from the same trip become one visit.** A spreadsheet has to list three
jobs as three rows, but three jobs done on the same day at the same odometer
reading and the same shop were one trip — so they come in as one visit with a
line each, and the total added up, exactly as if you'd entered them by hand:

> rows 2–4 → **Oil change + 2 more** · Feb 4, 2026 · 50,120 mi · Dave's Auto ·
> **$412.35**

Same day but a different shop stays a separate visit, and a "next due" row is
its own reminder however many share its date. Untick **Combine rows from the
same visit** in the import sheet to keep every row separate instead; the preview
updates as you do, and shows which rows each visit came from.

Re-importing stays safe: every job inside a saved visit is matched
individually, so a sheet whose rows were merged is recognised row by row the
second time rather than coming back in as duplicates.

A service sheet is usually history — what was done, when, and what it cost — but
plenty of them carry a "next due" column as well, so both come across in one go:

- A row with a **date done or an odometer reading** becomes **history**, with
  its cost, shop, and notes.
- A row with **only a next-due date or mileage** becomes a **scheduled job**,
  and turns up in the Service list like one you'd entered by hand.
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

Tap **🔧 Add service** at the top of the page for either:

- **Schedule something coming up** — puts one or more jobs on the list at
  once. **+ Add another job** for a second, third, and so on — each just a
  name ("Oil change", "Replace serpentine belt"). They share a due date, a
  due mileage, both, or neither (whichever's set is what the reminder goes
  by — leave both blank for a job you just want on the list, with nothing
  to remind you of yet), and optionally a shop and a note. Several jobs due at the same visit save
  as separate records, one per name, so each shows and gets marked done on
  its own. Parts entered here land on the first job listed — add parts to
  any of the others afterward by editing it on its own. Nothing about it has
  to come from the [service schedule](#the-service-schedule) — the schedule
  is for jobs that come round on an interval; this is for the one-off — the
  belt that started squealing, the recall letter, the thing you noticed on
  the drive home. Either way it lands on the same list and appears in
  [What's coming up](#whats-coming-up) as **booked**.
- **Log service already done** — one trip to the shop, however many jobs it
  covered.

### The description dropdown

The description box on a service record — and the "what was done" box on each
line of a multi-job visit — offers names from [Service
names](#service-names), narrowing as you type. Tap the box with it empty and
you get the list: favorites first, then everything else alphabetically, then
a handful of common ones (oil change, tire rotation, inspection…) if nothing
you've saved covers them yet.

A name scoped to particular vehicles only offers itself on those — see
[Which vehicles a part fits](#which-vehicles-a-part-fits) for the same idea
applied to parts. Everything else offers itself everywhere.

**The shop box is separate** — it isn't a saved list like service names, just
whatever you've typed into a shop field before, most recent first, drawn from
everywhere you've had work done across all your vehicles, not just this one,
since a family tends to use the same garage for both cars.

Arrow keys move through the list, Enter takes the highlighted one, Escape puts
it away — and Enter on a highlighted suggestion picks it rather than saving the
record. The list never covers the sheet's own Save and Cancel buttons.

### One visit, several jobs

A trip to the shop usually isn't one thing. The date, odometer, shop, labor
cost, and receipt are shared, so you enter those once and add a line for each
job: what was done, what it cost, and any note about that particular job.
**+ Add item**
adds another line, and the **total is added up for you** as you type — no adding
up the receipt by hand, and no invented number to reconcile against it later.

In the history a single-job visit reads exactly as it always has: the job's
name, then when and where. A visit covering several is headed by when and where
instead — with the jobs listed underneath, repeating the first one as a heading
adds nothing — and shows the total on the right:

> **Aug 27, 2026 · 50,120 mi · Dave's Auto** — **$412.35**
> · Oil change $79.95 · Air filter $42.40 · Brake pads $290.00

A visit is named after its first job. That name is what a follow-up scheduled by
a repeat interval carries, what shows in **Coming up**, and what the description
dropdown offers, so it stays a real service name rather than a summary.

Records entered before this, and ones brought in by the spreadsheet importer
(one row is one job), are read as a visit with a single line, so nothing needed
converting.

#### Turning the list into a visit

With more than one job waiting, **Log as one visit** appears on the Service
heading and opens that same sheet with the work already typed in: a line
per job in the order the list shows them, each job's note beside it, the parts
those jobs said they'd need added up across all of them, and the shop if every
one of them names the same shop. Fill in what each cost and save, and you get
**one** record covering the lot.

The jobs that were still on the sheet when you saved come off the service list —
the visit is now what says they were done. **Take a line off** and its job stays
where it was: that's how you say you didn't get to that one after all. The
schedule picks all of this up on its own, since a job done inside a multi-item
visit counts as done, so their next-due dates move forward without you touching
the schedule page.

Renaming a line rather than removing it leaves its job on the list too — matching
is by name, and the app would rather leave something behind than delete the wrong
thing.

#### Combining past visits

Sometimes two records really were one trip — an oil change and a tire rotation
logged as separate visits when they happened at the same shop on the same day.
**Combine**, on the Service history heading, turns any picked pair (or more)
into a single record. It only appears once you've tapped **Show** — nothing to
pick from with the list still collapsed.

Tap **Combine**, check the ones that belong together, and tap the button that
appears once you've picked at least two. The sheet opens with everything already
in it — a line per job, their costs, their parts, their receipt photos — as if
you'd logged them together in the first place. The date and odometer default to
the **earliest** of the visits you picked, on the theory that's the one the
others actually happened alongside; change either if that's not right.

Save, and the records you picked collapse into the one you're looking at — the
others are deleted, their parts and photos already moved across, nothing taken
off the shelf a second time for parts that were already booked out when each
visit was first logged. Unlike folding open jobs into a visit, there's no
partial-match safety valve here: picking the records is already the deliberate
step, so editing a line before you save changes what it says, not whether its
source record gets combined in.

#### Labor cost

**Labor cost (optional)** sits next to Shop whenever you're logging or marking
a service done — a plain log, **Mark done**, **Log as one visit**, **Combine**,
or editing an already-done record. It's a whole-visit figure, not one more line
item — set once for the trip, the way Shop is, rather than split across jobs
that don't actually bill separately for the work. It's added on top of
whatever the items list comes to, folded straight into the same running
**Total** shown as you fill the sheet in — so what you see there while
entering it already matches what's about to be saved, not just the items
above it. Once saved it shows on its own line ("Labor $60.00") alongside the
items wherever a visit's breakdown is shown, so the total on the right always
matches what's itemized underneath it. **Service total**, **Total w/
service**, and **Cost per mile w/ service** on the vehicle page all count it —
labor is part of what a visit actually cost, same as any job on it.

Folding several open jobs into one visit, or combining several past ones, adds
their labor costs together rather than picking one and dropping the rest —
nothing about the trip gets left behind, same as items and parts. It never
appears on the not-yet-done scheduling sheet (**Schedule something coming
up**) — there's no labor to speak of until the work's actually done.

Open services are sorted with the most pressing first and color-coded: red for
**overdue** (the date has passed, or you've driven past the mileage), amber for
**due soon** (within 30 days or 500 miles), plain for everything further out.
The garage card doesn't repeat any of that — **Coming up** already covers
overdue and due-soon work, so you're not told about the same job twice.

When you log a completed service you can also set **do it again in ___ miles**
or **___ months**. That schedules the next one right then — log an oil change at
49,240 miles with "again in 5,000 miles", and "Oil change, due at 54,240 mi"
appears on the list. **Mark done** on a scheduled service does the same thing:
it fills in today's date and your current odometer, and rolls the next one
forward if the service repeats.

Nothing here sends notifications — there's no server to send them. The app knows
what's due whenever you open it, which is what **Coming up** and the badges on
each vehicle's own service list are for.

### The service schedule

**🗓️ Service schedule**, above the Service section on a vehicle's page, is
where you say how often each job comes round on
*this* vehicle — every 5,000 miles, every 6 months, or both, whichever falls
first. Intervals belong to the vehicle because they differ: a van that tows
wants its oil changed sooner than a car doing the school run, and two vehicles
in the same driveway rarely share a service book.

Each row then answers the question the page exists for — when is this next
needed:

> **Oil change** — every 5,000 mi or every 6 months
> last done Aug 27, 2026 at 52,400 mi
> next: due Feb 27, 2027 (in 184 days) · due at 57,400 mi (5,000 mi away)

Overdue first, then due soon, then the rest. Nothing here is stored as a
reminder: the next-due figures are worked out from your history every time the
page opens, so **logging a service moves them on its own**. Shorten an interval
and every date recalculates on the spot.

**+ Add a service**'s own Service box offers **favorites only** — see
[Service names](#service-names). The schedule is meant to hold the handful of
jobs you actually keep on a recurring interval, not every name you've ever
typed, so nothing suggests itself here until you've starred it.

An entry can also say **what it needs off the shelf** — the same "Parts
needed" picker as everywhere else, set on the entry itself rather than typed in
fresh each time it comes round. This is only ever a default: set it once on
"Oil change" and every future **Add to list** for that job carries it straight
onto the booked record — no prompt, no extra tap, nothing to remember when
you're standing at the shelf doing the work. The entry itself never touches
the shelf; it's the booked job's own copy, made the moment it's added to the
list, that actually reserves the parts. See [Parts and
supplies](#parts-and-supplies) for what that means and when it happens.

### A job you've never logged

There's no last-done to count from, so the vehicle's own beginning stands in:
**zero miles, on January 1st of its model year**. A cabin filter due every 12
months, never logged, on a 2016 car was due in January 2017 — so that's what the
row says, and it reads as overdue, which it is.

> **Cabin air filter** — every 12 months
> never logged — counting from new, Jan 1, 2016 at 0 mi
> next: due Jan 1, 2017 (3,526 days ago)

The row says what it counted from, because a figure worked out from the
vehicle's age is an assumption and one measured from a service you logged isn't.
Log the job once and the assumption is gone — the real date takes over.

A vehicle with **no model year** has no such date to fall back on. Those entries
stay as they were: "not logged yet", with no next-due, until you log one.

These jobs are counted in [What's coming up](#whats-coming-up) too, where one
counted from the vehicle's age reads as **overdue** like any other — which, on a
2016 car, it is.

A job done as part of a multi-item visit counts — if your February trip covered
an oil change, an air filter and brake pads, all three have their own last-done
date and their own next-due.

**Add to list** on any row — overdue, months off, or never logged — puts it on
the vehicle's service list as a booked job, so it turns up in the Service
section, and in **Coming up** once it's overdue or due soon, alongside
anything you scheduled by hand. That step is deliberate: the schedule is a rule about how often something comes
round, and the service list is what you've actually committed to. You decide
what you're doing on Saturday, not the interval, so every job can be added; only
the pressing ones get the green button. A row already on the list says so
instead of offering to add a second copy. It's one tap, no questions asked —
whatever the row already needs off the shelf comes with it, reserved from the
shelf the moment you tap; see [the service schedule](#the-service-schedule)
for where that's set.

Once there's more than one job waiting, the Service section on the vehicle page
offers **Log as one visit** on its Service heading — see [One visit, several
jobs](#one-visit-several-jobs).

### Receipt photos

A completed service record can carry photos of the receipt. They're added in the
same sheet you log the work in — **+ Photo** under *Receipt photos* — so a
receipt can go on as the service is logged rather than after saving and
reopening it. The same sheet is where you'd add one later: tap the record, add
the photo, save.

Tap a thumbnail to see it full size, which is also where **Remove** is. A record
with receipts shows a 📎 and a count in the service list, and deleting the record
takes its photos with it.

**Pinch to zoom in on it, drag to pan around once you have, double-tap to jump
back out** — the usual gestures, scoped to just the photo itself; the page
elsewhere keeps the browser's own pinch-zoom turned off so a stray gesture
doesn't get away from the layout. On a mouse: scroll to zoom, drag to pan,
double-click to toggle.

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

## If something won't save

Almost every "nothing happens when I tap it" in an app like this is the database
refusing a read or a write, and the usual cause is `firestore.rules` in this repo
being newer than the rules published in your Firebase console. Firestore denies
anything a published rule doesn't explicitly allow, including whole
subcollections it has never heard of.

So: **when you pull changes that touch `firestore.rules`, paste the new file
into Firebase console > Firestore Database > Rules and Publish.** The app says
as much when it hits a refusal — the record still opens and still saves what it
can, and it names the fix rather than failing quietly.

## Parts and supplies

**🔩 Parts & supplies**, under the vehicles on the garage screen, is one shelf for the whole
household — a case of oil gets used on whichever car needs it, so parts aren't
owned by a vehicle. Each item has a name, and optionally a **brand**, a
**category**, a **part number**, a **model**, a **size**, who you **bought it
from**, what it costs each, and the level to keep it above.
Anything at or below that level is flagged as running low, and the row has **+**
and **−** for a quick recount. Brands, categories and vendors you've already
typed are offered back as you type, so "Fram" doesn't become "fram" on the next
row.

It works like an actual cabinet, not a running tally kept off to the side:
pick a part for a job anywhere — one you're scheduling, one already booked, or
one you're marking done — and it comes off the shelf right then, the same as
if you'd walked over and set it aside for that job. What the shelf says is
always what's actually still there, spoken for or not, and [the buy
list](#whats-coming-up) is read straight off that number rather than worked
out from what any job says it'll need someday.

Give things categories and the shelf sorts itself into them, named categories
first and anything without one at the end. Categorise nothing and it stays the
one flat list it always was.

### Which vehicles a part fits

**Fits** is a row of chips, one per vehicle. Pick none — the default — and the
part counts as fitting anything, which is what a case of oil or a box of rags
is. Pick some and the shelf row says so.

The parts picker on a service sheet then offers only what fits the vehicle
you're logging against — the ones marked for it, plus everything marked for no
vehicle in particular. Mark nothing on the shelf as fitting that vehicle and the
picker says so rather than sitting there empty.

One exception, and it matters: a part **already on the record** stays offered
however it's marked. You can book a filter against the truck and mark it
van-only afterwards; dropping it from the list would empty the select and
quietly change what the record says was used.

### Using parts on a service

Every parts picker in the app — scheduling a job, editing one already booked,
or the completed-service sheet's **Parts used** — works the same way: pick an
item and how many, and it comes off the shelf the moment you save, not later.
The option text shows what's there, with a warning under any row asking for
more than there is.

Edits move the shelf by the *difference*, not by the whole amount again — change
5 quarts to 6 and one more quart comes off; change it back down and that quart
returns. Deleting a job, booked or already done, puts back whatever it had
reserved. Quantities change by an atomic increment rather than by writing a
number worked out a moment earlier, so two phones logging service at once can't
undo each other's arithmetic.

Booking out more than you had leaves a negative count. That's kept rather than
quietly clamped — it means the count was wrong, and the row says so — and a
recount puts it right.

### What the parts cost, on the record

A service sheet works out what the parts you've booked cost, from each one's
**cost each** on the shelf, and puts each part's cost on **the job it went on**:

> **Parts used**
> 0W-20 oil (8 qt) × 5 — for ⌄ **Oil change** — *$8.99 each = $44.95*
> Oil filter (4 each) × 1 — for ⌄ **Oil change** — *$12.50 each = $12.50*
> Wiper blades (2 pair) × 1 — for ⌄ **Wiper blades** — *$18.00 each = $18.00*
> **Parts $75.45**

A trip to the shop is several jobs and the parts belong to particular ones — the
oil and the filter to the oil change, the blades to the wiper job — so each part
names its own. **One job on the sheet and there's nothing to ask**: everything
goes to it, and the picker doesn't appear. Move a part to a different job and
the money moves with it, off one line and onto the other.

A part with no cost recorded adds nothing, and with no priced parts at all the
cost is simply left blank — nothing is invented. Change the parts afterwards and
the lines follow, unless you've typed a figure over one yourself, in which case
that one stands: the receipt beats the shelf.

Which job each part went on is saved with the record, so reopening a visit puts
every part back against its own job.

### What the record keeps

A saved record says which part it was, not just how many:

> Used 5 × 0W-20 oil (M1-0W20, from NAPA), 1 × Oil filter

The name, unit, model, size and vendor are copied onto the record rather than
looked up from the shelf each time it's read. Edit a shelf entry, rename it, or
take it off the list entirely, and the record still says what was actually used
and where it came from. Parts with no model or vendor recorded read exactly as
they always did, and so do records written before any of this existed.

### Booking a job's parts ahead of time

The scheduled-service sheet has **Parts needed** too — the same picker, the
same behavior: pick what the job will take, and it's reserved off the shelf
the moment you save, same as marking something done. The job then shows what
it's reserved in the service list, in amber if the shelf is now running low
on any of it, and **Mark done** starts from that same list, since it's
already been taken off the shelf — change what's actually used there and only
the difference moves either way.

A [schedule entry](#the-service-schedule) — the recurring rule itself, not a
booked job — can carry its own **Parts needed** too, but that one's only ever
a default. It never touches the shelf on its own; it copies onto a job's own
list the moment **Add to list** books it. Change the parts on the entry
afterwards and it's the default for the *next* time that job comes round — a
job already booked keeps whatever it already reserved, unless you open that
job itself and change its own list.

## What's coming up

Under the vehicle list on the garage screen, **Coming up** is the whole garage's
attention list: everything **overdue** and everything **due soon**, and nothing
else. Work comfortably ahead is real, but it belongs on the vehicle's own page —
a garage screen that lists all of it buries the two jobs you actually have to
deal with.

It opens as a set of counts, by vehicle and by status:

> **BLUE ODYSSEY**
> ▸ Overdue **3**  ▸ Due soon **2**
>
> **RED TACOMA**
> ▸ Overdue **1**

**Tap a count** and it expands to the jobs behind it — a name and an **Open**
button each. Tap again to close it. Counts open independently, so you can have
one car's overdue list open beside another's, and the whole thing collapses back
to four lines.

Vehicles come in the same order as the cards above — by name, so the two lists
on this screen read down together and neither shuffles as the numbers change.

Everything else a job knows — its date, its mileage, what it needs off the
shelf, whether that date was measured or assumed — is one tap away behind
**Open**, on the page that owns it.

"Due soon" is the same 30 days or 500 miles the badges use everywhere else,
whichever falls first. To decide it, a job due on mileage is still turned into a
date using how fast that vehicle has actually been driven; only miles still to
drive can be dated that way, so a job you're already past is simply overdue.

Below the vehicle-by-vehicle list is **🛒 To buy** — a straight read of the shelf:
everything at or below the level you said to keep, whatever it took to get
there, with the count in the header. Each line says which one to buy and where:

> **0W-20 oil** — **2 qt short** · have 3, keep 5+
> *model M1-0W20 · 0W-20 · from NAPA*

With no level set for a part, only actually running out counts, and the line
says so rather than suggesting a figure nobody gave. A count gone negative —
more booked out than the shelf held — is a different kind of problem than
merely running low: the count itself is wrong, not just thin. That line reads
as short of zero rather than short of a level, turns red the same way [the
shelf page](#parts-and-supplies) already flags it for a recount, and sorts
to the top of the list ahead of everything else, however short that is.

**One chip per vendor** appears above the list once there's more than one on
it — tap one to narrow the list to just what that store carries, tap it again
(or tap **All**) to bring the rest back. The count in the header follows
whatever's actually showing, so it still reads as "how many, right now" once
you've narrowed it down rather than always quoting the grand total. A part with
no vendor set only shows under **All** — there's no store to file it under.
With everything from a single vendor, or nothing that names one at all, there's
nothing to filter and no chips appear.

**To buy** doesn't care what any job is due for, or when — a part reserved
for something eight months out counts exactly the same as one for tomorrow,
because [reserving it already took it off the
shelf](#parts-and-supplies). It shows whenever there's a shelf to speak of,
in one of two states: what's short, or "everything on the shelf is at or
above what you keep on hand" once nothing is. With no parts tracked on the
shelf at all, it doesn't appear — there's nothing yet to check.

Working out **Coming up**'s own job list needs every vehicle's schedule,
services and fill-ups, which the vehicle list itself doesn't — so both it and
**To buy** are read together, after the vehicle list has already been asked
for, and the list appears without waiting on either. Read once when the page
opens rather than watched live; coming back to the garage reads it again.

## Service names

The same job ends up typed a few different ways over the years — "Oil chg",
"oil change", "Oil Change" — and everything that matches on a job's name (the
schedule deciding what's already booked, the suggestion dropdowns, what shows
in **Coming up**) treats each spelling as a different job.

**More > 🏷️ Service names** is a register of every name in use across the whole
garage, with how many vehicles and how many records carry each — grouped the
same case-and-spacing-insensitive way scheduling already decides two jobs are
the same one, so "Oil chg" and "oil CHANGE" show up as one row, not two.

**+ Add name**, next to Merge, adds a name to the register directly — before
it's ever been typed into a record anywhere. It's there right away in the
suggestion dropdowns, ready to pick the first time it's actually needed.

Tap a name (not the Edit button) and it expands into which vehicles carry it
and when it was last actually done on each, with an **Open** link straight to
that vehicle. A vehicle that only has a schedule entry or a booked job for it
— nothing done yet — shows "not logged yet" instead of a date.

**Edit** covers three things at once, all in the same sheet:

- **Renaming** changes the name **everywhere**: every schedule entry, every
  booked job, every item on a past visit, and which job a booked part was for
  — on every vehicle, not just one. Typing back the name already showing still
  does something useful: it normalizes any stray-cased variant to that exact
  spelling. Renaming to a name that's already in use merges the two — if "Oil
  Chg" and "Oil change" were really the same job typed two ways, renaming one
  to the other folds them into a single row here.
- **Favorite** stars the name (★, shown right on its row) and puts it in the
  [service schedule's](#the-service-schedule) own dropdown, which offers
  favorites only. Nothing is favorited by default, including the common
  built-in suggestions — star the handful you actually keep on a schedule.
- **Applies to** scopes the name to particular vehicles, the same "pick none
  and it fits anything" idea [a part's fit list](#which-vehicles-a-part-fits)
  uses. A scoped name only offers itself in dropdowns on those vehicles; an
  unscoped one offers itself everywhere. It doesn't hide the name from the
  register itself, or from a vehicle it's already used on — only from where it
  gets *offered* next.

Editing a name that's only ever been derived from usage — never favorited,
scoped, or added by hand — creates its own saved entry the first time you
change any of this, same as any other edit.

**Merge** folds more than two names into one at once: tick the names that are
really the same job, tap **Merge**, and pick which spelling wins — everything
else picked rewrites to that one, everywhere, in a single pass. The winner
keeps its own name but picks up **favorite** from either side (favorited beats
not) and stays **unscoped** if either side was — merging is never how a name
quietly loses its reach. Either way, it doesn't merge *records* on any one
vehicle — two records with the same name on the same vehicle after a rename or
a merge are exactly what they were before, just agreeing on what to call it.

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

`package.json` exists only to say which Node version local tooling (`npx
serve`, an editor's Node integration, whatever you reach for) is expected to
run on — Node 24+. It has no dependencies and nothing to install; the app
itself is still plain HTML/CSS/JS, served as-is.

### What's in here

| File | What it does |
| --- | --- |
| `index.html` | The page shell — loads the stylesheet and `app.js`. |
| `app.js` | Screens, forms, and everything that talks to Firestore. |
| `stats.js` | The MPG, service-due and schedule math, kept free of Firestore and the DOM. |
| `import.js` | Reading fill-ups or service records out of a spreadsheet: matching columns, checking rows, and the preview before anything is saved. One flow, with a profile per record type. |
| `photos.js` | Shrinking a photographed receipt down to something that fits beside its record. |
| — | The parts shelf, what a job uses, and the look-ahead all live in `app.js` and `stats.js` alongside the rest. |
| `xlsx.js` | A small .xlsx reader — unzips the file and pulls values out of the sheet XML, with no library. |
| `csv.js` | A CSV reader, for the "just export it as CSV" path. |
| `format.js` | Formatting money, miles, gallons, and dates. |
| `ui.js` | Modals, toasts, the QR code, and the MPG chart. |
| `firebase-config.js` | Your Firebase project's config (you fill this in). |
| `firestore.rules` | The database rules to paste into the Firebase console. |
| `package.json` | Just pins the Node version for local tooling — no dependencies, nothing to install. |
| `.nvmrc` | The same Node version, for `nvm use`. |
