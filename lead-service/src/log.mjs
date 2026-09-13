// One log line per event. Callers pass lead ids, statuses and error codes only —
// never names, phones, companies or IP addresses.
export function log(message) {
	console.log(`${new Date().toISOString()} ${message}`);
}
