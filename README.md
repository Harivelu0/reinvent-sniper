# Reinvent Sniper

**Find the right re:Invent 2026 sessions, plan your week, and have your seats reserved for you the moment booking opens.**

re:Invent has over two thousand sessions, many of them repeated, and the popular ones fill within minutes of booking opening. Reinvent Sniper is a small app that runs on your own computer and uses the official [AWS Events API](https://docs.aws.amazon.com/events/latest/devguide/) to help with both problems. I built it to solve my own planning problem, and anyone attending can use it.

## What it does

| | |
|---|---|
| **Find** | Every filter the catalog has (level 100 to 500, day, venue, topic, service, role and more), plus a plain-word search. Repeated talks are grouped so you read each one once. |
| **Plan** | Sort sessions into **Must-have**, **Nice-to-have** and **Backup**. It warns you about time clashes and can save your plan to your AWS event favorites. |
| **See your week** | A calendar of your sessions, the parties you are going to, and your own entries (dinners, meetings), with overlaps highlighted. |
| **Book seats** | **Yes, it reserves seats for you.** It uses the API's reserve function to book your plan as soon as booking opens, uses a backup if a session is full, and emails you what it booked. You can also practise first, with nothing booked. |

### Does it really book seats?

Yes. When you press **Start live booking**, the app keeps checking until AWS opens reservations, then reserves your Must-haves (then Nice-to-haves) through the API, and checks your real schedule afterwards to confirm. Four things have to be true:

1. You are signed in with your AWS Builder ID and **registered for re:Invent 2026**.
2. Your plan has at least one Must-have.
3. **You press Start live booking.** It never starts by itself.
4. Your computer is on, awake and online, with the app running.

> **Important date.** AWS opens reserved seating on **Oct 6** on its own website and app. Through the API, which this app uses, AWS says it "does not open through this API until **October 8, 2026**." So seats released on Oct 6 have to be booked on the AWS website yourself. From Oct 8 this app books whatever is still open. Everything else here (finding, planning, the calendar, favorites) works right now.

## What you need

| Requirement | Details |
|---|---|
| **Computer** | Windows 10 or 11, macOS, or Linux. Any recent laptop or desktop. The app is light: under 100 MB of memory and about 10 MB of disk. |
| **Node.js** | Version **20 or newer** (the LTS version). This is the only thing to install. See below. |
| **Browser** | A recent Chrome, Edge, Firefox or Safari (from 2023 or later). |
| **AWS Builder ID** | Free. Sign up at [builder.aws.com](https://builder.aws.com) if you do not have one. |
| **re:Invent 2026 registration** | You must be registered to attend. Without it the API refuses with a "403". |
| **Internet** | Needed while you use the app and for the whole time it is booking. |
| **Free ports** | One of `8484` to `8489`. AWS only allows sign-in from these. |
| **Email (optional)** | A Gmail account, to receive the booking report. Any other email provider also works under "Advanced". |

It does not need an AWS account, a credit card, or any paid AWS service. It runs **only on your own computer**. That is how AWS designed the API: *"You sign in on your own machine. There is no hosted option."*

## Install and start

### 1. Install Node.js (once)

- **Windows:** download the **LTS** installer from [nodejs.org](https://nodejs.org) and run it, keeping the default options. Or, in PowerShell: `winget install OpenJS.NodeJS.LTS`
- **macOS:** download the **LTS** installer from [nodejs.org](https://nodejs.org), or run `brew install node` if you use Homebrew.
- **Linux:** follow the [official instructions](https://nodejs.org/en/download) (your package manager, or `nvm`).

Then **close and reopen** your terminal, and check it worked:

```
node --version
```

It should print `v20` or higher (for example `v22.15.0`). If it says "not recognized" or "command not found", close every terminal window and try again, or restart the computer.

### 2. Get the app

On this repository's page, click the green **Code** button, then **Download ZIP**, and unzip it somewhere you will find it (for example your Documents folder). If you use Git, you can clone the repository instead.

### 3. Start it

- **Windows:** double-click **`Start Reinvent Sniper.bat`**. The first time it installs its one small dependency, which takes a few seconds.
- **Mac or Linux:** open a terminal in the app's folder and run:
  ```
  npm install
  node server.js
  ```
  (Run `npm install` only the first time.)

A black window or terminal opens and says **"Reinvent Sniper is running at http://localhost:8484"**. **Keep that window open** while you use the app. Your browser should open by itself. If it does not, open `http://localhost:8484` yourself.

To stop the app, press **Ctrl+C** in that window, or close it.

> If `npm start` exits straight away with no message on some Windows PowerShell setups, use `node server.js` instead. It always works.

## First-time setup (about 10 minutes)

1. **Sign in.** Click **Sign in with Builder ID**, sign in on the AWS page, and you return to the app. The session list (about 2,100 sessions) then downloads by itself.
2. **Set up email** (optional, but recommended so you get the booking report). Open the **Profile** tab and fill in the two fields marked with a red **\***:
   - **Your email address**, for example your Gmail address.
   - **App password.** This is **not** your Gmail password. It is a one-time 16-letter password that Google creates just for this app. Open "How do I get the app password?" on the page for the steps: turn on 2-Step Verification, open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create one, and paste it in (spaces do not matter).

   Press **Save and send a test email** and check your inbox (and spam folder).
3. **Build your plan.** On the **Sessions** tab, filter and search, then choose **Must-have**, **Nice-to-have** or **Backup** on each session you want.
4. **Check your week** on the **Calendar** tab.
5. **Try a practice run** on the **Booking** tab. It shows what would be booked and books nothing.

## Using the app

### Sessions

- **Filters** are on the left. Choices in different groups must all match; choices inside one group are alternatives. Counts update as you filter. Levels 100 to 500 and every day of the event are always listed, and each group has a "not listed" choice so no session is unreachable.
- **Search** shows sessions that contain **every word you typed**, best match first. `agent` finds "agentic". Short words like `AI`, `ML` and `S3` work. Filler words ("best", "how", "the") are ignored. Tick **Also show partial matches** to include sessions that match only some of your words.
- **Repeated talks** (codes like `SVS403-R` and `SVS403-R1`) appear as one card with their other times listed underneath. You can pick the time you want.
- **Not interested** removes a session from your list and from the filter counts (with an **Undo**). Sessions you add to your plan stay visible, marked **Selected**.
- **Save as Favorites** sends your plan to your AWS event favorites.
- Everything you set (filters, search, plan, hidden sessions) is saved and comes back when you reopen the app.

### Calendar

Your week as a grid, in Las Vegas time. Your sessions are coloured by tier (Backups are dashed), and anything overlapping a session you plan to attend is outlined in red. Click a block to read it or change it.

- **Parties:** press **Load parties from conferenceparties.com** to read that site's unofficial party list. Nothing appears on your calendar until you tick it. Each party links to its RSVP page.
- **Your own entries:** add dinners and meetings at the bottom.

### Booking

Three steps on one page: **1 Get ready** (a checklist), **2 Practice run**, **3 Start live booking**. A single line at the top says where things stand, with a countdown.

When you press **Start live booking**, the app:

- tries to reserve straight away and keeps trying (every 20 seconds, faster around the expected opening) until AWS opens reservations. The exact opening time does not matter;
- reserves your **Must-haves first**, then your Nice-to-haves, up to 10 sessions in one request;
- uses the **Backup** in the same time slot if a Must-have is full, and shows a **Swap** button you can press later if the original frees up;
- checks your real AWS schedule afterwards and **emails you what was booked**;
- picks up where it left off if the app crashes (but not if you stop it on purpose).

## Booking-day checklist

- [ ] Registered for re:Invent 2026, and signed in to the app.
- [ ] Your plan has your Must-haves, with no overlaps.
- [ ] Email works (the test email arrived).
- [ ] **Do not let the computer sleep, and keep it plugged in** (see below).
- [ ] Pause automatic restarts for updates until booking is done.
- [ ] Start the app, press **Start live booking** well before the opening, and check the top of the Booking page says **"Watching: waiting for booking to open"**.
- [ ] Leave the window open. Do not shut the computer down: a shut-down computer cannot book.

**Stopping your computer from sleeping**

- **Windows:** Settings, System, **Power & battery**, then "Screen, sleep & hibernate timeouts", and set "When plugged in, make my device sleep after" to **Never**. On a laptop, also open "Lid & power button controls" and set "Closing the lid will make my PC" to **Do nothing**.
- **macOS:** in a second Terminal window run `caffeinate -dims` while the app is running, and keep the Mac plugged in.
- **Linux:** turn off automatic suspend in your power settings, or start the app with `systemd-inhibit --what=sleep node server.js`.

## Questions and problems

**Sign-in page says "redirect mismatch".** Open the app at exactly `http://localhost:8484` (or `8485` to `8489` if it told you a different number), not any other address.

**I get a "403" or "not registered" message.** This Builder ID is not registered for re:Invent 2026. Register on the event's site, then try again.

**"Ports 8484-8489 are all in use".** Another copy of the app is already open. Close it.

**"Sign-in expired".** Your sign-in lasts about 30 days, and the Builder ID session behind it has its own limit. Sign in again, ideally the day before you book. If it happens while booking, the app stops and emails you.

**The test email fails.** The most common cause is using your normal Gmail password. It must be the 16-letter **app password** from Google.

**"node is not recognized".** Node.js is not installed yet, or the terminal was open before you installed it. Install it, close all terminals, and open a new one.

**Booking says "not open yet" for days.** That is normal until AWS opens reservations through the API (Oct 8). The app keeps checking.

**Does it work for other re:Invent days or events?** It is built for re:Invent 2026. Other events can be selected by changing the `EVENT_ID` setting, but they have not been tried.

## Privacy and safety

- Everything is stored on your computer in a folder named `.reinvent-sniper` inside your user folder (on Windows, `C:\Users\<your name>\.reinvent-sniper`). It holds your sign-in tokens, the session list, your plan, your settings and your email app password.
- The email app password is saved in plain text in that folder, protected only by your computer's file permissions. Use a computer you trust.
- Your Builder ID sign-in and session data go only to AWS (`oauth.awsevents.com` and `api.awsevents.com`). There is no server run by this project, so nothing is sent to its author.
- The app contacts only two other places, and only when you ask: your own **email provider** (for Gmail, `smtp.gmail.com`) to send the booking report, and **conferenceparties.com** when you press the party button.
- The app's local web page only accepts requests that come from your own computer's browser.
- To remove everything, use **Sign out** in Profile, and delete the `.reinvent-sniper` folder.
- It respects AWS's published request limits and reserves only for the person signed in. It never reads or shows other attendees' data.

## What it cannot do

- It cannot book through the AWS website or app. It only uses the API, which opens on **Oct 8**.
- It cannot register you for re:Invent.
- Seat availability is only a rough band (available, limited, very few), as the API provides. There are no seat counts.
- It cannot book if your computer is off, asleep or offline.

## Credits and disclaimer

- Built for the **re:Invent Catalog API Builder Challenge**, using the official AWS Events API. This is an independent project. It is **not affiliated with or endorsed by Amazon or AWS**.
- The party list comes from the unofficial community site [conferenceparties.com](https://conferenceparties.com/reinvent2026/). That list belongs to its owner and is **not included in this repository**. Your copy is fetched by you, on your own computer, when you press the button.
- Built by the author with the help of an AI coding assistant, working from the author's requirements and under their direction.

---

<details>
<summary><strong>For developers</strong> (how it works, tests, and the mock API)</summary>

### How the booker treats the API

| Behaviour | Why |
| --- | --- |
| `409` from ReserveSessions means "not open yet". It waits and tries again (every 20 s, 5 s within 10 minutes of the configured time, 3 s around it). | Reservations are closed through the API until Oct 8. |
| Reads every per-session result, never trusts a bare `200`. | A bulk request can succeed for some sessions and fail for others. |
| After a timeout or `5xx` it reads `GetSchedule` and sends only what is missing. It never re-sends blindly. | There is no idempotency key. |
| On `429` it halves the request and goes again. A single session waits `Retry-After`. | A refused request spends no quota. |
| Never puts two overlapping sessions in one request, and skips anything overlapping what you already hold. | Saves quota, avoids `scheduleConflict`. |
| Finishes by comparing `GetSchedule` with what it reported. | `GetSchedule` is the source of truth. |
| Token refresh is shared by parallel callers. | Refresh tokens rotate. |

API calls used: `GetEvent`, `ListSessions` (walked until there is no `nextToken`, then checked against `totalCount`), `GetSession`, `GetSchedule`, `ReserveSessions`, `CancelReservation`, `AssociateFavorites`. Sign-in is OAuth 2.0 authorization code with PKCE against the shared client ID, on a `localhost` callback in the range AWS reserves.

### Run it against a fake AWS

`mock/mock-events.js` is a local stand-in for the Events API and its OAuth server, built from AWS's published [OpenAPI description](https://api.awsevents.com/v1/openapi.json). It can be closed or open, run sessions out of seats, and fail requests on purpose. No real sign-in is needed.

```
node mock/mock-events.js
```

Then, in a second terminal, start the app pointed at it:

```
# PowerShell
$env:EVENTS_API_BASE="http://127.0.0.1:9000"; $env:EVENTS_OAUTH_BASE="http://127.0.0.1:9000"; $env:SNIPER_DATA_DIR="$PWD\data"; node server.js

# macOS / Linux
EVENTS_API_BASE=http://127.0.0.1:9000 EVENTS_OAUTH_BASE=http://127.0.0.1:9000 SNIPER_DATA_DIR=./data node server.js
```

`SNIPER_DATA_DIR` keeps the fake data apart from your real data. `MOCK_OPEN=0 node mock/mock-events.js` starts the fake with reservations closed.

### Tests

```
node --test test/shared.test.js test/auth-catalog.test.js test/booker.test.js test/parties.test.js
```

They cover sign-in and token refresh, the catalog download and its completeness check, filters and search, party parsing, and the booker (closed then open, full then backup, retries after a timeout, rate limits, resuming after a crash). The mock stands in for the live service, so the first real sign-in and the first real booking are the true end-to-end check.

### Files

```
server.js             local web server and routes
src/auth.js           Builder ID sign-in (OAuth + PKCE) and token refresh
src/api.js            Events API client with retry and error rules
src/catalog.js        session download and completeness check
src/booker.js         the reservation engine
src/parties.js        reads the community party list (fetched by the user, never bundled)
src/notify.js         email reports
src/store.js          files under ~/.reinvent-sniper
web/shared.js         filters, search and layout logic (used by the page and the tests)
web/index.html, app.js, calendar.js, icons.js, style.css   the interface
mock/mock-events.js   local stand-in for the Events API
test/                 tests
```

</details>
