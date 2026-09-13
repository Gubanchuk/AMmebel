// Per-address sliding window kept in memory. The service runs as a single
// instance, so no shared store is needed; a restart resets the counters, which
// is acceptable for spam protection (nginx limit_req sits in front as well).

export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10_000 }) {
	const hits = new Map();

	function sweep(t) {
		for (const [key, times] of hits) {
			if (times[times.length - 1] <= t - windowMs) hits.delete(key);
		}
		// Still too many distinct addresses (a flood): drop the oldest entries so
		// memory stays bounded.
		while (hits.size > maxKeys) {
			hits.delete(hits.keys().next().value);
		}
	}

	return {
		retryAfterSeconds: Math.ceil(windowMs / 1000),
		allow(key) {
			const t = now();
			const recent = (hits.get(key) || []).filter((time) => time > t - windowMs);
			if (recent.length >= limit) {
				hits.set(key, recent);
				return false;
			}
			recent.push(t);
			hits.set(key, recent);
			if (hits.size > maxKeys) sweep(t);
			return true;
		},
		get size() {
			return hits.size;
		},
	};
}
