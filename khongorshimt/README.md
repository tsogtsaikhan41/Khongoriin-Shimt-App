# Хонгорын Шимт -- Мал Хяналтын Систем

A real, deployable web app (not a Claude artifact) -- offline-safe PWA,
real login, per-animal traceability, bundled slaughter/transport entry,
interactive dashboard, Excel export.

## What's in this folder

```
khongorshimt/
  public/            <- the actual website (deploy this as-is)
    index.html
    app.js
    config.js        <- YOU edit this (Supabase keys)
    manifest.json
    sw.js
    icon-*.png
  supabase/
    schema.sql       <- run this once in Supabase
  README.md          <- this file
```

## Setup (one-time, ~30-45 minutes)

### 1. Create a free Supabase project
- Go to supabase.com -> New Project (free tier)
- Wait ~2 minutes for it to provision

### 2. Run the database schema
- In your Supabase project: SQL Editor -> New query
- Paste the entire contents of `supabase/schema.sql` -> Run
- This creates all tables, security rules, and the code-generator function

### 3. Enable email auth (it's on by default, just confirm)
- Authentication -> Providers -> Email should be enabled
- Authentication -> Settings -> turn OFF "Confirm email" (staff use fake
  internal addresses, there's no real inbox to confirm)

### 4. Get your API keys
- Project Settings -> API
- Copy the "Project URL" and the "anon / public" key
  (never copy or share the "service_role" key)

### 5. Edit `public/config.js`
Paste your URL and anon key into the two placeholders.

### 6. Push to GitHub
Create a new repository and push this whole folder to it (GitHub's
"upload files" button in the browser works fine, no command line needed).

### 7. Deploy on Vercel
- vercel.com -> New Project -> import your GitHub repo
- Root directory: set to `public`
- Framework preset: "Other" (no build step needed -- it's plain HTML/JS)
- Deploy

That's it -- you'll get a live `https://your-project.vercel.app` URL.
Optionally buy a custom domain later and point it at the same project.

## First login

Open the live URL. Nobody has an account yet, so you'll see "Эхний
тохиргоо" (first-run setup). The first account created here automatically
becomes Super Admin. After that, the Super Admin creates staff accounts
from the "Хэрэглэгч удирдах" screen inside the app.

## How offline mode works

- The app shell (HTML/CSS/JS) is cached by a service worker, so it opens
  even with zero signal.
- Saving a form while offline stores the record in the browser's
  IndexedDB and shows a "N хүлээгдэж буй" badge.
- When the device reconnects (or the app is reopened with signal), it
  automatically pushes queued records to the database.
- Animal codes created offline are still valid and permanent, but use a
  counter starting at 900+ so they're visually distinguishable from
  codes generated while online (this avoids numbering collisions between
  two offline devices using the same herder/date).

## Known limitations (same ones discussed in chat)

- If a device is offline for an extended period and the browser fully
  clears site data (rare, but possible on iOS Safari after ~1-2 weeks
  of the app not being opened), unsynced queued records could be lost.
  Encourage staff to open the app periodically even without a task.
- Editing a record is Super-Admin-only, by design (this is the
  "fix mistakes" mechanism). There is no delete feature anywhere in the
  app, also by design.
- Staff self-select their working context (soum vs. shop) each time they
  switch -- there's no hard per-account lock to one specific soum. This
  is a deliberate simplicity/trust tradeoff, not an oversight.
