/**
 * Speed limit config (optional).
 * Google API key is now on the backend (Railway env GOOGLE_MAPS_API_KEY).
 * The app calls GET /api/speed-limit/?lat=...&lng=... and the backend proxies to Google.
 * No key is shipped in the app. This file is kept for any future client-side config.
 */
module.exports = {};
