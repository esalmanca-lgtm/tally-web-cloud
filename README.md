# Tally Web Cloud

Use Tally from any browser. Load your Tally XML export once; all reports,
ledgers, and voucher entry then run from Supabase. New vouchers export back
as a Tally import XML.

Stack: static frontend (Vercel) + Supabase (Postgres + Auth). No server code.

## Setup (one time, ~10 minutes)

### 1. Supabase
1. Create a project at https://supabase.com (or reuse an existing org).
2. SQL Editor → New query → paste the contents of `supabase.sql` → Run.
3. Authentication → Providers → Email: enabled (default). For convenience you
   can turn OFF "Confirm email" so sign-ups work instantly.
4. Project Settings → API: copy the **Project URL** and **anon public** key.

### 2. Configure
Edit `config.js` and paste the two values:

```js
window.TALLY_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

(The anon key is safe in frontend code — Row Level Security keeps each
login's data private.)

### 3. GitHub + Vercel
```bash
cd tally-web-cloud
git init && git add . && git commit -m "tally web cloud"
# create an empty repo on github.com, then:
git remote add origin https://github.com/YOURNAME/tally-web-cloud.git
git push -u origin main
```
On https://vercel.com → Add New Project → import the repo →
Framework preset: **Other** → no build command → Deploy.

Your app is live at `https://tally-web-cloud-xxxx.vercel.app`.

## Daily use
1. Open the URL, sign in (first time: Create account).
2. Load data: Gateway menu → **Load Tally Data (XML export)**.
   - Masters: Gateway of Tally → Alt+E → Masters → Format XML → All Masters
   - Transactions: Gateway of Tally → Alt+E → Transactions → Format XML,
     period = full year
3. Work: reports, ledger statements, voucher entry (F4–F9, Ctrl+A to accept).
4. Sync back: **Export New Vouchers → Tally**, then on the Tally PC:
   Gateway of Tally → Alt+O (Import) → Transactions → select the file.

## Notes
- Each Supabase login has its own private data (RLS). Staff can have their
  own accounts.
- Reports are computed from the loaded data; Stock Summary needs inventory
  masters which aren't part of the accounting export.
- Live Gateway mode (direct connection to a running Tally) is only possible
  in the local Mac version, not from a hosted site — browsers can't reach a
  LAN-only Tally port from an https page.
