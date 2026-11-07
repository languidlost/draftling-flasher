import { ESPLoader, Transport } from "https://cdn.jsdelivr.net/npm/esptool-js@0.6.1/bundle.js";
import SparkMD5 from "https://esm.sh/spark-md5@3.0.2";

const els = {
  unsupported: document.getElementById("unsupported"),
  boardSelect: document.getElementById("board-select"),
  boardDesc: document.getElementById("board-desc"),
  versionSelect: document.getElementById("version-select"),
  langField: document.getElementById("lang-field"),
  langSelect: document.getElementById("lang-select"),
  langDesc: document.getElementById("lang-desc"),
  connectBtn: document.getElementById("connect-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  chipInfo: document.getElementById("chip-info"),
  versionDesc: document.getElementById("version-desc"),
  stepFlash: document.getElementById("step-flash"),
  eraseAll: document.getElementById("erase-all"),
  flashBtn: document.getElementById("flash-btn"),
  progressList: document.getElementById("progress-list"),
  stepDone: document.getElementById("step-done"),
  monitorBtn: document.getElementById("monitor-btn"),
  restartBtn: document.getElementById("restart-btn"),
  log: document.getElementById("log"),
};

let manifest = null;
let selectedBoard = null;
let selectedRelease = null;
let selectedPack = null;   // { id, name, description, parts } -- the image to flash

// A release's own `parts` are its default-language image; optional
// `languagePacks` add images built with another language pack.
const DEFAULT_PACK_NAME = "Default (English, Ukrainian, German, French, Hebrew)";

function releasePacks(release) {
  const packs = [{
    id: "default",
    name: release.defaultPackName || DEFAULT_PACK_NAME,
    description: release.defaultPackDescription || "",
    parts: release.parts,
  }];
  (release.languagePacks || []).forEach((p) => packs.push(p));
  return packs;
}
let transport = null;
let esploader = null;
let monitorOpen = false;

function logLine(text, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

const IDF_LOG_LEVEL_REGEX = /^(I|W|E) \([\d.: -]+\)/;

function logIdfLine(text) {
  const match = IDF_LOG_LEVEL_REGEX.exec(text);
  const cls = match ? { I: "log-info", W: "log-warn", E: "log-error" }[match[1]] : undefined;
  logLine(text, cls);
}

const espLoaderTerminal = {
  clean() {
    els.log.textContent = "";
  },
  writeLine(data) {
    logLine(data);
  },
  write(data) {
    logLine(data);
  },
};

async function loadManifest() {
  const res = await fetch("manifest.json");
  manifest = await res.json();
  renderBoards();
}

function renderBoards() {
  els.boardSelect.innerHTML = "";
  manifest.boards.forEach((board) => {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    els.boardSelect.appendChild(option);
  });
  selectBoard(manifest.boards[0], true);
}

function selectBoard(board, silent) {
  selectedBoard = board;
  els.boardSelect.value = board.id;
  els.boardDesc.textContent = board.description;

  els.versionSelect.innerHTML = "";
  board.releases.forEach((release) => {
    const option = document.createElement("option");
    option.value = release.tag;
    option.textContent = release.label || release.tag;
    els.versionSelect.appendChild(option);
  });
  selectRelease(board.releases[0], true);

  if (!silent) logLine(`Board selected: ${board.name}`);
}

function selectRelease(release, silent) {
  // Keep the chosen language when switching versions, if it exists there.
  const prevPack = selectedPack ? selectedPack.id : "default";
  selectedRelease = release;
  els.versionSelect.value = release.tag;
  els.versionDesc.textContent = release.description || "";

  const packs = releasePacks(release);
  els.langSelect.innerHTML = "";
  packs.forEach((pack) => {
    const option = document.createElement("option");
    option.value = pack.id;
    option.textContent = pack.name;
    els.langSelect.appendChild(option);
  });
  els.langField.hidden = packs.length < 2;
  selectPack(packs.find((p) => p.id === prevPack) || packs[0], true);

  els.connectBtn.disabled = false;
  if (!silent) logLine(`Firmware version selected: ${release.label || release.tag}`);
}

function selectPack(pack, silent) {
  selectedPack = pack;
  els.langSelect.value = pack.id;
  els.langDesc.textContent = pack.description || "";
  if (!silent) logLine(`Language pack selected: ${pack.name}`);
}

function checkSupport() {
  if (!("serial" in navigator)) {
    els.unsupported.hidden = false;
    els.connectBtn.disabled = true;
    return false;
  }
  return true;
}

async function connect() {
  try {
    const port = await navigator.serial.requestPort();
    transport = new Transport(port, true);
    esploader = new ESPLoader({
      transport,
      baudrate: 460800,
      terminal: espLoaderTerminal,
    });
    const chipName = await esploader.main();
    els.chipInfo.hidden = false;
    els.chipInfo.textContent = `Connected: ${chipName}`;
    els.connectBtn.hidden = true;
    els.disconnectBtn.hidden = false;
    els.stepFlash.hidden = false;
  } catch (e) {
    logLine(`Error: ${e.message}`, "log-error");
    await disconnect();
  }
}

async function disconnect() {
  try {
    if (transport) await transport.disconnect();
  } catch {
    /* already gone */
  }
  transport = null;
  esploader = null;
  els.chipInfo.hidden = true;
  els.connectBtn.hidden = false;
  els.disconnectBtn.hidden = true;
  els.stepFlash.hidden = true;
  els.stepDone.hidden = true;
  els.progressList.innerHTML = "";
  els.eraseAll.checked = false;
  els.flashBtn.disabled = false;
}

function buildProgressRows() {
  els.progressList.innerHTML = "";
  return selectedPack.parts.map((part) => {
    const row = document.createElement("div");
    row.className = "progress-row";
    const name = part.path.split("/").pop();
    row.innerHTML = `
      <div class="progress-label"><span>${name} @ ${part.offset}</span><span class="pct">0%</span></div>
      <progress value="0" max="100"></progress>
    `;
    els.progressList.appendChild(row);
    return {
      bar: row.querySelector("progress"),
      pct: row.querySelector(".pct"),
    };
  });
}

async function fetchPart(part) {
  const res = await fetch(part.path);
  if (!res.ok) throw new Error(`Failed to download ${part.path}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return { data: new Uint8Array(buf), address: parseInt(part.offset, 16) };
}

function md5Hex(image) {
  const buf = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
  return SparkMD5.ArrayBuffer.hash(buf);
}

async function flash() {
  els.flashBtn.disabled = true;
  try {
    logLine(`Downloading ${selectedRelease.tag} firmware (${selectedPack.name}) for ${selectedBoard.name}...`);
    const fileArray = await Promise.all(selectedPack.parts.map(fetchPart));
    const rows = buildProgressRows();

    await esploader.writeFlash({
      fileArray,
      flashMode: selectedRelease.flashMode,
      flashFreq: selectedRelease.flashFreq,
      flashSize: selectedRelease.flashSize,
      eraseAll: els.eraseAll.checked,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const pct = Math.round((written / total) * 100);
        rows[fileIndex].bar.value = pct;
        rows[fileIndex].pct.textContent = `${pct}%`;
      },
      calculateMD5Hash: md5Hex,
    });
    await esploader.after();

    logLine("Flash complete.");
    els.stepFlash.hidden = true;
    els.stepDone.hidden = false;
  } catch (e) {
    logLine(`Error: ${e.message}`, "log-error");
  } finally {
    els.flashBtn.disabled = false;
  }
}

async function toggleMonitor() {
  if (!transport) return;
  if (monitorOpen) {
    monitorOpen = false;
    await transport.disconnect();
    els.monitorBtn.textContent = "Open serial monitor";
    return;
  }
  monitorOpen = true;
  els.monitorBtn.textContent = "Stop serial monitor";
  logLine(`--- Serial monitor @ ${manifest.consoleBaudrate} baud ---`);
  await transport.connect(manifest.consoleBaudrate);
  readConsoleLoop();
}

async function readConsoleLoop() {
  const decoder = new TextDecoder("utf-8");
  let lineBuffer = "";
  try {
    await transport.rawRead((value) => {
      lineBuffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, idx).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(idx + 1);
        logIdfLine(line);
      }
    }, () => !monitorOpen);
  } catch (e) {
    if (monitorOpen) logLine(`Monitor error: ${e.message}`, "log-error");
  }
  if (lineBuffer.length > 0) logIdfLine(lineBuffer);
}

els.boardSelect.addEventListener("change", () => {
  const board = manifest.boards.find((b) => b.id === els.boardSelect.value);
  selectBoard(board);
});
els.versionSelect.addEventListener("change", () => {
  const release = selectedBoard.releases.find((r) => r.tag === els.versionSelect.value);
  selectRelease(release);
});
els.langSelect.addEventListener("change", () => {
  const pack = releasePacks(selectedRelease).find((p) => p.id === els.langSelect.value);
  selectPack(pack);
});
els.connectBtn.addEventListener("click", connect);
els.disconnectBtn.addEventListener("click", disconnect);
els.flashBtn.addEventListener("click", flash);
els.monitorBtn.addEventListener("click", toggleMonitor);
els.restartBtn.addEventListener("click", () => window.location.reload());

checkSupport();
loadManifest();
