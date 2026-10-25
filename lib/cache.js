'use strict';

// An optional in-memory cache of finished renders, kept in front of Prerender (CACHE_TTL_S, off unless set).
//
// Rules that keep it safe:
//   - It only ever holds what the front server has already validated and filtered: the key is a target URL that passed the host
//     allowlist, and the stored headers are the short allowlist the front server passes on. A cached answer is byte for byte the
//     answer that a render would have produced.
//   - Size is bounded twice, by bytes and by entries. The least recently used entries go first. One answer larger than a quarter
//     of the byte limit is not stored, so a single big page cannot flush everything else.
//   - Entries expire after the TTL. Expired entries are removed when looked up and by a periodic sweep.
//   - Nothing is shared between requests except immutable buffers: a hit never touches the browser.
//
// Memory held here is outside the Node heap and counts against the container's memory limit.

const ENTRY_OVERHEAD_BYTES = 512; // the key, the header strings and the bookkeeping of one entry, as a flat estimate

function createRenderCache({ ttlMs, maxBytes, maxEntries, now = Date.now }) {
  const entries = new Map(); // insertion order is recency order: the first key is the least recently used
  const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0, skippedLarge: 0, bytes: 0 };

  const sizeOf = (key, entry) => key.length + entry.body.length + ENTRY_OVERHEAD_BYTES;

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    stats.bytes -= entry.size;
  }

  function get(key) {
    const entry = entries.get(key);
    if (!entry) { stats.misses += 1; return null; }
    if (entry.expiresAt <= now()) { remove(key); stats.expired += 1; stats.misses += 1; return null; }
    entries.delete(key); // move to the most recently used end
    entries.set(key, entry);
    stats.hits += 1;
    return entry;
  }

  function set(key, { status, headers, body }) {
    const size = sizeOf(key, { body });
    if (size > maxBytes / 4) { stats.skippedLarge += 1; return false; }
    remove(key);
    while (entries.size >= maxEntries || stats.bytes + size > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
      stats.evictions += 1;
    }
    entries.set(key, { status, headers: { ...headers }, body, size, storedAt: now(), expiresAt: now() + ttlMs });
    stats.bytes += size;
    stats.stores += 1;
    return true;
  }

  function sweep() {
    const at = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= at) { remove(key); stats.expired += 1; }
  }

  function clear() { entries.clear(); stats.bytes = 0; }

  return { get, set, sweep, clear, stats, get size() { return entries.size; } };
}

module.exports = { createRenderCache, ENTRY_OVERHEAD_BYTES };
