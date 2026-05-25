// OAuth 2.0 Authorization Code with PKCE for Microsoft identity platform.
//
// Why PKCE: a Chrome extension is a public client and cannot safely store a
// client secret. PKCE proves the same caller that started the flow is the one
// redeeming the code, by binding the request to a one-time secret (verifier).
//
// Flow:
//   1. Generate a random `code_verifier` (43-128 chars, URL-safe).
//   2. Compute `code_challenge` = base64url(SHA-256(verifier)).
//   3. Open the Microsoft /authorize URL via chrome.identity.launchWebAuthFlow.
//      Microsoft redirects back to chrome.identity.getRedirectURL() with a
//      ?code=... query param.
//   4. POST that code to /token along with the verifier (no client secret).
//   5. Stash access_token + refresh_token + expiry in chrome.storage.local.
//   6. getValidToken() refreshes the access_token when within 60s of expiry.

import { CLIENT_ID, TENANT, SCOPES } from './config.js';

const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const STORAGE_KEY = 'ms_oauth_tokens_v1';

// chrome.identity.getRedirectURL() looks like:
//   https://<EXTENSION_ID>.chromiumapp.org/
// This exact value must be registered in Azure as a Single-page application
// redirect URI on the app registration.
export function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

// Print the redirect URI on first load so the user can copy it into Azure.
// (Service worker -- safe to log; no PII.)
let printedRedirect = false;
function printRedirectOnce() {
  if (printedRedirect) return;
  printedRedirect = true;
  console.log(
    '[auth] Register this exact redirect URI in your Azure app registration\n' +
    '       as a Single-page application (SPA) redirect URI:\n' +
    '       ' + getRedirectUri()
  );
}

// --- PKCE helpers ----------------------------------------------------------
function base64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier(length = 64) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf).slice(0, length);
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

async function makeChallenge(verifier) {
  const hash = await sha256(verifier);
  return base64UrlEncode(hash);
}

// --- Token storage ---------------------------------------------------------
async function saveTokens(tokens) {
  await chrome.storage.local.set({ [STORAGE_KEY]: tokens });
}

async function loadTokens() {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  return obj[STORAGE_KEY] || null;
}

export async function clearTokens() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

function tokensFromResponse(json) {
  // expires_in is seconds-from-now; convert to absolute ms for easy comparison.
  const expiresAt = Date.now() + (Number(json.expires_in || 0) * 1000);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null, // may be absent on refresh
    expires_at: expiresAt,
    scope: json.scope || SCOPES.join(' '),
    token_type: json.token_type || 'Bearer'
  };
}

// --- Interactive login (PKCE) ---------------------------------------------
export async function login() {
  printRedirectOnce();

  if (!CLIENT_ID || CLIENT_ID === 'PASTE_AZURE_CLIENT_ID_HERE') {
    throw new Error('CLIENT_ID not set. Paste your Azure Application (client) ID into extension/config.js.');
  }

  const verifier = randomVerifier(64);
  const challenge = await makeChallenge(verifier);
  const state = randomVerifier(16); // CSRF guard
  const redirectUri = getRedirectUri();

  const authorizeUrl =
    `${AUTH_BASE}/authorize` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256` +
    `&state=${encodeURIComponent(state)}` +
    `&prompt=select_account`;

  const redirectedTo = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl,
    interactive: true
  });

  if (!redirectedTo) {
    throw new Error('Login was cancelled or no redirect was returned.');
  }

  const url = new URL(redirectedTo);
  const params = url.searchParams;
  const errParam = params.get('error');
  if (errParam) {
    throw new Error(`OAuth error: ${errParam} — ${params.get('error_description') || ''}`);
  }

  const returnedState = params.get('state');
  if (returnedState !== state) {
    throw new Error('OAuth state mismatch — possible CSRF; aborting.');
  }

  const code = params.get('code');
  if (!code) {
    throw new Error('No authorization code returned by Microsoft.');
  }

  // Exchange code for tokens. SPA redirect URI type enables CORS on /token,
  // so this fetch from inside the extension is allowed.
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: SCOPES.join(' ')
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const tokens = tokensFromResponse(json);
  await saveTokens(tokens);
  return tokens;
}

// --- Refresh ---------------------------------------------------------------
async function refresh(refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' ')
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const next = tokensFromResponse(json);
  // Microsoft sometimes rotates the refresh token, sometimes doesn't.
  if (!next.refresh_token) next.refresh_token = refreshToken;
  await saveTokens(next);
  return next;
}

// --- Public API used by graph.js / popup.js -------------------------------
export async function isLoggedIn() {
  const t = await loadTokens();
  return !!(t && t.access_token);
}

// Returns a usable access token, refreshing if it's expired or about to be.
export async function getValidToken() {
  printRedirectOnce();
  const t = await loadTokens();
  if (!t || !t.access_token) {
    throw new Error('Not signed in. Click "Connect Outlook" first.');
  }

  // Refresh if within 60 seconds of expiry.
  const skewMs = 60 * 1000;
  if (Date.now() + skewMs >= (t.expires_at || 0)) {
    if (!t.refresh_token) {
      throw new Error('Access token expired and no refresh token is available. Sign in again.');
    }
    const refreshed = await refresh(t.refresh_token);
    return refreshed.access_token;
  }
  return t.access_token;
}
