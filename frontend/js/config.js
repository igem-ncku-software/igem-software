// =========================================================
// Central config: the backend base URL.
// Local dev (localhost / 127.0.0.1) hits the local uvicorn; everything else hits the live URL.
//
// This project has no build step (plain static files deployed straight to GitHub Pages), so
// there's no way to do the usual SPA trick of injecting env vars at build time. Hence the
// hostname check, kept in this one file rather than duplicated in every script.
//
// If the Render URL ever changes, updating this one line is enough — everywhere that calls
// the backend (dose_response.js, device_live.js, hardware_api.js, backend_status.js) picks
// it up automatically. CAPTURE-Screen's own URL needs updating too: BACKEND_HOST in
// firmware/capture_screen/capture_screen.ino.
//
// Must load before every other <script> that uses BACKEND_BASE_URL.
// =========================================================

const BACKEND_BASE_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://127.0.0.1:8000"
  : "https://igem-ncku-software.onrender.com";
