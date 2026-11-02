"use strict";

// Peer IDs on the public PeerJS server are global, so namespace ours.
const PREFIX = "transfer-";
const CODE_LENGTH = 4;

const CHUNK_SIZE = 64 * 1024;
// Stop sending while this much is queued in the data channel, so a large file
// isn't read into memory faster than the network can carry it.
const HIGH_WATER = 4 * 1024 * 1024;
// Received chunks are folded into a Blob every so often, which lets the
// browser page large files out of memory.
const FLUSH_SIZE = 32 * 1024 * 1024;
const CONNECT_TIMEOUT = 20_000;
const BAR_WIDTH = 20;

const $ = (id) => document.getElementById(id);

// Phones get tap wording instead of keyboard and drag-and-drop hints.
const touch = matchMedia("(hover: none)").matches;
const narrow = () => matchMedia("(max-width: 560px)").matches;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(id) {
  for (const section of document.querySelectorAll(".screen > section")) {
    section.hidden = section.id !== id;
  }
  $("back").hidden = id === "home";
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// Digits only, so it's quick to read out and type on a phone keypad.
function makeCode() {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

// Accepts a bare code or a full pasted link.
function parseCode(value) {
  return value.split("#").pop().replace(/\D/g, "");
}

const totalSize = (files) => files.reduce((sum, f) => sum + f.size, 0);

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Writes a status line, optionally with an inverted ERROR badge.
function setStatus(node, text, isError = false) {
  node.replaceChildren();
  if (isError) node.append(el("span", "badge", "ERROR"), " ");
  node.append(text);
}

// name ........ size
function fileRow(name, meta) {
  const row = el("li");
  row.append(el("span", "name", name), el("span", "dots"), el("span", "meta", meta));
  return row;
}

function renderFiles(list, files) {
  const rows = files.map((file) => fileRow(file.name, formatBytes(file.size)));
  list.replaceChildren(...rows);
  return rows;
}

// Returns an update(done, total) function that writes a text progress bar.
// On narrow screens the bar is shorter and the numbers go on a second line.
function meter(label) {
  const width = narrow() ? 12 : BAR_WIDTH;
  const gap = narrow() ? "\n" : "  ";
  const start = performance.now();
  let last = 0;
  return (done, total) => {
    const now = performance.now();
    if (now - last < 150 && done < total) return;
    last = now;
    const fraction = total ? done / total : 1;
    const filled = Math.round(fraction * width);
    const rate = done / Math.max((now - start) / 1000, 0.001);
    label.textContent =
      `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${String(Math.floor(fraction * 100)).padStart(3)}%` +
      `${gap}${formatBytes(done)} / ${formatBytes(total)} · ${formatBytes(rate)}/s`;
  };
}

function describeError(err) {
  if (err.type === "browser-incompatible") return "This browser doesn't support peer-to-peer connections.";
  return "Couldn't reach the connection server. Check your internet connection and reload.";
}

function goHome() {
  location.href = location.pathname;
}

// Choosing files

let staged = [];

function stage(fileList) {
  for (const file of fileList) {
    const duplicate = staged.some(
      (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
    );
    if (!duplicate) staged.push(file);
  }
  renderStage();
}

function renderStage() {
  show("stage");
  const empty = !staged.length;

  $("stage-summary").hidden = empty;
  $("stage-summary").textContent = `[ OK ] ${plural(staged.length, "file")}, ${formatBytes(totalSize(staged))}`;
  $("dropzone").classList.toggle("small", !empty);
  $("dropzone-label").textContent = touch
    ? (empty ? "Tap to choose files" : "Tap to add more files")
    : (empty ? "Drop files here, or click to choose" : "Drop more files here, or click to choose");
  $("add-files").textContent = empty ? "[1] Choose files" : "[1] Add more files";
  $("start-send").hidden = empty;
  if (empty) select($("add-files"));

  renderFiles($("stage-files"), staged).forEach((row, i) => {
    const remove = el("button", "remove", "[x]");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${staged[i].name}`);
    remove.onclick = () => {
      staged.splice(i, 1);
      renderStage();
    };
    row.append(remove);
  });
}

// Sending

function send(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  show("send");
  renderFiles($("send-files"), files);
  window.addEventListener("beforeunload", (e) => e.preventDefault());
  host(files);
}

function host(files) {
  const code = makeCode();
  const peer = new Peer(PREFIX + code);

  peer.on("open", () => {
    const link = `${location.origin}${location.pathname}#${code}`;
    $("send-code").textContent = code;
    $("send-link").href = link;
    $("send-link").textContent = link.replace(/^https?:\/\//, "");
    $("copy-link").onclick = () =>
      navigator.clipboard.writeText(link).then(() => {
        $("copy-link").textContent = "[1] Copied";
        setTimeout(() => ($("copy-link").textContent = "[1] Copy link"), 1500);
      });
    if (navigator.share) {
      $("share-link").hidden = false;
      $("share-link").onclick = () => navigator.share({ title: "transfer", text: `Code ${code}`, url: link }).catch(() => {});
    }
    $("send-menu").hidden = false;
    setStatus($("send-status"), "Keep this page open until they've received everything.");
  });

  peer.on("connection", (conn) => serve(conn, files));

  // Losing the signaling server doesn't break transfers in progress, but new
  // receivers can't find us until we're back.
  peer.on("disconnected", () => {
    setTimeout(() => peer.destroyed || peer.reconnect(), 2000);
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      peer.destroy();
      host(files);
    } else if (err.type !== "peer-unavailable") {
      setStatus($("send-status"), describeError(err), true);
    }
  });
}

let receiverCount = 0;

function serve(conn, files) {
  const row = fileRow(`Receiver ${++receiverCount}`, "Connecting...");
  row.classList.add("receiver");
  const status = row.querySelector(".meta");
  $("receivers").append(row);
  $("no-receivers").hidden = true;

  let finished = false;

  conn.on("open", () => {
    status.textContent = "Waiting for them to accept";
    const offer = files.map(({ name, size }) => ({ name, size }));
    conn.send(JSON.stringify({ type: "offer", files: offer }));
  });

  conn.on("data", (data) => {
    if (typeof data !== "string") return;
    const msg = JSON.parse(data);
    if (msg.type === "accept") {
      stream(conn, files, meter(status));
    } else if (msg.type === "done") {
      finished = true;
      status.textContent = "Done";
    }
  });

  conn.on("close", () => {
    if (!finished) status.textContent = "Disconnected";
  });
}

async function stream(conn, files, progress) {
  const channel = conn.dataChannel;
  const maxMessage = conn.peerConnection.sctp?.maxMessageSize || 16 * 1024;
  const chunkSize = Math.min(CHUNK_SIZE, maxMessage);
  channel.bufferedAmountLowThreshold = HIGH_WATER / 2;

  const total = totalSize(files);
  let sent = 0;
  progress(0, total);

  for (const file of files) {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      if (channel.bufferedAmount > HIGH_WATER) await drained(channel);
      if (channel.readyState !== "open") return;
      conn.send(chunk);
      sent += chunk.byteLength;
      progress(sent, total);
    }
  }
}

function drained(channel) {
  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener("bufferedamountlow", done);
      channel.removeEventListener("close", done);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", done);
    channel.addEventListener("close", done);
  });
}

// Receiving

function receive(code) {
  show("receive");
  $("recv-code").textContent = code;
  const status = $("recv-status");

  let conn;
  const peer = new Peer();

  // Covers both a signaling server that never answers and a direct
  // connection that never opens.
  const timer = setTimeout(() => {
    setStatus(
      status,
      "Couldn't connect. One of you may be on a network that blocks peer-to-peer connections, like some school, office or mobile networks.",
      true,
    );
  }, CONNECT_TIMEOUT);

  peer.on("open", () => {
    conn = peer.connect(PREFIX + code, { reliable: true, serialization: "raw" });
    conn.on("open", () => clearTimeout(timer));
    download(conn, status);
  });

  peer.on("error", (err) => {
    // Once connected directly, the signaling server no longer matters.
    if (conn?.open) return;
    clearTimeout(timer);
    setStatus(
      status,
      err.type === "peer-unavailable"
        ? `Nothing is being sent with code ${code}. Check the code, and make sure the sender still has the page open.`
        : describeError(err),
      true,
    );
  });
}

function isValidOffer(files) {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => typeof f.name === "string" && Number.isSafeInteger(f.size) && f.size >= 0)
  );
}

function download(conn, status) {
  let files = [];
  let rows = [];
  let total = 0;
  let progress = () => {};

  let index = 0;
  let fileBytes = 0;
  let received = 0;
  let blobs = [];
  let chunks = [];
  let chunkBytes = 0;
  let finished = false;

  conn.on("data", (data) => {
    if (typeof data === "string") {
      onMessage(JSON.parse(data));
      return;
    }
    if (finished || index >= files.length) return;
    chunks.push(data);
    chunkBytes += data.byteLength;
    fileBytes += data.byteLength;
    received += data.byteLength;
    if (chunkBytes >= FLUSH_SIZE) flush();
    progress(received, total);
    completeFiles();
  });

  conn.on("close", () => {
    if (!finished) setStatus(status, "The sender closed the connection.", true);
  });

  function onMessage(msg) {
    if (msg.type !== "offer" || files.length || !isValidOffer(msg.files)) return;
    files = msg.files;
    total = totalSize(files);
    rows = renderFiles($("recv-files"), files);
    setStatus(status, `[ OK ] Found ${plural(files.length, "file")}, ${formatBytes(total)}`);
    $("recv-menu").hidden = false;

    $("accept").onclick = () => {
      $("recv-menu").hidden = true;
      $("recv-bar").hidden = false;
      setStatus(status, "Receiving...");
      progress = meter($("recv-bar"));
      progress(0, total);
      conn.send(JSON.stringify({ type: "accept" }));
      completeFiles();
    };
  }

  function flush() {
    if (chunks.length) blobs.push(new Blob(chunks));
    chunks = [];
    chunkBytes = 0;
  }

  // Chunks never span files, so a file is complete once its size is reached.
  // Empty files complete immediately.
  function completeFiles() {
    while (index < files.length && fileBytes >= files[index].size) {
      flush();
      save(files[index], blobs, rows[index]);
      blobs = [];
      fileBytes = 0;
      index++;
    }
    if (index === files.length && !finished) {
      finished = true;
      progress(total, total);
      setStatus(status, `Received ${plural(files.length, "file")}, ${formatBytes(total)}.`);
      conn.send(JSON.stringify({ type: "done" }));
    }
  }
}

function save(file, parts, row) {
  // Always octet-stream: the name and contents come from a stranger, and a
  // same-origin blob URL must never render as a page.
  const blob = new Blob(parts, { type: "application/octet-stream" });
  const link = el("a", "", "Save");
  link.href = URL.createObjectURL(blob);
  link.download = file.name;
  row.append(link);
  link.click();
}

// Menus

function select(button) {
  for (const b of button.parentElement.children) b.classList.toggle("selected", b === button);
}

for (const menu of document.querySelectorAll(".menu")) {
  select(menu.firstElementChild);
  for (const button of menu.children) button.addEventListener("mouseenter", () => select(button));
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "Escape") {
    if ($("home").hidden) goHome();
    else $("code-form").hidden = true;
    return;
  }
  if (e.target.matches("input")) return;

  const menu = [...document.querySelectorAll(".menu")].find((m) => m.offsetParent !== null);
  if (!menu) return;
  const buttons = [...menu.children].filter((b) => !b.hidden);
  const current = buttons.findIndex((b) => b.classList.contains("selected"));

  if (/^[1-9]$/.test(e.key)) {
    const button = buttons.find((b) => b.dataset.key === e.key);
    if (!button) return;
    e.preventDefault();
    select(button);
    button.click();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    select(buttons[(current + step + buttons.length) % buttons.length]);
  } else if (e.key === "Enter" && !e.target.matches("button, a")) {
    e.preventDefault();
    buttons[current]?.click();
  }
});

// Wiring

$("opt-send").addEventListener("click", renderStage);
$("opt-receive").addEventListener("click", () => {
  $("code-form").hidden = false;
  $("code-input").focus();
});
$("add-files").addEventListener("click", () => $("picker").click());
$("dropzone").addEventListener("click", () => $("picker").click());
$("start-send").addEventListener("click", () => send(staged));
$("new-transfer").addEventListener("click", goHome);
$("back").addEventListener("click", goHome);
$("cancel").addEventListener("click", goHome);

$("picker").addEventListener("change", (e) => {
  stage(e.target.files);
  e.target.value = "";
});

// Files can be dropped or pasted in while choosing, but not once sending.
const choosing = () => !$("home").hidden || !$("stage").hidden;

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (choosing()) document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (choosing()) stage(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  if (choosing() && e.clipboardData.files.length) stage(e.clipboardData.files);
});

// The code is short, so go as soon as it's complete.
function submitCode() {
  const code = parseCode($("code-input").value);
  if (code.length === CODE_LENGTH) location.hash = code;
}
$("code-input").addEventListener("input", submitCode);
$("code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitCode();
});

// A new code in the URL means a fresh session.
window.addEventListener("hashchange", () => location.reload());

const initial = parseCode(location.hash);
if (initial.length === CODE_LENGTH) receive(initial);
