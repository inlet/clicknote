#!/usr/bin/env node

// bridge/src/cli.ts
import { spawn as spawn2 } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// shared/types.ts
var PROTOCOL = 2;
var BRIDGE_HOST = "127.0.0.1";
var BRIDGE_PORT = 47823;
var BRIDGE_PORT_E2E = 47824;
var BRIDGE_PATH = "/bridge";

// shared/version.ts
var VERSION = "0.4.0";

// shared/label.ts
function agentLabel(agent) {
  const number = agent.number === null ? "" : String(agent.number);
  return [agent.folder, agent.about, agent.harness, number].filter((part) => part !== "").join(" \xB7 ");
}

// shared/url.ts
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
function filePath(url) {
  const parsed = parseUrl(url);
  if (parsed?.protocol !== "file:") return null;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return parsed.pathname;
  }
}
function isLinkable(url) {
  if (!/^(https?|file):\/\//i.test(url) || /[\s\p{Cc}]/u.test(url)) return false;
  const protocol = parseUrl(url)?.protocol;
  return protocol === "http:" || protocol === "https:" || protocol === "file:";
}

// bridge/src/inbox.ts
import {
  closeSync as closeSync2,
  fchmodSync as fchmodSync2,
  lstatSync as lstatSync4,
  openSync as openSync2,
  readdirSync as readdirSync3,
  renameSync as renameSync2,
  rmdirSync,
  statSync,
  watch
} from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

// bridge/src/paths.ts
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
var STATE_NAME = "clicknote";
function stateDirFor(platform, env, home) {
  if (env.CLICKNOTE_STATE_DIR) return env.CLICKNOTE_STATE_DIR;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && win32.isAbsolute(local) ? local : win32.join(home, "AppData", "Local");
    return win32.join(base, STATE_NAME);
  }
  return posix.join(home, ".local", "state", STATE_NAME);
}
function stateDir() {
  return stateDirFor(process.platform, process.env, homedir());
}

// bridge/src/registry.ts
import { randomBytes } from "node:crypto";
import { lstatSync as lstatSync3, readdirSync as readdirSync2 } from "node:fs";
import { join as join2 } from "node:path";

// bridge/src/presence.ts
import { lstatSync as lstatSync2, readdirSync, rmSync as rmSync2 } from "node:fs";
import { join } from "node:path";

// bridge/src/store.ts
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
var MAX_RECORD_BYTES = 65536;
var FOLDER_MODE = 448;
var FILE_MODE = 384;
function readRecord(path) {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (!stats?.isFile() || stats.size > MAX_RECORD_BYTES) return void 0;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function writeRecord(path, value) {
  makeFolders(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  try {
    rmSync(temp, { force: true });
    const fd = openSync(temp, "wx", FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
    }
    throw error;
  }
}
function removeRecord(path) {
  rmSync(path, { force: true });
}
function makeFolders(folder) {
  const missing = [];
  for (let at = resolve(folder); !lstatSync(at, { throwIfNoEntry: false }); at = dirname(at)) {
    missing.unshift(at);
    if (dirname(at) === at) break;
  }
  for (const at of missing) {
    try {
      mkdirSync(at, { mode: FOLDER_MODE });
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    chmodSync(at, FOLDER_MODE);
  }
}

// bridge/src/presence.ts
var BEAT_MS = 5e3;
var STALE_MS = 15e3;
var KINDS = ["wait", "bridge"];
var KEY = /^[0-9a-z]{1,40}$/;
var NAME = /^([a-z]+)\.([0-9a-z]{1,40})\.([1-9][0-9]*)$/;
function beaconsFolder() {
  return join(stateDir(), "beacons");
}
function startBeacon(kind, key, pid = process.pid) {
  if (!KINDS.includes(kind)) throw new TypeError(`Not a kind of beacon: ${JSON.stringify(kind)}`);
  if (typeof key !== "string" || !KEY.test(key)) throw new TypeError(`Not a beacon key: ${JSON.stringify(key)}`);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`Not a process id: ${pid}`);
  const folder = beaconsFolder();
  const path = join(folder, `${kind}.${key}.${pid}`);
  writeRecord(path, {});
  const timer = setInterval(() => {
    try {
      if (lstatSync2(folder, { throwIfNoEntry: false })?.isDirectory()) writeRecord(path, {});
    } catch {
    }
  }, BEAT_MS);
  timer.unref();
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        removeRecord(path);
      } catch {
      }
    }
  };
}
function present(kind, key, now = Date.now()) {
  const folder = beaconsFolder();
  return names(folder).some((name) => {
    const match = NAME.exec(name);
    return match?.[1] === kind && match[2] === key && fresh(join(folder, name), now);
  });
}
function pruneBeacons(now = Date.now()) {
  const folder = beaconsFolder();
  for (const name of names(folder)) {
    const path = join(folder, name);
    const stats = lstatSync2(path, { throwIfNoEntry: false });
    if (stats?.isFile() && now - stats.mtimeMs > STALE_MS) rmSync2(path, { force: true });
  }
}
function fresh(path, now) {
  try {
    const stats = lstatSync2(path, { throwIfNoEntry: false });
    return stats?.isFile() === true && now - stats.mtimeMs <= STALE_MS;
  } catch {
    return false;
  }
}
function names(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

// bridge/src/registry.ts
var AGENT_ID = /^[0-9a-f]{12}$/;
var AGENT_TTL_MS = 36e5;
var AGENT_KEEP_MS = 7 * 24 * 36e5;
var PART_MAX = 60;
var RECORD_NAME = /^([0-9a-f]{12})\.json$/;
var CONTROL = /[\p{Cc}\p{Cf}]/gu;
var SPACE = /\p{White_Space}+/gu;
function agentsFolder() {
  return join2(stateDir(), "agents");
}
function agentPath(id) {
  return join2(agentsFolder(), `${id}.json`);
}
function cleanPart(text) {
  const line = text.replace(SPACE, " ").replace(CONTROL, "").replace(SPACE, " ").trim();
  return Array.from(line).slice(0, PART_MAX).join("").trimEnd();
}
function registerAgent(input, now = Date.now()) {
  let id;
  do
    id = randomBytes(6).toString("hex");
  while (lstatSync3(agentPath(id), { throwIfNoEntry: false }));
  const agent = {
    id,
    harness: cleanPart(input.harness),
    about: cleanPart(input.about),
    folder: cleanPart(lastPart(input.folder)),
    registered: now,
    seen: now
  };
  writeRecord(agentPath(id), agent);
  return agent;
}
function seenAgent(id, about, now = Date.now()) {
  const agent = readAgent(id);
  if (!agent) return null;
  agent.seen = now;
  delete agent.left;
  if (about !== void 0) agent.about = cleanPart(about);
  writeRecord(agentPath(id), agent);
  return agent;
}
function leaveAgent(id) {
  const agent = readAgent(id);
  if (agent) writeRecord(agentPath(id), { ...agent, left: true });
}
function readAgent(id) {
  if (!AGENT_ID.test(id)) return null;
  const value = readRecord(agentPath(id));
  if (typeof value !== "object" || value === null) return null;
  const { harness, about, folder, registered, seen, left } = value;
  if (value.id !== id || typeof harness !== "string" || typeof about !== "string" || typeof folder !== "string" || typeof registered !== "number" || !Number.isFinite(registered) || typeof seen !== "number" || !Number.isFinite(seen) || left !== void 0 && left !== true) return null;
  const agent = { id, harness, about, folder, registered, seen };
  if (left) agent.left = true;
  return agent;
}
function listAgents(now = Date.now()) {
  const listed = agentIds().map(readAgent).filter((agent) => agent !== null).map((agent) => ({ agent, waiting: present("wait", agent.id, now) })).filter(({ agent, waiting }) => waiting || !agent.left && now - agent.seen <= AGENT_TTL_MS).sort((a, b) => a.agent.registered - b.agent.registered || compare(a.agent.id, b.agent.id));
  const counts = /* @__PURE__ */ new Map();
  return listed.map(({ agent: { id, folder, about, harness }, waiting }) => {
    const label = agentLabel({ folder, about, harness, number: null });
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    return { id, folder, about, harness, number: count > 1 ? count : null, waiting };
  });
}
function pruneAgents(now = Date.now()) {
  for (const id of agentIds()) {
    const agent = readAgent(id);
    if (agent && now - agent.seen > AGENT_KEEP_MS) removeRecord(agentPath(id));
  }
}
function agentIds() {
  let names3;
  try {
    names3 = readdirSync2(agentsFolder());
  } catch {
    return [];
  }
  return names3.flatMap((name) => RECORD_NAME.exec(name)?.[1] ?? []);
}
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function lastPart(path) {
  return path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? "";
}

// bridge/src/inbox.ts
var CLAIM_MS = 6e4;
var INBOX_KEEP_MS = 7 * 24 * 36e5;
var LEFTOVER_MS = 24 * 36e5;
var SEND_ID = /^[0-9a-f]{16}$/;
var QUEUED = /^([0-9a-f]{16})\.json$/;
var CLAIMED = /^([0-9a-f]{16})\.claimed\.([1-9][0-9]*)\.(-?[0-9]+)$/;
var PICKED = /^([0-9a-f]{16})\.picked\.(-?[0-9]+)$/;
var TEMPORARY = /^[0-9a-f]{16}\.json\.[0-9]+\.tmp$/;
var TRIES = 5;
var LOCK = "claim.lock";
var LOCK_WAIT_MS = 1e3;
var LOCK_TRY_MS = 20;
var LOCK_STALE_MS = 5e3;
var LOCK_MODE = 384;
var PAUSE = new Int32Array(new SharedArrayBuffer(4));
function inboxFolder() {
  return join3(stateDir(), "inbox");
}
function agentFolder(agent) {
  return join3(inboxFolder(), agent);
}
function enqueue(agent, item, now = Date.now()) {
  if (typeof agent !== "string" || !AGENT_ID.test(agent)) throw new TypeError(`Not an agent id: ${JSON.stringify(agent)}`);
  const { send: send2, folder, line } = item;
  if (typeof send2 !== "string" || !SEND_ID.test(send2)) throw new TypeError(`Not a send id: ${JSON.stringify(send2)}`);
  if (typeof folder !== "string" || typeof line !== "string") throw new TypeError("A send needs a folder and a line.");
  if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError(`Not a time: ${now}`);
  if (sendState(send2) !== "unknown") return;
  const queued = { send: send2, folder, line, at: now };
  writeRecord(join3(agentFolder(agent), `${send2}.json`), queued);
}
function makeInbox(agent) {
  if (typeof agent !== "string" || !AGENT_ID.test(agent)) throw new TypeError(`Not an agent id: ${JSON.stringify(agent)}`);
  makeFolders(agentFolder(agent));
}
function claim(agent, pid = process.pid, now = Date.now()) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`Not a process id: ${pid}`);
  const stamp = timeStamp(now);
  if (typeof agent !== "string" || !AGENT_ID.test(agent)) return [];
  const lock = takeLock(agentFolder(agent));
  if (lock === null) return [];
  try {
    const claimed = [];
    for (const { entry, queued } of offered(agent, now)) {
      try {
        renameSync2(entry.path, join3(dirname2(entry.path), `${entry.send}.claimed.${pid}.${stamp}`));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        try {
          release(agent, claimed.map((queued2) => queued2.send));
        } catch {
        }
        throw error;
      }
      claimed.push(queued);
    }
    return claimed;
  } finally {
    try {
      removeRecord(lock);
    } catch {
    }
  }
}
function takeLock(folder) {
  const lock = join3(folder, LOCK);
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (; ; ) {
    let fd;
    try {
      fd = openSync2(lock, "wx", LOCK_MODE);
    } catch (error) {
      const code2 = error.code;
      if (code2 === "ENOENT" || code2 === "ENOTDIR") return null;
      const removing = beingRemoved(error);
      if (code2 !== "EEXIST" && !removing) throw error;
      if (performance.now() >= deadline) {
        if (removing) throw error;
        return null;
      }
      const state2 = removing ? "held" : lockState(lock);
      if (state2 === "gone") continue;
      if (state2 === "stale") {
        removeRecord(lock);
        continue;
      }
      Atomics.wait(PAUSE, 0, 0, LOCK_TRY_MS);
      continue;
    }
    try {
      try {
        fchmodSync2(fd, LOCK_MODE);
      } finally {
        closeSync2(fd);
      }
    } catch (error) {
      try {
        removeRecord(lock);
      } catch {
      }
      throw error;
    }
    return lock;
  }
}
function lockState(lock) {
  let made;
  try {
    made = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
  } catch (error) {
    if (beingRemoved(error)) return "held";
    throw error;
  }
  if (made === void 0) return "gone";
  return Math.abs(Date.now() - made) > LOCK_STALE_MS ? "stale" : "held";
}
function beingRemoved(error) {
  const code2 = error.code;
  return process.platform === "win32" && (code2 === "EPERM" || code2 === "EACCES");
}
function confirm(agent, sends, now = Date.now()) {
  const stamp = timeStamp(now);
  for (const send2 of sends) move(agent, send2, ["queued", "claimed"], `${send2}.picked.${stamp}`);
}
function release(agent, sends) {
  for (const send2 of sends) move(agent, send2, ["claimed"], `${send2}.json`);
}
function sendState(send2) {
  if (typeof send2 !== "string" || !SEND_ID.test(send2)) return "unknown";
  for (const agent of agentIds2()) {
    const found = find(agent, send2);
    if (found) return found.entry.hold.state === "picked" ? "picked_up" : "queued";
  }
  return "unknown";
}
function inboxState(agent, send2) {
  if (typeof send2 !== "string" || !SEND_ID.test(send2)) return null;
  const found = find(agent, send2);
  if (!found) return null;
  return { state: found.entry.hold.state === "picked" ? "picked_up" : "queued", line: found.queued.line };
}
function waitForSend(agent, signal, pollMs = 1e3) {
  return new Promise((resolve4) => {
    if (signal.aborted) return resolve4(false);
    if (claimable(agent)) return resolve4(true);
    const folder = typeof agent === "string" && AGENT_ID.test(agent) ? agentFolder(agent) : null;
    let watcher = null;
    let ended = false;
    const end = (got) => {
      ended = true;
      clearInterval(timer);
      signal.removeEventListener("abort", stop);
      unwatch();
      resolve4(got);
    };
    const look = () => {
      if (!ended && claimable(agent)) end(true);
    };
    const unwatch = () => {
      watcher?.close();
      watcher = null;
    };
    const startWatch = () => {
      if (watcher || folder === null) return;
      try {
        const started = watch(folder, look);
        started.on("error", () => {
          started.close();
          if (watcher === started) watcher = null;
        });
        watcher = started;
      } catch {
      }
    };
    const stop = () => end(false);
    const timer = setInterval(() => {
      startWatch();
      look();
    }, pollMs);
    signal.addEventListener("abort", stop, { once: true });
    startWatch();
    look();
  });
}
function pruneInbox(now = Date.now()) {
  for (const agent of agentIds2()) {
    for (const entry of entries(agent)) {
      const queued = readQueued(entry);
      if (queued && now - queued.at > INBOX_KEEP_MS) removeRecord(entry.path);
    }
    const folder = agentFolder(agent);
    for (const name of names2(folder)) {
      if (name !== LOCK && !TEMPORARY.test(name)) continue;
      const path = join3(folder, name);
      const stats = lstatSync4(path, { throwIfNoEntry: false });
      if (stats?.isFile() && now - stats.mtimeMs > LEFTOVER_MS) removeRecord(path);
    }
    if (readAgent(agent) === null) removeIfEmpty(folder);
  }
}
function removeIfEmpty(folder) {
  try {
    rmdirSync(folder);
  } catch {
  }
}
function claimable(agent) {
  return offered(agent, Date.now()).length > 0;
}
function offered(agent, now) {
  return entries(agent).filter((entry) => entry.hold.state === "queued" || entry.hold.state === "claimed" && !live(entry.hold, now)).flatMap((entry) => {
    const queued = readQueued(entry);
    return queued ? [{ entry, queued }] : [];
  }).sort((a, b) => a.queued.at - b.queued.at || compare2(a.entry.send, b.entry.send));
}
function live(hold, now) {
  if (now - hold.since > CLAIM_MS) return false;
  try {
    process.kill(hold.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function move(agent, send2, from, to) {
  if (typeof send2 !== "string" || !SEND_ID.test(send2)) return;
  for (let tries = 0; tries < TRIES; tries++) {
    const found = find(agent, send2);
    if (!found || !from.includes(found.entry.hold.state)) return;
    try {
      renameSync2(found.entry.path, join3(dirname2(found.entry.path), to));
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function find(agent, send2) {
  for (let tries = 0; tries < TRIES; tries++) {
    const entry = entries(agent).find((entry2) => entry2.send === send2);
    if (!entry) return null;
    const queued = readQueued(entry);
    if (queued) return { entry, queued };
  }
  return null;
}
function readQueued(entry) {
  const value = readRecord(entry.path);
  if (typeof value !== "object" || value === null) return null;
  const { send: send2, folder, line, at } = value;
  if (send2 !== entry.send || typeof folder !== "string" || typeof line !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  return { send: entry.send, folder, line, at };
}
function entries(agent) {
  if (typeof agent !== "string" || !AGENT_ID.test(agent)) return [];
  const folder = agentFolder(agent);
  return names2(folder).flatMap((name) => {
    const entry = parse(folder, name);
    return entry ? [entry] : [];
  });
}
function parse(folder, name) {
  const path = join3(folder, name);
  const queued = QUEUED.exec(name);
  if (queued) return { send: queued[1], path, hold: { state: "queued" } };
  const claimed = CLAIMED.exec(name);
  if (claimed) {
    const pid = Number(claimed[2]);
    const since = Number(claimed[3]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(since)) return null;
    return { send: claimed[1], path, hold: { state: "claimed", pid, since } };
  }
  const picked = PICKED.exec(name);
  if (picked) {
    const since = Number(picked[2]);
    if (!Number.isSafeInteger(since)) return null;
    return { send: picked[1], path, hold: { state: "picked", since } };
  }
  return null;
}
function agentIds2() {
  return names2(inboxFolder()).filter((name) => AGENT_ID.test(name));
}
function names2(folder) {
  try {
    return readdirSync3(folder);
  } catch {
    return [];
  }
}
function timeStamp(now) {
  const stamp = Math.floor(now);
  if (!Number.isSafeInteger(stamp)) throw new TypeError(`Not a time: ${now}`);
  return stamp;
}
function compare2(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// bridge/src/links.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { lstatSync as lstatSync5, mkdirSync as mkdirSync2, readdirSync as readdirSync4, readFileSync as readFileSync2, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
var LINK_FORMAT = 1;
var LINK_TTL_MS = 36e5;
var LINK_CODE = /^[0-9a-f]{32}$/;
function writeLink(link, now = Date.now()) {
  const code2 = randomBytes2(16).toString("hex");
  mkdirSync2(linksDir(), { recursive: true, mode: 448 });
  writeLinkFile(code2, { url: link.url, agent: link.agent, label: link.label, at: now, bound: false });
  return code2;
}
function readLink(code2, now = Date.now()) {
  const link = readLinkFile(code2);
  return link && now - link.at <= LINK_TTL_MS ? link : null;
}
function markBound(code2) {
  const link = readLinkFile(code2);
  if (link) writeLinkFile(code2, { ...link, bound: true });
}
function pruneLinks(now = Date.now()) {
  let entries2;
  try {
    entries2 = readdirSync4(linksDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries2) {
    if (entry.isDirectory()) continue;
    const code2 = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : "";
    if (readLink(code2, now) === null) rmSync3(join4(linksDir(), entry.name), { force: true });
  }
}
function linksDir() {
  return join4(stateDir(), "links");
}
function linkPath(code2) {
  return join4(linksDir(), `${code2}.json`);
}
function readLinkFile(code2) {
  if (!LINK_CODE.test(code2)) return null;
  const path = linkPath(code2);
  try {
    if (!lstatSync5(path, { throwIfNoEntry: false })?.isFile()) return null;
    return asLink(JSON.parse(readFileSync2(path, "utf8")));
  } catch {
    return null;
  }
}
function asLink(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { format, url, agent, label, at, bound } = raw;
  if (format !== LINK_FORMAT || typeof url !== "string" || typeof agent !== "string" || typeof label !== "string" || typeof at !== "number" || typeof bound !== "boolean" || !isLinkable(url)) return null;
  return { url, agent, label, at, bound };
}
function writeLinkFile(code2, link) {
  const path = linkPath(code2);
  const temp = join4(stateDir(), `link-${process.pid}.tmp`);
  try {
    writeFileSync2(temp, `${JSON.stringify({ format: LINK_FORMAT, ...link }, null, 2)}
`, { mode: 384 });
    renameSync3(temp, path);
  } catch (error) {
    try {
      rmSync3(temp, { force: true });
    } catch {
    }
    throw error;
  }
}

// bridge/src/record.ts
import { join as join5 } from "node:path";
var STATE_FORMAT = 1;
var BRIDGE_KEY = "bridge";
var PROBLEMS = ["port_in_use"];
function recordPath() {
  return join5(stateDir(), "bridge.json");
}
function problemPath() {
  return join5(stateDir(), "problem.json");
}
function stopPath() {
  return join5(stateDir(), "stop.json");
}
function writeBridgeRecord(record) {
  writeRecord(recordPath(), record);
  removeRecord(problemPath());
}
function clearOwnRecord(pid) {
  if (readBridgeRecord()?.pid === pid) removeRecord(recordPath());
}
function noteProblem(problem) {
  writeRecord(problemPath(), { problem });
}
function clearProblem() {
  removeRecord(problemPath());
}
function seeBridge(now = Date.now()) {
  const record = readBridgeRecord();
  if (record && present("bridge", BRIDGE_KEY, now)) {
    const state2 = record.version === VERSION && record.format === STATE_FORMAT ? "running" : "other";
    return { state: state2, record };
  }
  return { state: "down", problem: readProblem() };
}
function requestStop() {
  writeRecord(stopPath(), {});
}
function stopRequested() {
  return readRecord(stopPath()) !== void 0;
}
function clearStop() {
  removeRecord(stopPath());
}
function readBridgeRecord() {
  const value = readRecord(recordPath());
  if (typeof value !== "object" || value === null) return null;
  const { pid, version, format, port, auto } = value;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof version !== "string" || typeof format !== "number" || !Number.isSafeInteger(format) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || typeof auto !== "boolean") return null;
  return { pid, version, format, port, auto };
}
function readProblem() {
  const value = readRecord(problemPath());
  if (typeof value !== "object" || value === null) return null;
  const { problem } = value;
  return PROBLEMS.includes(problem) ? problem : null;
}

// bridge/src/waiting.ts
var BEAT_MS2 = 24e4;
var CLAIM_AGAIN_MS = 20;
async function nextSends(agent, deps) {
  try {
    makeInbox(agent);
  } catch {
  }
  const beacon = startBeacon("wait", agent);
  let ensuring = false;
  const timer = setInterval(() => {
    renew(agent);
    deps.onBeat();
    if (ensuring || seeBridge().state !== "down") return;
    ensuring = true;
    void deps.ensure().catch(() => void 0).finally(() => {
      ensuring = false;
    });
  }, deps.beatMs ?? BEAT_MS2);
  let stopped = false;
  try {
    while (await waitForSend(agent, deps.signal, deps.pollMs)) {
      const sends = claim(agent);
      if (sends.length > 0) return sends;
      await pause(CLAIM_AGAIN_MS, deps.signal);
    }
    stopped = true;
    return [];
  } finally {
    clearInterval(timer);
    if (stopped) leave(agent);
    else renew(agent);
    beacon.stop();
  }
}
function renew(id) {
  try {
    seenAgent(id);
  } catch {
  }
}
function leave(id) {
  try {
    leaveAgent(id);
  } catch {
  }
}
function pause(ms, signal) {
  return new Promise((resolve4) => {
    if (signal.aborted) return resolve4();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve4();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// bridge/src/commands.ts
var NOT_RUNNING_REASONS = {
  other: "the running Clicknote is another version than this command. Run stop, then run this again.",
  port_in_use: "port 47823 is held by another program, so Clicknote cannot start.",
  down: "Clicknote did not start."
};
var STOP_WAIT_MS = 5e3;
var STOP_LOOK_MS = 100;
var LINKABLE_HINT = "give the full URL, starting with http://, https:// or file://, with a space written as %20.";
async function runRegister(input, deps) {
  const seen = await deps.ensure();
  if (seen.state !== "running") {
    deps.note(`Clicknote is not running: ${notRunningReason(seen)}`);
    if (seen.state === "other") return 1;
  }
  const agent = registerAgent({ harness: input.harness, about: input.about, folder: deps.cwd });
  printAgent(agent, deps);
  return 0;
}
async function runOpen(input, deps) {
  if (!linkable(input.url, deps)) return 1;
  let code2;
  try {
    const seen = await deps.ensure();
    if (seen.state === "other") return notLinked(input.url, notRunningReason(seen), deps);
    const agent = input.agent === void 0 ? registerAgent({ harness: input.harness ?? "", about: input.about ?? "", folder: deps.cwd }) : seenAgent(input.agent, input.about);
    if (!agent) return unknownAgent(input.agent ?? "", deps);
    const label = printAgent(agent, deps);
    if (seen.state === "down") return notLinked(input.url, notRunningReason(seen), deps);
    code2 = writeLink({ url: input.url, agent: agent.id, label });
  } catch (error) {
    if (input.agent !== void 0 && readAgent(input.agent) === null) return unknownAgent(input.agent, deps);
    return notLinked(input.url, errorMessage(error), deps);
  }
  const address = `http://${BRIDGE_HOST}:${deps.port}/open/${code2}`;
  if (input.addressOnly) {
    deps.out(`open this address: ${address}`);
    return 0;
  }
  if (deps.open(address)) {
    deps.out(`opened: ${input.url}`);
    return 0;
  }
  deps.out(`open this address: ${address}`);
  deps.note("Clicknote could not start the browser.");
  return 0;
}
async function runWait(input, deps) {
  const seen = await deps.ensure();
  if (seen.state === "other") {
    deps.note(`Clicknote is not running: ${notRunningReason(seen)}`);
    return 1;
  }
  const agent = seenAgent(input.agent, input.about);
  if (!agent) return unknownAgent(input.agent, deps);
  if (seen.state === "down") deps.note(`Clicknote is not running: ${notRunningReason(seen)}`);
  const sends = await nextSends(agent.id, {
    ensure: deps.ensure,
    signal: deps.signal,
    pollMs: deps.pollMs,
    beatMs: deps.noteMs,
    onBeat: () => deps.note("Still waiting for annotations.")
  });
  if (sends.length === 0) {
    deps.note("Stopped waiting. You are off the list in the bar until you wait again.");
    return 1;
  }
  const ids = sends.map((queued) => queued.send);
  try {
    for (const queued of sends) await deps.write(queued.line);
    confirm(agent.id, ids);
  } catch (error) {
    try {
      release(agent.id, ids);
    } catch {
    }
    throw error;
  }
  return 0;
}
async function runStop(deps) {
  if (seeBridge().state === "down") {
    deps.note("Clicknote was not running.");
    return 0;
  }
  requestStop();
  const until = deps.now() + STOP_WAIT_MS;
  while (deps.now() < until) {
    await deps.sleep(STOP_LOOK_MS);
    if (seeBridge().state === "down") {
      deps.note("Clicknote stopped.");
      return 0;
    }
  }
  deps.note("Clicknote did not stop within 5 seconds.");
  return 1;
}
function notRunningReason(seen) {
  if (seen.state === "other") return NOT_RUNNING_REASONS.other;
  return seen.problem === "port_in_use" ? NOT_RUNNING_REASONS.port_in_use : NOT_RUNNING_REASONS.down;
}
function printAgent(agent, deps) {
  const label = labelOf(agent);
  deps.out(`agent: ${agent.id}`);
  deps.out(`listed as: ${label}`);
  return label;
}
function labelOf(agent) {
  const listed = listAgents().find((entry) => entry.id === agent.id);
  return agentLabel(listed ?? { folder: agent.folder, about: agent.about, harness: agent.harness, number: null });
}
function runOpenUnlinked(url, reason, deps) {
  if (!linkable(url, deps)) return 1;
  return notLinked(url, reason, deps);
}
function linkable(url, deps) {
  if (isLinkable(url)) return true;
  deps.note(`Cannot open ${JSON.stringify(url)}: ${LINKABLE_HINT}`);
  return false;
}
function notLinked(url, reason, deps) {
  deps.out(`open this address: ${url}`);
  deps.note(`Not linked: ${reason}`);
  return 0;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function unknownAgent(id, deps) {
  deps.note(`Unknown agent ${id}. Register again.`);
  return 1;
}

// bridge/src/guard.ts
import { chmodSync as chmodSync2, lstatSync as lstatSync6, mkdirSync as mkdirSync3, readdirSync as readdirSync5, statSync as statSync2 } from "node:fs";
import { isAbsolute, join as join6 } from "node:path";
var FOLDER_MODE2 = 448;
var FILE_MODE2 = 384;
var StateFolderError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StateFolderError";
  }
};
function secureStateDir(uid = process.getuid?.() ?? null) {
  process.umask(63);
  const dir = stateDir();
  if (!isAbsolute(dir)) {
    throw new StateFolderError(`The state folder ${dir} is not a full path. Clicknote does not use it.`);
  }
  if (!lstatSync6(dir, { throwIfNoEntry: false })) mkdirSync3(dir, { recursive: true, mode: FOLDER_MODE2 });
  if (process.platform === "win32") {
    if (!statSync2(dir, { throwIfNoEntry: false })?.isDirectory()) throw notAFolder(dir);
    return dir;
  }
  const stats = lstatSync6(dir);
  if (stats.isSymbolicLink()) throw new StateFolderError(`The state folder ${dir} is a link. Clicknote does not use it.`);
  if (!stats.isDirectory()) throw notAFolder(dir);
  if (uid !== null && stats.uid !== uid) {
    throw new StateFolderError(`The state folder ${dir} belongs to another user. Clicknote does not use it.`);
  }
  setMode(dir, stats);
  closeInside(dir);
  return dir;
}
function notAFolder(dir) {
  return new StateFolderError(`The state folder ${dir} is not a folder. Clicknote does not use it.`);
}
function setMode(path, stats) {
  const mode = stats.isDirectory() ? FOLDER_MODE2 : FILE_MODE2;
  if ((stats.mode & 511) !== mode) chmodSync2(path, mode);
}
function closeInside(folder) {
  for (const name of readdirSync5(folder)) {
    const entry = join6(folder, name);
    try {
      const stats = lstatSync6(entry);
      if (stats.isSymbolicLink()) continue;
      setMode(entry, stats);
      if (stats.isDirectory()) closeInside(entry);
    } catch {
      continue;
    }
  }
}

// bridge/src/life.ts
import { resolve as resolve2 } from "node:path";
var IDLE_MS = 6e5;
var TICK_MS = 1e3;
var START_WAIT_MS = 5e3;
var START_LOOK_MS = 100;
function createIdle(now, idleMs = IDLE_MS) {
  let active = -Infinity;
  let emptySince = null;
  return {
    activity() {
      active = now();
    },
    due(agents2) {
      if (agents2 > 0) {
        emptySince = null;
        return false;
      }
      const at = now();
      emptySince ??= at;
      return at - Math.max(active, emptySince) >= idleMs;
    }
  };
}
async function ensureBridge(deps) {
  const seen = seeBridge();
  if (seen.state !== "down") return seen;
  clearProblem();
  const dir = resolve2(stateDir());
  const env = { ...deps.env, CLICKNOTE_STATE_DIR: dir };
  deps.spawn(deps.execPath, [deps.self, "--auto"], { detached: true, stdio: "ignore", windowsHide: true, cwd: dir, env }).unref();
  const until = deps.now() + START_WAIT_MS;
  for (; ; ) {
    await deps.sleep(START_LOOK_MS);
    const look = seeBridge();
    if (look.state !== "down" || deps.now() >= until) return look;
  }
}
function keepBridge(deps) {
  clearStop();
  const record = {
    pid: deps.pid,
    version: VERSION,
    format: STATE_FORMAT,
    port: deps.bridge.port,
    auto: deps.auto
  };
  writeBridgeRecord(record);
  const beacon = startBeacon("bridge", BRIDGE_KEY, deps.pid);
  let ending;
  const end = (code2) => {
    ending ??= (async () => {
      ticking.stop();
      quietly(clearStop);
      const closed = startClose(deps.bridge);
      beacon.stop();
      quietly(() => clearOwnRecord(deps.pid));
      await closed;
      deps.exit(code2);
    })();
    return ending;
  };
  const ticking = deps.every(TICK_MS, () => {
    if (stopRequested() || deps.auto && deps.idle.due(listAgents().length)) {
      void end(0);
      return;
    }
    if (readBridgeRecord()?.pid !== deps.pid) quietly(() => writeBridgeRecord(record));
  });
  return { end };
}
function startClose(bridge) {
  try {
    return bridge.close().catch(() => void 0);
  } catch {
    return Promise.resolve();
  }
}
function quietly(change) {
  try {
    change();
  } catch {
  }
}

// bridge/src/log.ts
import { closeSync as closeSync3, fchmodSync as fchmodSync3, fstatSync, openSync as openSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3, writeSync } from "node:fs";
import { join as join7 } from "node:path";
var LOG_MAX_BYTES = 262144;
var FILE_MODE3 = 384;
var NEWLINE = 10;
function fileLog() {
  const path = join7(stateDir(), "bridge.log");
  return (line) => {
    try {
      if (append(path, `${line}
`) > LOG_MAX_BYTES) keepLastHalf(path);
    } catch {
    }
  };
}
function append(path, text) {
  const fd = openSync3(path, "a", FILE_MODE3);
  try {
    fchmodSync3(fd, FILE_MODE3);
    writeSync(fd, text);
    return fstatSync(fd).size;
  } finally {
    closeSync3(fd);
  }
}
function keepLastHalf(path) {
  const bytes = readFileSync3(path);
  const start = bytes.length - LOG_MAX_BYTES / 2;
  if (start <= 0) return;
  const end = bytes.indexOf(NEWLINE, start - 1);
  writeFileSync3(path, bytes.subarray(end === -1 ? bytes.length : end + 1));
}

// bridge/src/opener.ts
import { spawn } from "node:child_process";
var OPEN_PREFIXES = [BRIDGE_PORT, BRIDGE_PORT_E2E].map((port) => `http://${BRIDGE_HOST}:${port}/open/`);
function isOpenAddress(address) {
  return OPEN_PREFIXES.some((prefix) => address.startsWith(prefix) && LINK_CODE.test(address.slice(prefix.length)));
}
function openerFor(platform) {
  if (platform === "darwin") return { file: "open", args: [] };
  if (platform === "win32") return { file: "rundll32", args: ["url.dll,FileProtocolHandler"] };
  return { file: "xdg-open", args: [] };
}
function openAddress(address, deps) {
  if (!isOpenAddress(address)) return false;
  const opener = openerFor(deps.platform);
  try {
    return deps.start(opener.file, [...opener.args, address]);
  } catch {
    return false;
  }
}
function startOpener(file, args, mask) {
  const own = process.umask(mask);
  let child;
  try {
    child = spawn(file, args, { detached: true, stdio: "ignore" });
  } finally {
    process.umask(own);
  }
  child.on("error", () => {
  });
  child.unref();
  return child.pid !== void 0;
}

// bridge/src/server.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import { createServer } from "node:http";

// shared/extension-id.ts
var EXTENSION_ID = "dacfmlfnipbinbogicdjfckblnjnbonl";

// bridge/src/bindings.ts
import { lstatSync as lstatSync7, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync4, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join8 } from "node:path";
function bindingKey(url) {
  const parsed = parseUrl(url);
  if (parsed?.protocol === "http:" || parsed?.protocol === "https:") return parsed.origin;
  const path = filePath(url);
  if (!parsed || path === null) return null;
  return `file://${parsed.host}${path.slice(0, path.lastIndexOf("/") + 1)}`;
}
function recordBinding(url, agent, source, now = Date.now()) {
  const key = bindingKey(url);
  if (key === null) return;
  const bindings = readBindings();
  bindings[key] = { agent, at: now, source };
  writeBindings(bindings);
}
function preselect(url, agents2) {
  const key = bindingKey(url);
  if (key === null) return null;
  const living = new Set(agents2.map((agent) => agent.id));
  let best = null;
  for (const [boundKey, binding] of Object.entries(readBindings())) {
    if (!covers(boundKey, key) || !living.has(binding.agent)) continue;
    if (!best || boundKey.length > best.key.length) best = { key: boundKey, agent: binding.agent };
  }
  return best?.agent ?? null;
}
function covers(boundKey, pageKey) {
  if (boundKey === pageKey) return true;
  return boundKey.startsWith("file://") && boundKey.endsWith("/") && pageKey.startsWith(boundKey);
}
function storePath() {
  return join8(stateDir(), "bindings.json");
}
function readBindings() {
  const path = storePath();
  let raw;
  try {
    if (!lstatSync7(path, { throwIfNoEntry: false })?.isFile()) return {};
    raw = JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return {};
  }
  const bindings = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bindings;
  for (const [key, value] of Object.entries(raw)) {
    if (isBinding(value)) bindings[key] = value;
  }
  return bindings;
}
function isBinding(value) {
  if (typeof value !== "object" || value === null) return false;
  const { agent, at, source } = value;
  return typeof agent === "string" && typeof at === "number" && (source === "link" || source === "send");
}
function writeBindings(bindings) {
  mkdirSync4(stateDir(), { recursive: true });
  const path = storePath();
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync4(temp, `${JSON.stringify(bindings, null, 2)}
`);
    renameSync4(temp, path);
  } catch (error) {
    try {
      rmSync4(temp, { force: true });
    } catch {
    }
    throw error;
  }
}

// bridge/src/host.ts
import { join as join10 } from "node:path";

// shared/line.ts
function sendLine(count, url, file) {
  const path = file.includes(" ") ? `"${file}"` : file;
  return `Browser annotations (${count}) on ${url}: read ${path}, carry out the Change items and answer the Question items.`;
}

// bridge/src/sends.ts
import { mkdirSync as mkdirSync5, readdirSync as readdirSync6, rmSync as rmSync5, statSync as statSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join9, resolve as resolve3 } from "node:path";

// shared/clean.ts
var HIDDEN_CHARACTERS = /[\u{E0000}-\u{E007F}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/gu;
var HIDDEN_HTML = /<!--[\s\S]*?(?:-->|$)|(<(script|style)(?=[\s/>])[^>]*>)[\s\S]*?(?=<\/\2[\s/>]|$)/gi;
function cleanText(text) {
  return text.replace(HIDDEN_CHARACTERS, "");
}
function cleanHtml(html) {
  let cleaned = cleanText(html);
  for (let before = ""; cleaned !== before; ) {
    before = cleaned;
    cleaned = cleaned.replace(HIDDEN_HTML, (_match, openingTag) => openingTag ?? "");
  }
  return cleaned;
}
var SPACE2 = /\p{White_Space}+/gu;
function cleanLine(text) {
  return cleanText(text).replace(SPACE2, " ").trim();
}
function cleanAnnotation(annotation) {
  return {
    ...annotation,
    label: cleanLine(annotation.label),
    selector: cleanText(annotation.selector),
    domPath: cleanText(annotation.domPath),
    text: cleanText(annotation.text),
    html: cleanHtml(annotation.html),
    styles: Object.fromEntries(Object.entries(annotation.styles).map(([prop, value]) => [prop, cleanText(value)]))
  };
}
function cleanPage(page) {
  return { ...page, title: cleanText(page.title) };
}

// shared/markdown.ts
var INTENT_HEADING = { change: "Change", question: "Question" };
var SHADOW_SEPARATOR = " >> ";
var SELECTOR_NOTE = "- Selector note: ` >> ` steps into an open shadow root; the part after it is a selector inside that root";
function renderMarkdown(rawPage, note, annotations) {
  const page = cleanPage(rawPage);
  const blocks = [
    "# Browser annotations",
    lines([
      page.title ? `- Page: ${code(page.title)} (${page.url})` : `- Page: ${page.url}`,
      page.sourceFile && `- Source file: ${code(page.sourceFile)}`,
      `- Viewport: ${page.viewport.width}x${page.viewport.height} at ${page.devicePixelRatio}x`,
      `- Annotations: ${annotations.length}`
    ])
  ];
  const generalComment = note.trim();
  if (generalComment) blocks.push("## General comment", generalComment);
  for (const annotation of annotations) blocks.push(...annotationBlocks(cleanAnnotation(annotation)));
  return `${blocks.filter((block) => block !== "").join("\n\n")}
`;
}
function annotationBlocks(annotation) {
  const { x, y, width, height } = roundRect(annotation.rect);
  const styles = Object.entries(annotation.styles).map(([prop, value]) => `${prop}: ${value}`).join("; ");
  return [
    `## ${annotation.number}. ${INTENT_HEADING[annotation.intent]}: ${code(annotation.label)}`,
    annotation.comment.trim(),
    lines([
      `- ID: ${code(annotation.id)}`,
      `- Selector: ${code(annotation.selector)}`,
      annotation.selector.includes(SHADOW_SEPARATOR) ? SELECTOR_NOTE : null,
      `- DOM path: ${code(annotation.domPath)}`,
      `- Position: x ${x}, y ${y}, ${width}x${height}`,
      annotation.screenshot && `- Screenshot: ${code(annotation.screenshot)}`,
      styles && `- Styles: ${code(styles)}`
    ]),
    ...annotation.text ? ["Text:", fence(annotation.text)] : [],
    "HTML:",
    fence(annotation.html, "html")
  ];
}
function roundRect({ x, y, width, height }) {
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
function lines(items) {
  return items.filter((item) => item).join("\n");
}
function fence(content, info = "") {
  const ticks = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${ticks}${info}
${content}
${ticks}`;
}
function code(content) {
  const run = longestBacktickRun(content);
  if (run === 0) return `\`${content}\``;
  const ticks = "`".repeat(run + 1);
  return `${ticks} ${content} ${ticks}`;
}
function longestBacktickRun(content) {
  return (content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
}

// bridge/src/sends.ts
var KEEP_MS = 7 * 24 * 60 * 60 * 1e3;
function sendsDir() {
  return resolve3(stateDir(), "sends");
}
function writeSend(payload, now = /* @__PURE__ */ new Date()) {
  const { note, images } = payload;
  const page = cleanPage(payload.page);
  const folder = createFolder(sendsDir(), folderName(now));
  const annotations = payload.annotations.map((annotation) => ({
    ...cleanAnnotation(annotation),
    screenshot: Object.hasOwn(images, annotation.id) ? `${annotation.number}.png` : null
  }));
  for (const annotation of annotations) {
    if (annotation.screenshot === null) continue;
    writeFileSync5(join9(folder, annotation.screenshot), Buffer.from(images[annotation.id], "base64"));
  }
  writeFileSync5(join9(folder, "annotations.md"), renderMarkdown(page, note, annotations));
  writeFileSync5(join9(folder, "annotations.json"), `${JSON.stringify({ page, note, annotations }, null, 2)}
`);
  return folder;
}
function pruneSends(now = /* @__PURE__ */ new Date()) {
  const base = sendsDir();
  let entries2;
  try {
    entries2 = readdirSync6(base, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const cutoff = now.getTime() - KEEP_MS;
  for (const entry of entries2) {
    if (!entry.isDirectory()) continue;
    const folder = join9(base, entry.name);
    const stats = statSync3(folder, { throwIfNoEntry: false });
    if (stats && stats.mtimeMs < cutoff) rmSync5(folder, { recursive: true, force: true });
  }
}
function folderName(now) {
  const two = (value) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `${date}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}
function createFolder(base, name) {
  mkdirSync5(base, { recursive: true });
  for (let count = 1; ; count++) {
    const folder = join9(base, count === 1 ? name : `${name}-${count}`);
    try {
      mkdirSync5(folder);
      return folder;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

// bridge/src/host.ts
var UNREADABLE = "The bridge could not read this request.";
var HELD_ID = "The bridge already has a send with this id.";
var BridgeFailure = class extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "BridgeFailure";
    this.kind = kind;
  }
};
async function handle(request) {
  try {
    switch (request.type) {
      case "agents":
        return agents(request.url);
      case "send":
        checkPayload(request.send);
        if (typeof request.id !== "string" || !SEND_ID.test(request.id)) throw new BridgeFailure("failed", UNREADABLE);
        return send(request.id, request.agent, request.send);
      case "copy":
        checkPayload(request.send);
        return copy(request.send);
      case "state":
        if (typeof request.id !== "string" || typeof request.agent !== "string") {
          throw new BridgeFailure("failed", UNREADABLE);
        }
        return state(request.id, request.agent);
      default:
        throw new BridgeFailure("failed", "The bridge does not know this request.");
    }
  } catch (error) {
    return failure(error);
  }
}
function checkPayload(payload) {
  const ok = isRecord(payload) && isRecord(payload.page) && Array.isArray(payload.annotations) && isOneUrl(payload.page.url) && payload.annotations.every((annotation) => isRecord(annotation) && isCount(annotation.number));
  if (!ok) throw new BridgeFailure("failed", UNREADABLE);
}
function isOneUrl(value) {
  return typeof value === "string" && !/[\s\p{Cc}]/u.test(value) && URL.canParse(value);
}
function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function agents(url) {
  const list = listAgents();
  return { ok: true, agents: list, preselect: preselect(url, list) };
}
function send(id, agent, payload) {
  if (!isListed(agent)) {
    throw new BridgeFailure("agent_gone", `The agent ${agent} is no longer listed.`);
  }
  if (inboxState(agent, id) !== null) throw new BridgeFailure("failed", HELD_ID);
  const folder = writeSend(payload);
  pruneQuietly();
  const line = sendLine(payload.annotations.length, payload.page.url, join10(folder, "annotations.md"));
  enqueue(agent, { send: id, folder, line });
  bindQuietly(payload.page.url, agent);
  return { ok: true, folder, line, agent };
}
function state(id, agent) {
  const held = inboxState(agent, id);
  if (held === null) return { ok: true, state: "unknown", line: null };
  if (held.state === "queued" && !isListed(agent)) return { ok: true, state: "agent_gone", line: held.line };
  return { ok: true, state: held.state, line: held.line };
}
function isListed(agent) {
  return listAgents().some((listed) => listed.id === agent);
}
function copy(payload) {
  const folder = writeSend(payload);
  pruneQuietly();
  const line = sendLine(payload.annotations.length, payload.page.url, join10(folder, "annotations.md"));
  return { ok: true, folder, line };
}
function pruneQuietly() {
  try {
    pruneSends();
  } catch {
  }
}
function bindQuietly(url, agent) {
  try {
    recordBinding(url, agent, "send");
  } catch {
  }
}
function failure(error) {
  if (error instanceof BridgeFailure) return { ok: false, kind: error.kind, message: error.message };
  return { ok: false, kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

// bridge/src/open-page.ts
var TITLE = "Clicknote";
var EXPIRED = "This link has expired. Ask your agent to open the page again.";
var FILE_HELP = 'This page cannot open a local file by itself. The Clicknote extension opens it when "Allow access to file URLs" is switched on for it at chrome://extensions. Switch it on, then ask your agent to open the page again.';
var NO_EXTENSION = "This page cannot open a local file by itself. The Clicknote extension does that, and it is not in this browser. Install it, then ask your agent to open the page again. Or copy the address below into the address bar.";
var STYLE = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { max-width: 40rem; margin: 4rem auto; padding: 0 1rem; overflow-wrap: anywhere; }
code { font-size: 0.9em; }
`;
var SCRIPT = `
(() => {
  const { target, kind } = document.body.dataset;
  let restored = false;
  const show = shown => {
    for (const id of ['opening', 'opened', 'file-help', 'no-extension']) {
      const block = document.getElementById(id);
      if (block) block.hidden = id !== shown;
    }
  };
  const fresh = performance.getEntriesByType('navigation')[0]?.type !== 'back_forward';
  if (!fresh) {
    show('opened');
    return;
  }
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    restored = true;
    show('opened');
  });
  const watched = document.documentElement.hasAttribute('data-clicknote');
  if (kind === 'web') {
    let gone = false;
    const go = () => {
      if (gone || restored) return;
      gone = true;
      location.replace(target);
    };
    if (!watched) return go();
    document.addEventListener('clicknote:linked', go, { once: true });
    setTimeout(go, 2000);
  } else if (kind === 'file') {
    if (!watched) return show('no-extension');
    setTimeout(() => {
      if (!restored) show('file-help');
    }, 2000);
  }
})();
`;
function openPage(link, nonce) {
  const kind = parseUrl(link.url)?.protocol === "file:" ? "file" : "web";
  const url = escapeHtml(link.url);
  const label = escapeHtml(link.label);
  const own = escapeHtml(nonce);
  const page = kind === "web" ? `<a href="${url}" rel="noreferrer">${url}</a>` : `<code>${url}</code>`;
  const blocks = [
    `<p id="opening">Opening ${page} for ${label} \u2026</p>`,
    `<p id="opened" hidden>This tab was opened for ${label}. The page is ${page}.</p>`
  ];
  if (kind === "file") {
    blocks.push(`<div id="file-help" hidden><p>${escapeHtml(FILE_HELP)}</p><p><code>${url}</code></p></div>`);
    blocks.push(`<div id="no-extension" hidden><p>${escapeHtml(NO_EXTENSION)}</p><p><code>${url}</code></p></div>`);
  }
  return htmlPage(`<style nonce="${own}">${STYLE}</style>`, `<body data-target="${url}" data-kind="${kind}">
${blocks.join("\n")}
<script nonce="${own}">${SCRIPT}</script>
</body>`);
}
function expiredPage() {
  return htmlPage("", `<body>
<p>${escapeHtml(EXPIRED)}</p>
</body>`);
}
function pageHeaders(nonce) {
  const own = nonce === void 0 ? [] : [`script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`];
  const policy = [
    "default-src 'none'",
    ...own,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ];
  return {
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": policy.join("; ")
  };
}
function htmlPage(head, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<link rel="icon" href="data:,">${head}
</head>
${body}
</html>
`;
}
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// bridge/src/server.ts
var PRUNE_MS = 36e5;
var ORIGIN = `chrome-extension://${EXTENSION_ID}`;
var TOO_LARGE = "This send is too large for the bridge.";
var UNKNOWN_LINK = "The bridge does not know this link.";
var OPEN_PATH = "/open";
var TYPES = /* @__PURE__ */ new Set(["agents", "send", "copy", "state", "opened"]);
function startBridge(options) {
  const state2 = {
    log: options.log ?? (() => {
    }),
    onActivity: options.onActivity ?? (() => {
    }),
    maxBody: options.maxBody ?? 64 * 1024 * 1024,
    host: ""
    // set once the port is known
  };
  const server = createServer((request, response) => {
    answer(request, response, state2).catch(() => {
      response.destroy();
      state2.log(logLine("-", "failed"));
    });
  });
  return new Promise((resolve4, reject) => {
    server.once("error", reject);
    server.listen(options.port, BRIDGE_HOST, () => {
      server.off("error", reject);
      const { address, port } = server.address();
      state2.host = `${BRIDGE_HOST}:${port}`;
      pruneAll();
      const pruning = setInterval(pruneAll, options.pruneMs ?? PRUNE_MS);
      pruning.unref();
      resolve4({
        port,
        address,
        close: () => {
          clearInterval(pruning);
          return close(server);
        }
      });
    });
  });
}
function pruneAll() {
  pruneQuietly2(pruneLinks);
  pruneQuietly2(pruneAgents);
  pruneQuietly2(pruneInbox);
  pruneQuietly2(pruneBeacons);
}
async function answer(request, response, state2) {
  if (request.headers.host !== state2.host) {
    empty(response, 403);
    state2.log(logLine("-", "refused"));
    return;
  }
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "GET" && path.startsWith(`${OPEN_PATH}/`)) {
    open(path, response, state2);
    return;
  }
  if (path !== BRIDGE_PATH || request.method !== "POST" && request.method !== "OPTIONS") {
    empty(response, 404);
    state2.log(logLine("-", "refused"));
    return;
  }
  if (request.headers.origin !== ORIGIN) {
    empty(response, 403);
    state2.log(logLine("-", "refused"));
    return;
  }
  state2.onActivity();
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type"
    }).end();
    state2.log(logLine("-", "ok"));
    return;
  }
  const bytes = await readBody(request, state2.maxBody);
  if (bytes === null) return;
  if (bytes === "too_large") {
    const reply = failure2(TOO_LARGE);
    writeReply(response, reply);
    state2.log(logLine("-", outcome(reply)));
    return;
  }
  const read = readRequest(bytes);
  try {
    const reply = "reply" in read ? read.reply : await act(read.body);
    writeReply(response, reply);
    state2.log(logLine(read.type, outcome(reply)));
  } catch {
    response.destroy();
    state2.log(logLine(read.type, "failed"));
  }
}
function open(path, response, state2) {
  const code2 = path.slice(OPEN_PATH.length + 1);
  const link = currentLink(code2);
  if (!link) {
    writePage(response, 404, expiredPage(), pageHeaders());
    state2.log(logLine("open", "expired"));
    return;
  }
  bindOnce(code2, link);
  const nonce = randomBytes3(16).toString("base64");
  writePage(response, 200, openPage(link, nonce), pageHeaders(nonce));
  state2.log(logLine("open", "ok"));
}
function currentLink(code2) {
  if (!LINK_CODE.test(code2)) return null;
  pruneQuietly2(pruneLinks);
  return readLink(code2);
}
function bindOnce(code2, link) {
  if (link.bound) return;
  try {
    recordBinding(link.url, link.agent, "link");
    markBound(code2);
  } catch {
  }
}
function pruneQuietly2(prune) {
  try {
    prune();
  } catch {
  }
}
function writePage(response, status, html, headers) {
  response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(html) });
  response.end(html);
}
function readRequest(bytes) {
  const value = parseJson(bytes);
  if (!isRecord2(value) || typeof value.protocol !== "number") return { type: "-", reply: failure2(UNREADABLE) };
  const { protocol, version, body } = value;
  if (protocol !== PROTOCOL) {
    const message = `The extension speaks protocol ${protocol} and the bridge protocol ${PROTOCOL}.`;
    return { type: logType(body), reply: { ok: false, kind: "version_mismatch", message } };
  }
  if (typeof version !== "string" || !isRecord2(body) || typeof body.type !== "string") {
    return { type: "-", reply: failure2(UNREADABLE) };
  }
  return { type: logType(body), body };
}
async function act(body) {
  return body.type === "opened" ? opened(body.code) : handle(body);
}
function opened(code2) {
  const link = typeof code2 === "string" ? currentLink(code2) : null;
  if (!link) return failure2(UNKNOWN_LINK);
  return { ok: true, url: link.url, agent: link.agent };
}
function readBody(request, maxBody) {
  return new Promise((resolve4) => {
    let tooLarge = Number(request.headers["content-length"]) > maxBody;
    let chunks = [];
    let size = 0;
    const done = (value) => {
      request.off("data", onData).off("end", onEnd).off("error", onGone).off("close", onGone);
      resolve4(value);
    };
    const onData = (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size <= maxBody) {
        chunks.push(chunk);
        return;
      }
      tooLarge = true;
      chunks = [];
    };
    const onEnd = () => done(tooLarge ? "too_large" : Buffer.concat(chunks));
    const onGone = () => done(null);
    request.on("data", onData).on("end", onEnd).on("error", onGone).on("close", onGone);
  });
}
function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return void 0;
  }
}
function logType(body) {
  return isRecord2(body) && typeof body.type === "string" && TYPES.has(body.type) ? body.type : "-";
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function writeReply(response, reply) {
  const envelope = { protocol: PROTOCOL, version: VERSION, body: reply };
  const json = JSON.stringify(envelope);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
    "access-control-allow-origin": ORIGIN
  });
  response.end(json);
}
function empty(response, status) {
  response.writeHead(status, { connection: "close" }).end();
}
function failure2(message) {
  return { ok: false, kind: "failed", message };
}
function outcome(reply) {
  return reply.ok ? "ok" : reply.kind;
}
function logLine(type, result, now = /* @__PURE__ */ new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())} ${type} ${result}`;
}
function close(server) {
  return new Promise((resolve4, reject) => {
    server.close((error) => error ? reject(error) : resolve4());
    server.closeIdleConnections();
  });
}

// bridge/src/cli.ts
var MIN_NODE = { major: 22, minor: 0 };
var USAGE = [
  "Usage: clicknote [command]",
  "",
  "  (no command)                              run the bridge in the foreground",
  "  register --harness <name> --about <words> register this agent; prints its id",
  "  open <url> [--agent <id>] [--harness <name>] [--about <words>] [--address-only]",
  "                                            link a page to the agent and open it",
  "  wait <agent id> [--about <words>]         wait for annotations and print their lines",
  "  stop                                      stop the bridge",
  "  --version, --help"
];
var FLAGS = {
  register: { "--harness": true, "--about": true },
  open: { "--agent": true, "--harness": true, "--about": true, "--address-only": false },
  wait: { "--about": true }
};
function supportsNode(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE.major || major === MIN_NODE.major && minor >= MIN_NODE.minor;
}
async function runCli(args, deps) {
  const command = parseCommand(args);
  if (command === null || command.name === "help") {
    for (const line of USAGE) deps.out(line);
    return command === null ? 2 : 0;
  }
  if (command.name === "version") {
    deps.out(VERSION);
    return 0;
  }
  try {
    deps.secure();
  } catch (error) {
    if (command.name === "open") return runOpenUnlinked(command.url, errorMessage2(error), deps);
    if (!(error instanceof StateFolderError)) throw error;
    deps.err(error.message);
    return 1;
  }
  const commandDeps = {
    cwd: deps.cwd,
    port: deps.port,
    ensure: deps.ensure,
    open: deps.open,
    out: deps.out,
    note: deps.note
  };
  switch (command.name) {
    case "bridge":
      return runBridge(command.auto, deps);
    case "register":
      return runRegister({ harness: command.harness, about: command.about }, commandDeps);
    case "open":
      return runOpen({
        url: command.url,
        agent: command.agent,
        harness: command.harness,
        about: command.about,
        addressOnly: command.addressOnly
      }, commandDeps);
    case "wait":
      return runWait(
        { agent: command.agent, about: command.about },
        { ...commandDeps, signal: deps.signal, write: deps.write }
      );
    case "stop":
      return runStop({ note: deps.note, sleep: deps.sleep, now: deps.now });
  }
}
function parseCommand(args) {
  const [first, ...rest] = args;
  if (args.length <= 1) {
    if (first === void 0) return { name: "bridge", auto: false };
    if (first === "--auto") return { name: "bridge", auto: true };
    if (first === "--version") return { name: "version" };
    if (first === "--help") return { name: "help" };
  }
  switch (first) {
    case "register": {
      const read = readArgs(rest, FLAGS.register);
      const harness = read?.flags.get("--harness");
      const about = read?.flags.get("--about");
      if (read?.positionals.length !== 0 || harness === void 0 || about === void 0) return null;
      return { name: "register", harness, about };
    }
    case "open": {
      const read = readArgs(rest, FLAGS.open);
      if (read?.positionals.length !== 1) return null;
      const { flags, positionals: [url] } = read;
      return {
        name: "open",
        url,
        agent: flags.get("--agent"),
        harness: flags.get("--harness"),
        about: flags.get("--about"),
        addressOnly: flags.has("--address-only")
      };
    }
    case "wait": {
      const read = readArgs(rest, FLAGS.wait);
      if (read?.positionals.length !== 1) return null;
      return { name: "wait", agent: read.positionals[0], about: read.flags.get("--about") };
    }
    case "stop":
      return rest.length === 0 ? { name: "stop" } : null;
    default:
      return null;
  }
}
function readArgs(args, known) {
  const flags = /* @__PURE__ */ new Map();
  const positionals = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!Object.hasOwn(known, arg) || flags.has(arg)) return null;
    if (!known[arg]) {
      flags.set(arg, "");
      continue;
    }
    if (at + 1 === args.length) return null;
    flags.set(arg, args[++at]);
  }
  return { flags, positionals };
}
async function runBridge(auto, deps) {
  const idle = createIdle(deps.now);
  const log = auto ? fileLog() : deps.out;
  const failed = (reason) => {
    if (auto) log(logLine("start", `failed: ${reason}`));
  };
  let bridge;
  try {
    bridge = await deps.start({ port: deps.port, log, onActivity: () => idle.activity() });
  } catch (error) {
    const inUse = error.code === "EADDRINUSE";
    failed(inUse ? "port in use" : errorMessage2(error));
    if (!inUse) deps.err(errorMessage2(error));
    else if (auto) noteProblem("port_in_use");
    else deps.err(`Port ${deps.port} is in use. Clicknote may be running already: run stop first.`);
    return 1;
  }
  try {
    deps.keep(bridge, auto, idle);
  } catch (error) {
    await bridge.close().catch(() => void 0);
    failed(errorMessage2(error));
    deps.err(errorMessage2(error));
    return 1;
  }
  if (!auto) deps.out(`clicknote ${VERSION} listening on http://${bridge.address}:${bridge.port}`);
  return 0;
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function printError(message) {
  process.stderr.write(`clicknote: ${message}
`);
}
function writeLine(stream, line) {
  return new Promise((resolve4, reject) => {
    const passOver = () => {
    };
    stream.on("error", passOver);
    stream.write(`${line}
`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      stream.off("error", passOver);
      resolve4();
    });
  });
}
function isEntryWithoutMain(main2, script, self, realpath = realpathSync) {
  if (main2 !== void 0 || script === void 0) return false;
  try {
    return realpath(script) === self;
  } catch {
    return false;
  }
}
var THIS_PROCESS = {
  on: (signal, listener) => process.on(signal, listener),
  once: (signal, listener) => process.once(signal, listener),
  exit: (code2) => process.exit(code2),
  now: Date.now
};
var STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
var SAME_STOP_MS = 1e3;
function stopOnSignals(kept, program = THIS_PROCESS) {
  let firstAt;
  const stop = () => {
    const now = program.now();
    if (firstAt === void 0) {
      firstAt = now;
      void kept.end(0);
    } else if (now - firstAt >= SAME_STOP_MS) {
      program.exit(1);
    }
  };
  for (const signal of STOP_SIGNALS) program.on(signal, stop);
}
var WAIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function waitSignal(args, program = THIS_PROCESS) {
  const controller = new AbortController();
  if (args[0] === "wait") {
    for (const signal of WAIT_SIGNALS) program.once(signal, () => controller.abort());
  }
  return controller.signal;
}
function startApart(file, args, options) {
  const child = spawn2(file, args, options);
  child.on("error", () => {
  });
  return child;
}
async function main(args) {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const startMask = process.umask(63);
  process.exitCode = await runCli(args, {
    cwd: process.cwd(),
    port: BRIDGE_PORT,
    signal: waitSignal(args),
    secure: () => {
      secureStateDir();
    },
    start: startBridge,
    keep: (bridge, auto, idle) => {
      stopOnSignals(keepBridge({
        bridge,
        auto,
        idle,
        pid: process.pid,
        every: (ms, tick) => {
          const timer = setInterval(tick, ms);
          return { stop: () => clearInterval(timer) };
        },
        exit: (code2) => process.exit(code2)
      }));
    },
    ensure: () => ensureBridge({
      spawn: startApart,
      execPath: process.execPath,
      self: fileURLToPath(import.meta.url),
      env: process.env,
      sleep,
      now: Date.now
    }),
    open: (address) => openAddress(address, {
      platform: process.platform,
      start: (file, args2) => startOpener(file, args2, startMask)
    }),
    sleep,
    now: Date.now,
    out: (line) => process.stdout.write(`${line}
`),
    write: (line) => writeLine(process.stdout, line),
    err: printError,
    note: (line) => process.stderr.write(`${line}
`)
  });
}
if (import.meta.main || isEntryWithoutMain(import.meta.main, process.argv[1], fileURLToPath(import.meta.url))) {
  if (supportsNode(process.version)) {
    main(process.argv.slice(2)).catch((error) => {
      printError(errorMessage2(error));
      process.exitCode = 1;
    });
  } else {
    printError(`needs Node ${MIN_NODE.major} or later, and this is Node ${process.version.replace(/^v/, "")}`);
    process.exitCode = 1;
  }
}
export {
  MIN_NODE,
  isEntryWithoutMain,
  runCli,
  stopOnSignals,
  supportsNode,
  waitSignal,
  writeLine
};
