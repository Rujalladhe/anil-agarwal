# Resume Scorer — Outlook → AI

A Chrome extension (Manifest V3) + tiny local Node backend that:

1. Logs you into Outlook with OAuth (PKCE, no client secret).
2. Lists recent emails that have **PDF / DOCX** attachments via Microsoft Graph.
3. Sends the chosen attachment to a local backend, which extracts the text and
   asks an LLM (**Groq Llama 3.3 70B Versatile** by default — free tier) for a
   0–100 score with a per-category breakdown, summary, strengths, concerns and
   recommendations.
4. Indexes every scored resume with **local embeddings (Transformers.js)** into
   SQLite + sqlite-vec for **free, offline semantic search** + RAG chat.
5. Ships a full **recruiter dashboard** at <http://localhost:8787> with a sidebar,
   six charts (categories, score distribution, match bands, daily inflow,
   breakdown radar, years of experience), drag-drop upload, candidate search,
   per-resume + cross-resume **AI chat**, and **Excel export** with summaries.

> MVP, not production. Keep it simple, ship features.

---

## Architecture (1-minute version)

```
+--------------------+     1. PKCE login         +-----------------------+
|  Chrome Extension  |  ---------------------->  |  Microsoft Identity   |
|  (popup.js)        |  <-- access_token -----   +-----------------------+
|                    |
|                    |     2. List mails + download attachment (base64)
|                    |  --------------------------------------------->  Microsoft Graph
|                    |
|                    |     3. POST /score { filename, contentType, contentBase64 }
|                    |  ----------------------------------------------------------->  Local backend
|                    |                                                                 (Express)
|                    |                                                                  |
|                    |                                                                  v
|                    |                                                          extract.js (pdf-parse/mammoth)
|                    |                                                                  v
|                    |                                                          ai.js  (Groq / Anthropic / Gemini)
|                    |  <----------------- scored JSON ----------------------------------+
+--------------------+
```

**Rules baked in:**

- No API keys in the extension — the AI key lives only in `backend/.env`.
- OAuth is **PKCE with a public client** — no client secret stored anywhere.
- PDF/DOCX parsing and the AI call happen in the **backend**, not the extension.

---

## Setup

You need to do three manual things before this will run:

1. **Register an Azure app** to get a `CLIENT_ID`.
2. **Paste the client id** into [extension/config.js](extension/config.js).
3. **Get an AI API key** (Groq is free) and put it in `backend/.env`.

Details below.

### 1. Backend

```powershell
cd backend
npm install
copy .env.example .env
# open backend/.env and fill in GROQ_API_KEY (or switch AI_PROVIDER + key)
npm run dev
```

You should see:

```
Resume Scorer backend listening on http://localhost:8787
  provider: groq
  model:    llama-3.3-70b-versatile
```

### Open the dashboard

Once the backend is running, visit <http://localhost:8787> in your browser. You
get:

- **Overview** — KPIs (total, avg score, top categories, strong matches) +
  six charts (category bar, score-distribution bar, match-band doughnut,
  14-day inflow line, breakdown radar, years-of-experience bar).
- **Candidates** — searchable / filterable table; click a row for a
  per-candidate modal with breakdown bars and contact info.
- **AI Chat** — switch between *all-resumes* mode (ask "show me backend devs
  with 2+ years") and *one-resume* mode (chat about a single candidate's
  strengths). Filter-y queries (category, years, skills, location, top-N) are
  parsed with regex BEFORE hitting the LLM, so they don't burn Groq tokens.
- **Settings** — backend health + token-saving notes.

A `Dashboard ↗` button in the extension popup opens this dashboard in a new
tab.

### Saving Groq tokens

The backend is designed to be cheap to run:

- The first AI score on a resume is cached (the `summary`, `strengths`, etc.
  are stored in `data.db`). The Summarize buttons reuse that — repeat clicks
  cost nothing.
- The `(email_id, attachment_id)` unique index in `resumes` means re-scoring
  the same Outlook attachment is a no-op.
- Embeddings run **locally** via Transformers.js — no embedding API needed.
- Chat queries like "backend devs with 3+ years" are answered by a SQL filter
  first; the LLM only writes the final natural-language reply, with a much
  smaller prompt than full RAG.

> **Groq model note:** the default is `llama-3.3-70b-versatile`. Groq occasionally
> renames or deprecates model ids — if you get a `model_not_found` error, look up
> the current name at <https://console.groq.com/docs/models> and update `MODEL` in
> your `.env`. For Anthropic and Gemini, confirm the current model id in their
> docs (links inside [backend/.env.example](backend/.env.example)) before relying
> on the defaults.

### 2. Azure app registration (one-time)

1. Go to <https://entra.microsoft.com> → **Applications → App registrations → New registration**.
2. Name it anything (e.g. `Resume Scorer Dev`).
3. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts* (matches `TENANT=common`).
4. Skip the redirect URI on this screen — we'll add it after we have the extension's id. Click **Register**.
5. In the new app: **API permissions → Add a permission → Microsoft Graph → Delegated permissions** and add:
   - `User.Read`
   - `Mail.Read`
   - `offline_access` (usually preselected)
   - `openid`, `profile` (usually preselected)
   Click **Grant admin consent** if available (not required for personal accounts).
6. Leave Azure open — you'll come back to add the redirect URI in step 4 below.

### 3. Load the extension unpacked

1. In Chrome, open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select the [extension/](extension/) folder.
3. Open the extension's **service worker console** (on the extensions page,
   click `service worker` under "Resume Scorer"). You'll see something like:

   ```
   [Resume Scorer] OAuth redirect URI for Azure registration (Single-page application):
     https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/
   ```

   Copy that URL.

### 4. Add the redirect URI in Azure + paste the CLIENT_ID

1. Back in your Azure app: **Authentication → Add a platform → Single-page application**.
2. Paste the redirect URI from the service worker console exactly as printed
   (must end with a trailing `/`). Save.
3. From the app's **Overview** tab copy **Application (client) ID**.
4. Open [extension/config.js](extension/config.js) and replace
   `PASTE_AZURE_CLIENT_ID_HERE` with that id.
5. On `chrome://extensions`, hit the reload icon on the Resume Scorer card so
   it picks up the new config.

> The redirect URI **must be the SPA type**, not Web. SPA enables CORS on the
> token endpoint, which lets the extension exchange the auth code directly
> without a client secret.

---

## Using it

1. Make sure the backend is running (`npm run dev` in `backend/`).
2. Click the Resume Scorer toolbar icon → **Connect Outlook**.
3. Approve the Microsoft sign-in / consent screen.
4. The popup lists recent emails with PDF / DOCX attachments. Click one.
5. Wait ~3–8 seconds. You'll see an overall score, a per-category bar
   chart, a summary, strengths, concerns and recommendations.
6. Click **Dashboard ↗** in the popup header to open the full recruiter
   dashboard in a new tab.

If the inbox is empty, send yourself an email with any PDF or DOCX resume
attached, then hit **Refresh inbox**.

---

## Automation builder (Outlook → AI → Calendar / Meet / Gmail)

The dashboard has an **Automation** tab — an N8N-style canvas where you wire
together triggers, filters, and actions. The included playbooks let you do
things like: "for everyone scoring ≥ 75, send the OA link **and** book a 30-min
Google Meet interview with a panel of three engineers — find the first free slot
on their calendars."

### Node types

- **Trigger · Manual run** — fires when you press Execute. (Only trigger for the MVP.)
- **Logic · Filter** — score ≥ X, category, years, has/needs skills, must-have-email.
- **Logic · Branch** — splits items into "top" (≥ threshold) and "rest" streams.
- **Logic · Take top N** — sort by score, keep top N.
- **Action · Send OA link** — Gmail send, template + `{{placeholders}}`.
- **Action · Schedule interview** — picks the next free slot across the chosen
  interviewers' calendars, creates an event with a fresh **Google Meet** link,
  invites the candidate.
- **Action · Polite rejection** — warm/direct/encouraging tones.
- **Action · Notify me** — pin a note in the run history.
- **Action · Log note** — stamp the run for later filtering.

### Edge cases handled

- **Dry-run mode** renders every email + every booking *without* sending — the
  preview shows the exact subject/body/attendees. Use this before any blast.
- Candidates with **no email on file** are recorded as `skipped`, not errors.
- A **cycle detector** stops you from wiring a graph back on itself.
- **Cancelled / failed** Gmail / Calendar calls are surfaced per-candidate in
  the run history with the API's error message — partial runs keep going.
- **Token refresh** is automatic — we refresh 60 s before expiry.
- **Rate-limit pacing** — small delays between Gmail / Calendar calls.

### Required API keys

The Resume Scorer side keeps using your existing `GROQ_API_KEY` / `MODEL`.
Automation actions that touch Google add three more values to `backend/.env`:

```env
# --- Google OAuth (Calendar + Gmail + Meet) ---
GOOGLE_CLIENT_ID=xxxx-xxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxx
GOOGLE_REDIRECT_URI=http://localhost:8787/automation/google/callback
```

Steps to get those values:

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** — enable both:
   - *Google Calendar API*
   - *Gmail API*
3. **APIs & Services → OAuth consent screen**
   - User type: **External** (testing mode is fine).
   - Add the Gmail address you'll send from as a **Test user**.
   - Add scopes: `gmail.send`, `calendar.events`, `calendar.readonly`,
     `openid`, `email`, `profile`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - Authorized redirect URI: `http://localhost:8787/automation/google/callback`
     (must match `GOOGLE_REDIRECT_URI` byte-for-byte).
5. Copy the **Client ID** + **Client secret** into `backend/.env` and restart
   the backend.
6. Open the dashboard → **Settings → Google connection → Connect Google**, walk
   through the consent screen. You're done.

You do **not** need a Meet API key — Meet links are conferences attached to
Calendar events. As long as the user authorizing has a Google account that can
create Meet meetings (any consumer or Workspace account), the
`conferenceData.createRequest` field in the event-create call gets us a fresh
Meet URL automatically. The URL appears in the run-history detail and in the
calendar invite.

### Smoke tests

```bash
cd backend && node test-automation.js
```

29 tests — exercises schema, CRUD, filter logic, template rendering, end-to-end
dry-run, cycle detection, and the route handlers. No network calls.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `CLIENT_ID not set` in popup | Step 4 above — paste the client id into `extension/config.js` and reload the extension. |
| `AADSTS50011: ... redirect URI ... did not match` | The URI in Azure must match `chrome.identity.getRedirectURL()` **exactly**, including trailing `/`. Re-copy from the service worker console. |
| `AADSTS9002326: Cross-origin token redemption ...` | The redirect URI in Azure is registered as **Web**, not **Single-page application**. Delete it and re-add under the SPA platform. |
| `Could not reach backend at http://localhost:8787` | Backend isn't running, or another process owns port 8787. Start it with `npm run dev`, or change `PORT` in `.env` and `BACKEND_URL` in `extension/config.js`. |
| `Groq API 400: model ... does not exist` | Set `MODEL` in `backend/.env` to a currently-listed model from <https://console.groq.com/docs/models>. |
| `Could not extract enough text from the attachment` | The PDF is probably a scanned image, not a text PDF. OCR isn't in scope for the MVP. |
| Login window flashes and closes with no result | Make sure you're signed into Chrome with the Google profile you want and that pop-ups aren't blocked. Also verify Azure permissions include `Mail.Read`. |

---

## Manual steps recap (TL;DR)

You — the human — must do these three things; everything else is already wired:

1. **Register an Azure app**, add Graph delegated permissions
   `User.Read` + `Mail.Read` + `offline_access`, and add a **Single-page
   application** redirect URI equal to the value printed in the extension's
   service worker console (looks like `https://<id>.chromiumapp.org/`).
2. **Paste the Application (client) ID** from Azure into
   [extension/config.js](extension/config.js) (`CLIENT_ID`).
3. **Get a free Groq API key** at <https://console.groq.com/keys> (or use
   Anthropic / Gemini), and put it in [backend/.env](backend/.env.example) as
   `GROQ_API_KEY=…` (matching the default `AI_PROVIDER=groq`).

Then `npm run dev` in `backend/` and reload the extension in `chrome://extensions`.
