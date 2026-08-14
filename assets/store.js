// assets/store.js — Persistence (owner: Persistence)
//
// localStorage-backed settings / autosave / stats, matching
// specs/architecture.md §4 exactly:
//   - xox.settings        FR-6.3
//   - xox.game.ultimate   FR-6.1
//   - xox.game.classic    FR-6.1
//   - xox.stats           FR-6.2
//
// No DOM dependency beyond the Web Storage API (localStorage). Every read
// and write is wrapped so a missing key, corrupt JSON, a foreign schema
// version, or a throwing localStorage (Safari private mode, quota errors,
// sandboxed embeds) can never break the caller — bad data is dropped and a
// fresh default takes its place; a throwing localStorage flips the store
// into an in-memory fallback for the rest of the session (`store.degraded`).

const SCHEMA = 1;
const PREFIX = "xox.";

const KEYS = {
  settings: PREFIX + "settings",
  gameUltimate: PREFIX + "game.ultimate",
  gameClassic: PREFIX + "game.classic",
  stats: PREFIX + "stats",
};

// ---------------------------------------------------------------------------
// Raw storage layer: localStorage when it works, an in-memory Map the moment
// it doesn't. Every localStorage touch is try/caught individually — a single
// SecurityError or QuotaExceededError degrades the store, it never throws
// out to the caller.
// ---------------------------------------------------------------------------

const memory = new Map();

function markDegraded() {
  store.degraded = true;
}

function hasStorage() {
  // Merely *referencing* `localStorage` can throw (sandboxed iframes,
  // some privacy modes), so this has to be inside the try too.
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch (_err) {
    return false;
  }
}

function rawGet(key) {
  if (store.degraded || !hasStorage()) {
    return memory.has(key) ? memory.get(key) : null;
  }
  try {
    const v = localStorage.getItem(key);
    return v === undefined ? null : v;
  } catch (_err) {
    markDegraded();
    return memory.has(key) ? memory.get(key) : null;
  }
}

function rawSet(key, value) {
  if (store.degraded || !hasStorage()) {
    memory.set(key, value);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch (_err) {
    markDegraded();
    memory.set(key, value);
  }
}

function rawRemove(key) {
  memory.delete(key);
  if (store.degraded || !hasStorage()) {
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch (_err) {
    markDegraded();
  }
}

function rawKeys() {
  const keys = new Set();
  for (const k of memory.keys()) {
    keys.add(k);
  }
  if (hasStorage()) {
    try {
      for (let i = 0; i < localStorage.length; i = i + 1) {
        const k = localStorage.key(i);
        if (k !== null && k !== undefined) {
          keys.add(k);
        }
      }
    } catch (_err) {
      markDegraded();
    }
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// Versioned read/write. §4.3: "parse -> if !obj || obj.v !== SCHEMA -> drop
// the key and return null". Missing, corrupt, foreign-version and
// wrong-shape data all take the same branch. No migration exists at v1 by
// design.
// ---------------------------------------------------------------------------

function readKey(key) {
  const raw = rawGet(key);
  if (raw === null || raw === undefined) {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_err) {
    rawRemove(key);
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || obj.v !== SCHEMA) {
    rawRemove(key);
    return null;
  }
  return obj;
}

function writeKey(key, obj) {
  let json;
  try {
    json = JSON.stringify(obj);
  } catch (_err) {
    // Non-serializable payload is a caller bug, not a storage failure —
    // nothing sane to persist, so just skip the write rather than throw.
    return;
  }
  rawSet(key, json);
}

// ---------------------------------------------------------------------------
// settings — FR-6.3: difficulty, sound, theme, who moves first (plus mode
// and seed, per the §4.2 shape).
// ---------------------------------------------------------------------------

function defaultSettings() {
  return {
    v: SCHEMA,
    mode: "ultimate",
    difficulty: "medium",
    sound: false,
    theme: "dark",
    first: "X",
    seed: Math.floor(Math.random() * 1_000_000_000),
  };
}

const settings = {
  get() {
    const stored = readKey(KEYS.settings);
    if (stored !== null) {
      return stored;
    }
    const fresh = defaultSettings();
    writeKey(KEYS.settings, fresh);
    return fresh;
  },

  patch(partial) {
    const current = settings.get();
    const next = Object.assign({}, current, partial, { v: SCHEMA });
    writeKey(KEYS.settings, next);
    return next;
  },
};

// ---------------------------------------------------------------------------
// game — FR-6.1 autosave/restore, one record per mode. `save()` takes
// exactly the fields the UI owns (per §4.4's contract); startedAt/updatedAt
// on the ultimate record are managed here so callers never have to think
// about them.
// ---------------------------------------------------------------------------

function gameKey(mode) {
  if (mode === "ultimate") {
    return KEYS.gameUltimate;
  }
  if (mode === "classic") {
    return KEYS.gameClassic;
  }
  throw new TypeError('store.game: mode must be "ultimate" or "classic", got ' + JSON.stringify(mode));
}

const game = {
  save(mode, data) {
    const key = gameKey(mode);
    const record = Object.assign({ v: SCHEMA }, data);
    if (mode === "ultimate") {
      const existing = readKey(key);
      record.startedAt =
        existing !== null && typeof existing.startedAt === "number" ? existing.startedAt : Date.now();
      record.updatedAt = Date.now();
    }
    writeKey(key, record);
  },

  load(mode) {
    return readKey(gameKey(mode));
  },

  clear(mode) {
    rawRemove(gameKey(mode));
  },
};

// ---------------------------------------------------------------------------
// stats — FR-6.2: wins/losses/draws per mode x difficulty.
// ---------------------------------------------------------------------------

const RESULT_FIELD = { win: "w", loss: "l", draw: "d" };

function defaultStats() {
  return { v: SCHEMA, records: {} };
}

function readStats() {
  const stored = readKey(KEYS.stats);
  return stored !== null ? stored : defaultStats();
}

const stats = {
  record({ mode, difficulty, result }) {
    const field = RESULT_FIELD[result];
    if (typeof mode !== "string" || mode.length === 0) {
      throw new TypeError("store.stats.record: mode must be a non-empty string");
    }
    if (typeof difficulty !== "string" || difficulty.length === 0) {
      throw new TypeError("store.stats.record: difficulty must be a non-empty string");
    }
    if (field === undefined) {
      throw new TypeError('store.stats.record: result must be "win" | "loss" | "draw", got ' + JSON.stringify(result));
    }

    const current = readStats();
    const records = Object.assign({}, current.records);
    const key = mode + ":" + difficulty;
    const entry = Object.assign({ w: 0, l: 0, d: 0 }, records[key]);
    entry[field] = entry[field] + 1;
    records[key] = entry;

    writeKey(KEYS.stats, { v: SCHEMA, records: records });
  },

  all() {
    return readStats().records;
  },
};

// ---------------------------------------------------------------------------
// FR-6.4 reset-all — the only path allowed to clear stats.
// ---------------------------------------------------------------------------

function resetAll() {
  const keys = rawKeys().filter((k) => k.indexOf(PREFIX) === 0);
  for (const k of keys) {
    rawRemove(k);
  }
}

// ---------------------------------------------------------------------------
// Public surface — the §4.4 contract, verbatim.
// ---------------------------------------------------------------------------

export const store = {
  settings,
  game,
  stats,
  resetAll,
  degraded: false,
};

export default store;
