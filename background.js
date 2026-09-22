// Runs the internet speed test here instead of in popup.js, on purpose: an MV3 background
// service worker's lifetime is independent of whether the popup is open — unlike the popup's own
// JS, which is destroyed the instant it loses focus or closes, silently killing an in-progress
// test. A chain of back-to-back fetch() calls (no idle gaps between them, which is how the loops
// below are shaped) keeps the service worker alive for the whole ~10s test.
//
// Uses Cloudflare's speed test endpoints (the same ones behind speed.cloudflare.com and the
// @cloudflare/speedtest npm package) instead of fast.com — documented and stable, no scraping a
// token out of an obfuscated JS bundle. Mirrors tcp-hardware-check-exe/Services/SpeedTestService.cs.

const DOWNLOAD_URL = "https://speed.cloudflare.com/__down?bytes=10000000";
const UPLOAD_URL = "https://speed.cloudflare.com/__up";

// One connection per test badly underestimates fast connections (same lesson learned from
// fast.com's single-stream-per-target design) — open several concurrent streams to approach the
// real link capacity instead of whatever one connection happens to sustain.
const STREAMS = 4;

// Upload chunk size is deliberately much smaller than the download chunk (10MB above): a large
// POST body can be handed to the browser's socket send buffer almost instantly regardless of the
// real uplink speed, so timing one big request start-to-response can badly overstate upload
// throughput — confirmed live: a naive single/few-chunk browser test read ~93 Mbps upload on a
// connection where a reference client tracking real bytes-in-flight (M-Lab's ndt7, which watches
// WebSocket bufferedAmount rather than trusting request/response timing) read ~24 Mbps on the
// same line. Many small round trips are far less likely to be entirely absorbed by buffering,
// since each one has to actually complete for the loop to continue — the same reasoning ndt7's
// own upload algorithm uses to grow message size gradually rather than send one large blob.
const UPLOAD_CHUNK_BYTES = 262_144;

const TEST_DURATION_MS = 5000;

// crypto.getRandomValues() throws QuotaExceededError above 65536 bytes per call, so a chunk
// bigger than that (like UPLOAD_CHUNK_BYTES here) has to be filled in slices.
function randomPayload(size) {
  const payload = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(payload.subarray(offset, Math.min(offset + 65536, size)));
  }
  return payload;
}

async function downloadChunk() {
  const buffer = await (await fetch(DOWNLOAD_URL, { cache: "no-store" })).arrayBuffer();
  return buffer.byteLength;
}

async function uploadChunk(payload) {
  await fetch(UPLOAD_URL, { method: "POST", body: payload });
  return payload.length;
}

async function measureSpeed(isUpload) {
  const start = performance.now();
  let totalBytes = 0;
  const payload = isUpload ? randomPayload(UPLOAD_CHUNK_BYTES) : null;

  const runStream = async () => {
    while (performance.now() - start < TEST_DURATION_MS) {
      totalBytes += isUpload ? await uploadChunk(payload) : await downloadChunk();
    }
  };

  await Promise.all(Array(STREAMS).fill().map(runStream));

  const elapsedSeconds = (performance.now() - start) / 1000;
  return Math.round(((totalBytes * 8) / elapsedSeconds / 1_000_000) * 10) / 10;
}

async function runSpeedTest() {
  const down = await measureSpeed(false);
  const up = await measureSpeed(true);
  return { down, up };
}

// Coalesces concurrent requests onto one in-flight test — if the popup closes and reopens while
// a test is still running, the new popup's message attaches to the same promise instead of
// starting a duplicate test.
let testPromise = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action !== "runSpeedTest") return false;

  if (!testPromise) {
    testPromise = runSpeedTest().finally(() => {
      testPromise = null;
    });
  }
  testPromise.then(
    (result) => sendResponse(result),
    (error) => sendResponse({ error: error.message }),
  );
  return true; // keep the message channel open for the async sendResponse above
});
