# MedBuddy

MedBuddy turns plain-language medication instructions into a daily schedule with reminders, tracking, and clear instructions. It also includes label scanning, doctor discovery, and a private place to keep insurance details.

> **Medical disclaimer:** MedBuddy is a reminder and organisation tool, not medical advice. Always verify information against the pharmacy label and contact a pharmacist or clinician when something is unclear.

## Features

- **Natural-language medication capture** — Paste, type, or dictate instructions such as “Amoxicillin 500mg three times a day for 10 days with food.” The local parser identifies medicines, doses, timing, duration, and warnings.
- **Medication schedule and adherence** — See today's doses, mark them taken, snooze an alert, and review active and completed prescriptions.
- **Reminders** — Enable sound, vibration, and browser notifications; use the built-in 10-second test alarm to check that they work on your device.
- **Label scanner** — Scan or upload a pharmacy label. OCR runs in the browser with Tesseract.js; optional drug-label information comes from OpenFDA.
- **Find Care** — Describe symptoms or choose a specialty, provide a location, and search for nearby clinicians through OpenStreetMap. US searches can also use the NPI Registry.
- **Insurance wallet** — Save insurance details and keep card images or policy PDFs in the browser's IndexedDB storage. The app warns when an expiry date is approaching.
- **Caregiver sharing** — Generate a read-only schedule link. Its data is placed in the URL fragment, which browsers do not send with HTTP requests.
- **PWA support** — Install the site as an app and retain the application shell for offline use.
- **Account sync** — Sign in with email to sync medication state across devices through Supabase. The app is designed so each user can access only their own state when the Supabase Row Level Security policy is configured correctly.
- **Streaks and celebrations** — Marking every dose taken keeps a day streak alive, shown as a badge on the Today view. Completing a day triggers a small confetti celebration; crossing a streak milestone (3, 7, 14, 30, 50, 100, 200, 365 days) triggers a bigger one.
- **Opt-in leaderboard** — Tap the streak badge to join a leaderboard under a chosen nickname and compare streaks with other users. Only the nickname and streak number are ever shared — medication data is never part of this table, and joining is entirely optional.
- **Physics-based bottom sheets** — Medication details, the insurance document viewer, and the leaderboard open in sheets that can be dragged down to dismiss, with real spring physics (velocity-aware, interruptible mid-drag) rather than a fixed animation.
- **Light and dark themes** — A toggle in the bottom-right corner switches between a cream light theme and a dark theme, persisted across visits.

## Run locally

This is a static site with no build step. Serve the project folder over HTTP rather than opening `index.html` directly:

```powershell
py -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000). `python -m http.server 8000` also works when Python is on your PATH.

Using localhost (or HTTPS in production) is required for service workers, notifications, speech recognition, camera access, and geolocation.

## How to use it

1. Create an account or sign in to use synced storage.
2. Open **Add**, enter your prescription instructions, then select **Read my orders**.
3. Carefully review and correct the parsed medication cards before saving them.
4. Open **Today** and enable alarms. Use **Test alarm (10s)** before relying on reminders.
5. Use **Prescriptions** to scan a label or share a read-only caregiver view.
6. Use **Find Care** to discover relevant specialists, or **Insurance** to save coverage information and document images.

## Architecture

| Area | Implementation |
| --- | --- |
| UI | Vanilla HTML, CSS, and JavaScript |
| Medication parsing | Local, deterministic parser in `parser.js` |
| Medication OCR | Tesseract.js, loaded only when scanning |
| Drug information | OpenFDA label API |
| Care search | OpenStreetMap Overpass API and US NPI Registry |
| Authentication and sync | Supabase Auth and an `app_state` table |
| Leaderboard | A separate opt-in `leaderboard` table (nickname + streak only), Row Level Security scoped per user for writes and readable by any signed-in user |
| Bottom sheets | `sheet-controller.js` — a small dependency-free spring-physics engine for drag-to-dismiss sheets |
| Local data | `localStorage` for state and IndexedDB for insurance documents |
| Offline shell | Service worker and web app manifest |

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | Application markup and views |
| `styles.css` | Responsive UI styling |
| `app.js` | Navigation, schedules, reminders, sharing, rendering, and app boot |
| `parser.js` | Medication-instruction parser |
| `scanner.js` | OCR workflow and OpenFDA lookup |
| `doctors.js` | Symptom matching, location handling, and clinician search |
| `insurance.js` | IndexedDB storage for insurance documents |
| `cloud.js` | Supabase authentication, cloud-state sync, and leaderboard reads/writes |
| `sheet-controller.js` | Spring-physics drag-to-dismiss bottom sheets |
| `sw.js` | Service-worker caching and notification-click handling |
| `manifest.json` | Installable web-app metadata |

## External services and privacy

- Medication parsing happens on-device.
- Label photos are processed locally by the OCR library; they are not uploaded by MedBuddy.
- Drug lookup sends the medication name to OpenFDA.
- Find Care sends the selected specialty and search location to the provider-search services.
- Insurance document files remain in the current browser's IndexedDB and are not part of the cloud-sync payload.
- When signed in, medication state is stored in the configured Supabase project. Keep the Supabase Row Level Security policies enabled so a signed-in user can only read and write their own `app_state` row.
- The leaderboard is opt-in. Joining writes only a chosen nickname and the current streak number to a separate `leaderboard` table — never anything from `app_state`. Any signed-in user can read the full leaderboard (that's the point of it), but Row Level Security restricts every insert, update, and delete to `auth.uid() = user_id`, so no one can alter another user's entry. Leaving the leaderboard deletes the row.

The service worker caches the app shell, but some features still need a connection: first-time OCR-library loading, OpenFDA lookup, clinician search, fonts, and cloud sync.

## Deployment notes

Deploy the whole folder to any static host that supports HTTPS. Keep the asset version query strings in `index.html` and the matching cache list/version in `sw.js` aligned whenever app assets change; otherwise existing installations may continue using an older cached build.

The current Supabase project URL and public anonymous key are configured in `cloud.js`. A production deployment should use a Supabase project with email authentication enabled and a restrictive Row Level Security policy on `app_state` keyed to `auth.uid()`. To enable the leaderboard, also create the `leaderboard` table with its own RLS policies (public read for signed-in users, writes restricted to `auth.uid() = user_id`) — the leaderboard sheet works without it, it just stays empty.

GitHub Pages serves `404.html` automatically for any unmatched path — no extra configuration needed there.

## Known limitations

- Browser alarms are most reliable while the app is open. Mobile operating systems can restrict background web notifications and audio.
- OCR accuracy depends on a clear, well-lit label; always review results before saving.
- Doctor-search coverage varies by area, and search results are not medical recommendations.
- Browser storage can be cleared by the user or browser. Keep source documents elsewhere as a backup.

## License

All rights reserved. See [LICENSE](LICENSE).
