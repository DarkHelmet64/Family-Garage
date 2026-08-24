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
| `format.js` | Formatting money, miles, gallons, and dates. |
| `ui.js` | Modals, toasts, the QR code, and the MPG chart. |
| `firebase-config.js` | Your Firebase project's config (you fill this in). |
| `firestore.rules` | The database rules to paste into the Firebase console. |
