// Runs the internet speed test here instead of in popup.js, on purpose: an MV3 background
// service worker's lifetime is independent of whether the popup is open — unlike the popup's own
// JS, which is destroyed the instant it loses focus or closes, silently killing an in-progress
// test. A chain of back-to-back fetch() calls (no idle gaps between them, which is how the loops
// below are shaped) keeps the service worker alive for the whole ~10s test.
//
// Primary: Cloudflare's speed test endpoints (the same ones behind speed.cloudflare.com and the
// @cloudflare/speedtest npm package) — documented and stable, no scraping a token out of an
// obfuscated JS bundle like fast.com required.
//
// Fallback: M-Lab's NDT7 (locate.measurementlab.net + a WebSocket protocol) — confirmed live that
// Cloudflare's public endpoint has no documented rate-limit SLA and does start rejecting requests
// (429) after enough test volume from one IP. Falling back to a second, independently-operated
// provider means a temporary block on one doesn't take down the whole speed test. Mirrors
// tcp-hardware-check-exe/Services/SpeedTestService.cs.

const CLOUDFLARE_DOWNLOAD_URL = "https://speed.cloudflare.com/__down?bytes=10000000";
const CLOUDFLARE_UPLOAD_URL = "https://speed.cloudflare.com/__up";

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

const NDT7_LOCATE_URL = "https://locate.measurementlab.net/v2/nearest/ndt/ndt7";
const NDT7_SUBPROTOCOL = "net.measurementlab.ndt.v7";
const NDT7_MAX_MESSAGE_BYTES = 8_388_608; // 8MB, matches the ndt7-js reference client

// crypto.getRandomValues() throws QuotaExceededError above 65536 bytes per call, so a chunk
// bigger than that has to be filled in slices.
function randomPayload(size) {
  const payload = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(payload.subarray(offset, Math.min(offset + 65536, size)));
  }
  return payload;
}

async function downloadChunk() {
  const buffer = await (await fetch(CLOUDFLARE_DOWNLOAD_URL, { cache: "no-store" })).arrayBuffer();
  return buffer.byteLength;
}

async function uploadChunk(payload) {
  const response = await fetch(CLOUDFLARE_UPLOAD_URL, { method: "POST", body: payload });
  if (!response.ok) {
    throw new Error(`Cloudflare upload failed: ${response.status}`);
  }
  return payload.length;
}

async function measureCloudflareSpeed(isUpload) {
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

async function getNdt7Urls() {
  const response = await fetch(NDT7_LOCATE_URL);
  const data = await response.json();
  const result = data.results?.[0];
  if (!result) {
    throw new Error("M-Lab locate service returned no NDT7 servers");
  }
  return {
    download: result.urls["wss:///ndt/v7/download"],
    upload: result.urls["wss:///ndt/v7/upload"],
  };
}

// Single connection, unlike the 4-stream Cloudflare approach — ndt7 measures true throughput via
// the kernel's own BBR bandwidth estimate (read from the server's periodic measurement messages
// below) rather than needing extra streams to outrun a per-connection cap.
function ndt7Download(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, NDT7_SUBPROTOCOL);
    const start = performance.now();
    let totalBytes = 0;
    let lastBbrMbps = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing/closed
      }
      const elapsedSeconds = (performance.now() - start) / 1000;
      resolve(
        lastBbrMbps > 0
          ? Math.round(lastBbrMbps * 10) / 10
          : Math.round(((totalBytes * 8) / elapsedSeconds / 1_000_000) * 10) / 10,
      );
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error("NDT7 download WebSocket error"));
      }
    };
    ws.onclose = finish;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.BBRInfo?.BW) {
            lastBbrMbps = (parsed.BBRInfo.BW * 8) / 1_000_000; // bytes/sec -> Mbps
          }
        } catch {
          // partial/unparseable text frame — skip it, the next one a moment later covers for it
        }
        totalBytes += event.data.length;
      } else {
        totalBytes += event.data.byteLength ?? event.data.size ?? 0;
      }

      if (performance.now() - start >= TEST_DURATION_MS) {
        finish();
      }
    };
  });
}

// No concurrency here, unlike the download side: BBR is measured by whichever side is sending, so
// for upload the server's own BBRInfo would just reflect its trivial ack traffic, not the
// client's real speed — client-side byte counting is what actually matters, same as Cloudflare.
function ndt7Upload(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, NDT7_SUBPROTOCOL);
    ws.binaryType = "arraybuffer";
    let start = 0;
    let totalBytes = 0;
    let messageSize = 8192;
    let sentAtCurrentSize = 0;
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // WebSocket.send() has no backpressure signal of its own — it queues data into
      // bufferedAmount and returns immediately, regardless of real uplink speed. Whatever's
      // still sitting in that buffer unsent at the end never actually left the machine, so it
      // has to be subtracted out here or the result overstates real throughput (confirmed live:
      // omitting this produced an impossible 1084.9 Mbps reading on a connection that maxes out
      // around 100 Mbps everywhere else). Same correction ndt7-js's own reference client makes.
      const numBytes = totalBytes - ws.bufferedAmount;
      try {
        ws.close();
      } catch {
        // already closing/closed
      }
      const elapsedSeconds = (performance.now() - start) / 1000;
      resolve(Math.round(((numBytes * 8) / elapsedSeconds / 1_000_000) * 10) / 10);
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("NDT7 upload WebSocket error"));
      }
    };
    ws.onclose = finish;
    // Server sends small ack/measurement frames back — nothing needs to read them for our
    // purposes, but onmessage still has to exist or the socket has no consumer for them.
    ws.onmessage = () => {};

    ws.onopen = () => {
      start = performance.now();
      const send = () => {
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        if (performance.now() - start >= TEST_DURATION_MS) {
          finish();
          return;
        }

        // Keep ~7 messages worth of buffer outstanding (same constant ndt7-js uses) — enough
        // that there's always more queued up so the socket never idles waiting for JS, but not
        // so much that bufferedAmount balloons into the illusion described in finish() above.
        const desiredBuffer = 7 * messageSize;
        if (ws.bufferedAmount < desiredBuffer) {
          const payload = randomPayload(messageSize);
          ws.send(payload);
          totalBytes += messageSize;
          sentAtCurrentSize++;
        }

        // Mirrors ndt7-js's own upload loop: grow the message size gradually (doubling every 16
        // sends) instead of jumping straight to a huge size — a fixed huge message would badly
        // undersample a slow connection, a fixed tiny one would never fill a fast one.
        if (messageSize < NDT7_MAX_MESSAGE_BYTES && sentAtCurrentSize >= 16) {
          messageSize = Math.min(messageSize * 2, NDT7_MAX_MESSAGE_BYTES);
          sentAtCurrentSize = 0;
        }

        timer = setTimeout(send, 0);
      };
      send();
    };
  });
}

async function measureNdt7Speed() {
  const urls = await getNdt7Urls();
  const down = await ndt7Download(urls.download);
  const up = await ndt7Upload(urls.upload);
  return { down, up };
}

async function runSpeedTest() {
  try {
    const down = await measureCloudflareSpeed(false);
    const up = await measureCloudflareSpeed(true);
    return { down, up };
  } catch {
    // Both directions fall back together: a rate limit or outage on Cloudflare's side almost
    // always affects both, so there's no point retrying the same broken provider for the second
    // leg.
    return await measureNdt7Speed();
  }
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
