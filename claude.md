# CLAUDE.md — Resume Scorer (Outlook → AI)

This file gives you (Claude Code) the persistent context for this project. Read it before every task.

## What we are building

A Chrome extension (Manifest V3) that:
1. Logs the user into their Microsoft / Outlook account via OAuth.
2. Reads recent emails that have attachments using the Microsoft Graph API.
3. Pulls resume attachments (PDF / DOCX) out of those emails.
4. Sends each resume to a small local backend, which calls an AI model.
5. The AI reviews the resume and scores it. The extension popup shows the score + review.

This is an MVP. Favor "works end to end" over "production hardened." Keep it simple.

## Hard architectural rules — do not violate

1. **Never put any API key inside the extension.** Extension code is fully readable by anyone. All AI calls go through the local backend, which holds the key in a `.env` file that is git-ignored.
2. **Manifest V3 only.** Background logic runs in a service worker, not a persistent background page.
3. **OAuth uses PKCE with a public client — no client secret.** A Chrome extension cannot safely store a secret. Use the authorization-code-with-PKCE flow via `chrome.identity.launchWebAuthFlow`.
4. **Do the AI call and the resume text extraction in the backend, not the extension.** The extension downloads the raw attachment (base64) and forwards it to the backend. The backend extracts text and calls the AI. This keeps the extension light and the key safe.
5. **Keep secrets out of git.** Always create/maintain a `.gitignore` covering `node_modules`, `.env`, and any token cache.

## Repo layout

```
resume-scorer/
  extension/
    manifest.json
    popup.html
    popup.css
    popup.js          // UI wiring, orchestration
    auth.js           // PKCE OAuth: login, token storage, refresh
    graph.js          // Microsoft Graph calls (list mails, get attachments)
    config.js         // CLIENT_ID, TENANT, SCOPES, BACKEND_URL (placeholders)
    background.js     // MV3 service worker (minimal)
    icons/            // 16/48/128 px placeholder icons
  backend/
    server.js         // Express: POST /score
    extract.js        // PDF + DOCX text extraction
    ai.js             // provider-agnostic AI call (anthropic | gemini)
    package.json
    .env.example
  README.md           // setup + Azure registration steps + how to run
  .gitignore
```

## OAuth / Microsoft Graph details

- Authority: `https://login.microsoftonline.com/{TENANT}/oauth2/v2.0`
  - `TENANT` = `common` (personal + work/school) unless told otherwise. Put it in `config.js`.
- Redirect URI: get it at runtime with `chrome.identity.getRedirectURL()`. It looks like `https://<EXTENSION_ID>.chromiumapp.org/`. This exact value must be registered in Azure as a **Single-page application** redirect URI (SPA platform enables CORS on the token endpoint, which lets the extension exchange the code directly).
- Scopes: `openid profile offline_access User.Read Mail.Read`
- Flow:
  1. Generate `code_verifier` (random 43–128 chars) and `code_challenge` = base64url(SHA-256(verifier)).
  2. `launchWebAuthFlow({ url: authorizeUrl, interactive: true })` to get the `code`.
  3. POST to the token endpoint with `grant_type=authorization_code`, the code, verifier, client_id, redirect_uri. No secret.
  4. Store `access_token`, `refresh_token`, expiry in `chrome.storage.local`.
  5. On expiry, refresh with `grant_type=refresh_token`.
- Graph calls (base `https://graph.microsoft.com/v1.0`):
  - List candidate mails: `GET /me/messages?$filter=hasAttachments eq true&$top=25&$select=id,subject,from,receivedDateTime`
  - List a message's attachments: `GET /me/messages/{id}/attachments?$select=id,name,contentType,size`
  - Download one attachment: `GET /me/messages/{id}/attachments/{attId}` → `contentBytes` is base64.
  - Treat an attachment as a resume if its name ends in `.pdf` / `.docx` (case-insensitive). Skip inline images and signatures.

## Backend details

- Express server, default `PORT=8787`.
- Enable CORS for the extension during dev (allow the `chrome-extension://` origin, or `*` for MVP).
- `POST /score` body: `{ filename, contentType, contentBase64 }`.
  - Decode base64 → extract text: PDF via `pdf-parse`, DOCX via `mammoth`.
  - Call the AI (see `ai.js`) and return JSON:
    ```json
    {
      "score": 0,
      "breakdown": { "experience": 0, "skills": 0, "education": 0, "clarity": 0, "impact": 0 },
      "summary": "",
      "strengths": [],
      "concerns": [],
      "recommendations": []
    }
    ```
  - Each sub-score and overall score is 0–100. Prompt the model to return **only** valid JSON; parse defensively (strip code fences before `JSON.parse`).
- `ai.js` is provider-agnostic, switched by `AI_PROVIDER` env (`anthropic` or `gemini`). Read the model name from a `MODEL` env var with a sensible default — do not hardcode a model string from memory; if unsure of the current model name, leave a clearly-marked default in `.env.example` and note in the README that the user should confirm the current model from the provider's docs.
  - Anthropic: `POST https://api.anthropic.com/v1/messages` with header `x-api-key` and `anthropic-version`.
  - Gemini: the Google Generative Language `generateContent` endpoint.

## Coding conventions

- Plain modern JavaScript (ES modules where the runtime allows). No build step, no bundler, no framework for the MVP — keep it loadable as an unpacked extension directly.
- For PDF/DOCX parsing, do it in the backend (Node libs), never in the extension.
- Small, readable functions. Comment the OAuth/PKCE steps clearly since that's the trickiest part.
- Fail loudly in the UI: if login fails, no resumes are found, or the backend is down, show a clear message in the popup, not a silent failure.

## Definition of done

- `npm install && npm run dev` starts the backend on localhost.
- Loading `extension/` unpacked in Chrome and clicking the icon shows a popup with a "Connect Outlook" button.
- After login, the popup lists emails that have resume attachments.
- Clicking one fetches the file, sends it to the backend, and renders the score + review.
- README explains: the Azure app registration steps, where to paste the `CLIENT_ID`, how to get the redirect URI, how to set the AI key in `.env`, and how to run everything.