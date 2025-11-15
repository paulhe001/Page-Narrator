# Repository Guidelines

## Project Structure & Module Organization
The top-level `tts-extension/` directory is the full Chrome MV3 package. Core runtime logic lives in `background.js` (AWS Polly streaming and messaging) and `contentScript.js` (UI overlay plus audio queue). Browser UI assets—`overlay.css`, `options.html`, and `options.js`—own presentation and credential storage. Keep helpers beside their consumers; everything ships as plain Chrome-injected scripts with no bundler.

## Build, Test, and Development Commands
- `cd tts-extension && zip -r ../page-narrator.zip .` bundles the folder for distribution in the Chrome Web Store.
- `open -a "Google Chrome" "chrome://extensions"` (macOS) jumps directly to the Extensions page so you can load the unpacked folder for local testing.
- Use Chrome DevTools → “service worker” from the extension card to watch `console.log` output and network calls to `polly.<region>.amazonaws.com`.

## Coding Style & Naming Conventions
JavaScript is modern (ES2022+) but intentionally dependency-free; prefer built-in APIs such as `fetch`, `AbortController`, and `crypto.subtle`. Maintain 2-space indentation, single quotes, and trailing commas for multi-line literals as seen in `background.js`. Name booleans with `is/has`, async helpers with verbs (`requestSpeechChunk`), and keep constants `SCREAMING_SNAKE_CASE`. Reuse the existing messaging patterns (`tts-*` events) when adding new interactions between the worker and content script.

## Testing Guidelines
There is no automated test harness, so rely on manual verification: load the unpacked extension, click the floating button on pages of varying length, and cancel mid-stream to ensure the abort logic still fires. While testing credentials, use Chrome’s “background page” console to confirm SigV4 headers are accepted (HTTP 200 with `audio/mpeg`). Before publishing, run through at least one happy-path narration per supported Polly voice and region, including a page with Chinese paragraphs to verify Zhiyu auto-selection.

## Commit & Pull Request Guidelines
This repository has no commit history yet, so establish a clean baseline: write imperative, present-tense summaries (`Add Polly signer helper`) with optional scopes. In PRs, describe behavior changes, note any manual test coverage (e.g., “Loaded on Chrome 124, narrated nytimes.com”), and link issue numbers if available. Screenshots or short screen recordings of the floating button are helpful when the UI changes. Guard AWS secrets—never paste real keys in commits or PR bodies.

## Security & Configuration Tips
Store IAM users with the narrowest policy needed (`polly:SynthesizeSpeech`) and rotate credentials regularly. Secrets remain in Chrome’s local storage, but encourage contributors to delete them after debugging shared machines. Double-check `host_permissions` before shipping to ensure only `https://polly.*.amazonaws.com/*` and the target pages are requested.
