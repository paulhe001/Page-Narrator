# Page Narrator (AWS Polly)

A Manifest V3 extension that injects a floating play button in the top-left corner of every page. When tapped, it sends the readable text on the page to Amazon Polly via signed AWS requests and streams the audio chunks back for inline playback.

## Features
- One-tap floating play button positioned where you requested (top-left).
- Uses a content script/worker split so your AWS credentials never touch the page context.
- SigV4-signed, chunked requests keep long articles under Polly's size limits and stream audio as it's ready.
- Auto-detects Chinese passages and switches to Polly's Mandarin voice (Zhiyu) with the right language code.
- Options page to store your IAM access keys locally and pick a preferred Polly voice (Joanna, Matthew, Amy, Salli, Zhiyu by default).

## Installation (desktop + Android Chrome dev channel)
1. Clone or copy the `tts-extension` folder to your machine/phone.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (desktop) or **Extension Developer mode** (on Android Canary/Dev builds that now support extensions).
4. Click **Load unpacked**, then select the `tts-extension` directory.
5. Open the extension options page and paste an AWS access key ID/secret with the `AmazonPollyFullAccess` (or tighter) policy, then choose a default voice.
6. Visit any page and tap the play button in the top-left corner to start narration.

### Mobile caveats
- Chrome on iOS still does not support extensions; you'll need Android Chrome on the Canary/Dev channel (extension support rollout started in Chrome 120+). Alternatives like Kiwi or Yandex Browser on Android also allow MV3 extensions.
- Background audio respects the site's media permissions—if autoplay is blocked, the extension will prompt you to interact with the page first.
- Because the extension fetches directly from `https://polly.<region>.amazonaws.com`, the phone must have internet access and the key remains on-device.

## AWS setup
1. Create or pick an IAM user with programmatic access and attach `AmazonPollyReadOnlyAccess` (or a custom policy that allows `polly:SynthesizeSpeech`).
2. Generate an access key ID and secret, then store them in the extension options page along with the region you plan to call (e.g., `us-east-1`).
3. Rotate the keys periodically and delete them if the device is lost. The extension keeps them in Chrome's local storage and only uses them to sign Polly calls.

## Chinese narration
- Any chunk containing Han characters (`\u3400-\u9FFF`) is synthesized with Zhiyu in `cmn-CN`, so mixed-language articles keep Mandarin sounding natural.
- Set the default voice to Zhiyu in the options page if you want all narration in Chinese regardless of detection.

## Configuration notes
- Text longer than ~8,000 characters is truncated to keep TTS requests manageable. Adjust `MAX_TOTAL_CHARS` and `CHUNK_SIZE` in `background.js` if you need longer narration.
- Each chunk prepends the page title once so listeners know what they're hearing.
- Clicking the button while narration is running sends a cancel message, stops playback, and cleans up the queue.
- Errors and status updates appear under the play button and in the background service worker console so debugging stays easy.

## Next steps
- Add a popup UI for quick settings (speed, voice, summary vs. verbatim).
- Consider optional summaries (e.g., using AWS Bedrock or another LLM) before handing content to Polly for very long pages.
