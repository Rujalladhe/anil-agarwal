// Public extension config. Do NOT put any API key here -- extension code is
// readable by anyone who installs it. AI keys live in backend/.env only.

export const CLIENT_ID = "393fae85-0bb8-4b48-b839-9e780baacdc2";

// "common" works for both personal Microsoft accounts and work/school accounts.
// Use a specific tenant id if you want to restrict to one org.
export const TENANT = "common";

// Delegated Microsoft Graph scopes we need.
//   offline_access -> refresh tokens
//   User.Read      -> identify the signed-in user
//   Mail.Read      -> list messages + read attachments
export const SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Mail.Read"
];

// Local backend that does PDF/DOCX extraction + AI scoring.
export const BACKEND_URL = "http://localhost:8787";
