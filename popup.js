// Same anon key already embedded in tcp-hardware-check-exe's Supabase lane
// (SupabaseSubmitter.cs) — safe to ship client-side, RLS + the RPC function
// below are what actually gate access, not secrecy of this key.
const SUPABASE_URL = "https://xomtepfevlphmajhdgnu.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvbXRlcGZldmxwaG1hamhkZ251Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjc1NjAsImV4cCI6MjEwMzg0MzU2MH0.yC6SuKg_-Dk3mkrBbfbb_qQNSSgzQLpig4hxgSZUzlo";

let urlApiKey = null;
let internetSpeed = { down: null, up: null };
let storageDrives = [];

// JS port of tcp-hardware-check-exe/Services/SpeedTestService.cs's GetTargetUrlsAsync:
// scrape a token out of fast.com's own JS bundle, then ask its (undocumented) speedtest
// API for CDN target URLs. Same fragility as the EXE's version — no SLA, Netflix can
// change or remove this without notice, which would surface as a thrown error here.
async function getFastComTargetUrls() {
  const html = await (await fetch("https://fast.com/")).text();
  const scriptPath = html.match(/\/app-[^"]+\.js/)[0];
  const script = await (await fetch(`https://fast.com${scriptPath}`)).text();
  const token = script.match(/token:"([^"]+)"/)[1];
  const data = await (
    await fetch(`https://api.fast.com/netflix/speedtest/v2?https=true&token=${token}&urlCount=3`)
  ).json();
  return data.targets.map((target) => target.url);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadParamsFromCheckPage();
  await detectHardware();
});

// Kebab menu: "Rerun Hardware Test" re-detects everything (webcam/headset/storage/etc.
// plus a fresh internet-speed test) in case the user plugged something in after the
// popup first opened.
document.getElementById("menuBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  const dropdown = document.getElementById("menuDropdown");
  dropdown.hidden = !dropdown.hidden;
});

document.addEventListener("click", () => {
  document.getElementById("menuDropdown").hidden = true;
});

document.getElementById("rerunBtn").addEventListener("click", () => {
  document.getElementById("menuDropdown").hidden = true;
  detectHardware();
});

function loadParamsFromCheckPage() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "http://localhost:5173/check*" }, (tabs) => {
      if (!tabs.length) {
        resolve();
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: "sendParams" }, (response) => {
        const params = response && response.params;
        if (params) {
          if (params.applicantName) {
            document.getElementById("name").value = params.applicantName;
            document.getElementById("name").disabled = true;
          }
          if (params.applicantEmail) {
            document.getElementById("email").value = params.applicantEmail;
            document.getElementById("email").disabled = true;
          }
          if (params.apiKey) {
            urlApiKey = params.apiKey;
            document.getElementById("apiKey").disabled = true;
          }
        }
        resolve();
      });
    });
  });
}

async function detectHardware() {
  try {
    const cpuInfo = await chrome.system.cpu.getInfo();
    document.getElementById("cpuCores").value = cpuInfo.processors.length;
    document.getElementById("cpuModel").value = cpuInfo.modelName || "Unknown";

    const memoryInfo = await chrome.system.memory.getInfo();
    const ramGb = Math.round(memoryInfo.capacity / (1024 * 1024 * 1024));
    document.getElementById("ramGb").value = `${ramGb} GB`;

    const storageInfo = await chrome.system.storage.getInfo();
    const fixedDrives = storageInfo.filter((drive) => drive.type === "fixed");
    if (fixedDrives.length > 0) {
      const totalBytes = fixedDrives.reduce((sum, drive) => sum + drive.capacity, 0);
      document.getElementById("storageGb").value =
        `${Math.round(totalBytes / (1024 * 1024 * 1024))} GB`;

      // Chrome has no API for SSD-vs-HDD (WMI/native-only, out of a browser's reach),
      // so each drive is shown by its real capacity only, no type guess. `drive.name`
      // is dropped on purpose — on Windows it's a raw volume label full of unprintable
      // characters (renders as tofu boxes), not a usable drive letter or name.
      const drivesEl = document.getElementById("storageDrives");
      drivesEl.innerHTML = "";
      storageDrives = fixedDrives.map((drive) =>
        Math.round(drive.capacity / (1024 * 1024 * 1024)),
      );
      storageDrives.forEach((gb, index) => {
        const row = document.createElement("div");
        row.className = "storage-drive-row";
        row.textContent = `Drive ${index + 1}: ${gb} GB`;
        drivesEl.appendChild(row);
      });
    }

    const platformInfo = await chrome.runtime.getPlatformInfo();
    const osMap = { win: "Windows", mac: "macOS", linux: "Linux" };
    document.getElementById("osVersion").value = osMap[platformInfo.os] || platformInfo.os;

    document.getElementById("screenResolution").value =
      `${window.screen.width}x${window.screen.height}`;

    const devices = await navigator.mediaDevices.enumerateDevices();
    document.getElementById("webcam").value = devices.some((d) => d.kind === "videoinput")
      ? "Yes"
      : "No";
    document.getElementById("headset").value = devices.some(
      (d) => d.kind === "audioinput" && d.label,
    )
      ? "Yes"
      : "No";
  } catch (error) {
    showStatus(`Error detecting hardware: ${error.message}`, "error");
    return;
  }

  try {
    showStatus("Testing internet speed… do not close this window.", "loading");
    await measureInternetSpeed();
    document.getElementById("internetDown").value = `${internetSpeed.down} Mbps`;
    document.getElementById("internetUp").value = `${internetSpeed.up} Mbps`;
    showStatus("Ready — review your info below and click Submit.", "success");
  } catch (error) {
    // fast.com's API is undocumented and can change without notice (same known
    // fragility as SpeedTestService.cs) — a failure here shouldn't block the rest
    // of the form, it just leaves internetSpeed.down/up as null.
    document.getElementById("internetDown").value = "Unavailable";
    document.getElementById("internetUp").value = "Unavailable";
    showStatus(`Couldn't measure internet speed (${error.message}) — you can still submit.`, "error");
  }
}

// ~4s each direction against fast.com's real CDN target URLs, mirroring
// SpeedTestService.cs's MeasureAsync. Popup-specific risk beyond the EXE's own
// "no SLA" note: this ~8s test runs inside a toolbar popup, whose JS is destroyed
// the instant it loses focus or closes — unlike the EXE's persistent process.
async function measureInternetSpeed() {
  const urls = await getFastComTargetUrls();
  internetSpeed.down = await measureSpeed(urls, false, 4000);
  internetSpeed.up = await measureSpeed(urls, true, 4000);
}

async function measureSpeed(urls, isUpload, durationMs) {
  const start = performance.now();
  let totalBytes = 0;

  await Promise.all(
    urls.map(async (url) => {
      while (performance.now() - start < durationMs) {
        totalBytes += isUpload ? await uploadChunk(url) : await downloadChunk(url);
      }
    }),
  );

  const elapsedSeconds = (performance.now() - start) / 1000;
  return Math.round(((totalBytes * 8) / elapsedSeconds / 1_000_000) * 10) / 10;
}

async function downloadChunk(url) {
  const buffer = await (await fetch(url)).arrayBuffer();
  return buffer.byteLength;
}

async function uploadChunk(url) {
  const payload = new Uint8Array(1_000_000);
  for (let offset = 0; offset < payload.length; offset += 65536) {
    crypto.getRandomValues(payload.subarray(offset, Math.min(offset + 65536, payload.length)));
  }
  await fetch(url, { method: "POST", body: payload });
  return payload.length;
}

function showStatus(message, type) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.className = `status-message status-${type}`;
  document.getElementById("submitBtn").disabled = type === "loading";
}

// Submission feedback (validation, in-flight, success/failure) shows under the submit
// button instead of the header-area #status, which is reserved for hardware-detection
// and internet-speed progress the user sees before they ever reach the button.
function showSubmitStatus(message, type) {
  const statusEl = document.getElementById("submitStatus");
  statusEl.textContent = message;
  statusEl.className = `status-message status-${type}`;
  document.getElementById("submitBtn").disabled = type === "loading";
}

document.getElementById("hardwareForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("name").value;
  const email = document.getElementById("email").value;
  const apiKey = urlApiKey || document.getElementById("apiKey").value;

  if (!name || !email || !apiKey) {
    showSubmitStatus("Please fill in all required fields", "error");
    return;
  }

  showSubmitStatus("Submitting...", "loading");

  try {
    // Calls the same submit_hardware_check_direct RPC function
    // tcp-hardware-check-exe's Supabase lane already uses (SupabaseSubmitter.cs) —
    // never insert into submission_results directly, the anon key can't reach it
    // (RLS blocks it; only this SECURITY DEFINER function validates the api_key).
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_hardware_check_direct`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_api_key: apiKey,
        p_os_version: document.getElementById("osVersion").value,
        p_cpu_cores: parseInt(document.getElementById("cpuCores").value, 10) || 0,
        p_cpu_brand: document.getElementById("cpuModel").value,
        p_cpu_model: document.getElementById("cpuModel").value,
        p_ram_gb: parseInt(document.getElementById("ramGb").value, 10) || 0,
        p_storage_gb: parseInt(document.getElementById("storageGb").value, 10) || 0,
        p_storage_type: "Unknown (not detectable via browser)",
        p_storage_drives: storageDrives,
        p_screen_resolution: document.getElementById("screenResolution").value,
        p_internet_speed_down: internetSpeed.down,
        p_internet_speed_up: internetSpeed.up,
        p_webcam_present: document.getElementById("webcam").value === "Yes",
        p_headset_present: document.getElementById("headset").value === "Yes",
      }),
    });

    const body = await response.text();

    if (response.ok) {
      showSubmitStatus(`Your hardware check is complete. The HR team will contact you with next steps.`, "success");
    } else {
      showSubmitStatus(`Submission failed: ${body}`, "error");
    }
  } catch (error) {
    showSubmitStatus(`Error: ${error.message}`, "error");
  }
});
