"use strict"

/**
 * ip-blacklist-monitor.js
 * ------------------------------------------------------------------
 * Pure functional module (no class/this/prototypes) for monitoring
 * your subnets against DNSBL/RBL zones and alerting on NEW incidents
 * via the Telegram Bot API (HTTP POST).
 *
 * Flow:
 *  1) subnetsToIPs()  — expands a list of CIDRs (small /28, /27, etc.
 *     are fine — no need to scan empty ranges) into a flat IP list.
 *  2) scanSubnets()   — sequentially (NOT in parallel!) queries every
 *     IP against every DNSBL zone with a fixed delay between requests
 *     (IPMON_REQUEST_DELAY_MS). No worker pool — just a queue + sleep().
 *  3) diffAgainstState() — compares the scan result against the saved
 *     state file and produces newListings (not present last time) and
 *     resolvedListings (delisted since last time).
 *  4) triggerAlerts()  — if newListings/resolvedListings are non-empty,
 *     sends one Telegram message per IP.
 *  5) runMonitoringCycle() — wires everything together; this is the
 *     only function you call on a schedule (cron / systemd timer /
 *     your own scheduler). No setInterval/cron inside the module itself.
 *
 * AbuseIPDB support is fully optional: without an API key it's simply
 * skipped. No paid token is required for the module to work — the
 * core logic only relies on free DNS queries against DNSBL zones.
 * ------------------------------------------------------------------
 */

const dns = require("dns").promises
const fs = require("fs")
const path = require("path")

// IMPORTANT: do NOT point this at public resolvers (1.1.1.1, 8.8.8.8,
// 9.9.9.9, etc.) via dns.setServers(). Spamhaus (zen.spamhaus.org)
// deliberately blocks queries coming through public DNS resolvers and
// returns an error code (127.255.255.254) instead of a real answer —
// which used to make every IP look falsely "listed". By default we
// rely on the OS-level resolver of the host. If that resolver itself
// turns out to be a public one (common on some VPS/containers), point
// it explicitly at your own local recursive resolver, e.g.:
//   dns.setServers(["127.0.0.1"])
// if you run your own BIND/Unbound/etc. on the same machine. See the
// IPMON_DNS_SERVERS env var below for a config-driven way to do this
// without editing the file.
const configuredDnsServers = (process.env.IPMON_DNS_SERVERS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
if (configuredDnsServers.length > 0) {
	dns.setServers(configuredDnsServers)
}

// ====================================================================
// CONFIG FROM ENV (pure function, no side effects on read)
// ====================================================================

const DEFAULT_DNSBL_ZONES = [
	"zen.spamhaus.org",
	"bl.spamcop.net",
	"dnsbl.sorbs.net",
	"b.barracudacentral.org",
	"dnsbl-1.uceprotect.net",
	"tor.dan.me.uk",
]

const splitEnvList = (value, fallback) =>
	(value || fallback)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)

const getConfig = () => ({
	// List of subnets. You can mix large /24, /23 ranges with small
	// /28 (255.255.255.240) / /27 (255.255.255.224) blocks — if you
	// know exactly which small blocks are actually occupied by
	// subscribers, list just those instead of the whole /24 or /23.
	subnets: splitEnvList(
		process.env.IPMON_SUBNETS,
		"91.220.106.0/24,176.124.138.0/23",
	),

	dnsblZones: splitEnvList(
		process.env.IPMON_DNSBL_ZONES,
		DEFAULT_DNSBL_ZONES.join(","),
	),

	// Delay between EVERY single DNS request, in ms. This is the only
	// load control knob — there is no concurrency pool.
	requestDelayMs: parseInt(process.env.IPMON_REQUEST_DELAY_MS || "200", 10),

	dnsTimeoutMs: parseInt(process.env.IPMON_DNS_TIMEOUT_MS || "4000", 10),
	retries: parseInt(process.env.IPMON_RETRIES || "1", 10),
	excludeReserved: (process.env.IPMON_EXCLUDE_RESERVED || "true") === "true",

	// If a single DNSBL zone comes back "listed" for more than this
	// share of checked IPs in one cycle (and at least minChecks IPs
	// were actually checked against it), treat it as broken/misconfigured
	// rather than a real incident — see detectSuspiciousZones(). This is
	// what protects against a bad new source flagging "all" addresses.
	zoneSuspiciousThreshold: parseFloat(
		process.env.IPMON_ZONE_SUSPICIOUS_THRESHOLD || "0.15",
	),
	zoneSuspiciousMinChecks: parseInt(
		process.env.IPMON_ZONE_SUSPICIOUS_MIN_CHECKS || "10",
		10,
	),

	// Default assumes the module lives at
	// src/server/modules/ip-blacklist-monitor/monitor.js — then
	// ../../data/ points at src/server/data/. If your module lives
	// elsewhere, just set IPMON_STATE_FILE explicitly in .env; it
	// always takes priority over this default.
	stateFile:
		process.env.IPMON_STATE_FILE ||
		path.join(__dirname, "../../data/dnsbl-state.json"),

	// Second JSON: one overall status per IP ("problem" / "clean") across
	// ALL zones combined — separate from the per-zone history above.
	// Lets you check "is this IP fine right now" in one lookup, and is
	// what drives the "recovered" notification below.
	summaryFile:
		process.env.IPMON_SUMMARY_FILE ||
		path.join(__dirname, "../../data/ip-status-summary.json"),

	// --- Telegram ---
	telegramBotToken: process.env.IPMON_TELEGRAM_BOT_TOKEN || "",
	telegramChatId: process.env.IPMON_TELEGRAM_CHAT_ID || "",
	telegramAutoSend: (process.env.IPMON_TELEGRAM_AUTOSEND || "true") === "true",

	// --- Spamhaus DROP/EDROP (free, no key, explicitly allowed for
	// automated download by Spamhaus themselves — their condition:
	// no more than once per hour, once per day recommended, hence
	// the local cache file below) ---
	dropEnabled: (process.env.IPMON_DROP_ENABLED || "true") === "true",
	dropUrl:
		process.env.IPMON_DROP_URL || "https://www.spamhaus.org/drop/drop.txt",
	dropCacheFile:
		process.env.IPMON_DROP_CACHE_FILE ||
		path.join(__dirname, "../../data/spamhaus-drop-cache.txt"),
	dropMaxAgeHours: parseInt(process.env.IPMON_DROP_MAX_AGE_HOURS || "24", 10),

	// --- AbuseIPDB (fully optional, unused without a key) ---
	abuseIpDbKey: process.env.IPMON_ABUSEIPDB_KEY || "",
	abuseIpDbThreshold: parseInt(
		process.env.IPMON_ABUSEIPDB_THRESHOLD || "25",
		10,
	),
	abuseIpDbDelayMs: parseInt(
		process.env.IPMON_ABUSEIPDB_DELAY_MS || "1000",
		10,
	),
})

// ====================================================================
// CIDR -> list of IPs (pure functions)
// ====================================================================

const ipToLong = (ip) =>
	ip
		.split(".")
		.reduce((acc, octet) => (acc << 8) + (parseInt(octet, 10) & 0xff), 0) >>> 0

const longToIp = (long) =>
	[24, 16, 8, 0].map((shift) => (long >>> shift) & 255).join(".")

const cidrToIPs = (cidr, { excludeReserved = true } = {}) => {
	const [ipPart, bitsPart] = cidr.split("/")
	const bits = parseInt(bitsPart, 10)
	if (!ipPart || Number.isNaN(bits) || bits < 0 || bits > 32) {
		throw new Error(`Invalid CIDR: "${cidr}"`)
	}

	const ipLong = ipToLong(ipPart)
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
	const network = (ipLong & mask) >>> 0
	const broadcast = (network | (~mask >>> 0)) >>> 0
	const skipEdges = excludeReserved && bits < 31

	const range = []
	for (let cur = network; cur <= broadcast; cur++) range.push(cur)

	return range
		.filter((cur) => !(skipEdges && (cur === network || cur === broadcast)))
		.map(longToIp)
}

const subnetsToIPs = (subnets, opts = {}) => [
	...new Set(subnets.flatMap((cidr) => cidrToIPs(cidr, opts))),
]

/**
 * Checks whether a given IP falls inside a CIDR range. Needed for
 * lists like Spamhaus DROP, which publish whole "bad" networks
 * (e.g. "5.42.92.0/24") rather than individual IPs — those can't be
 * resolved via DNS, membership has to be checked manually.
 */
const ipInCidr = (ip, cidr) => {
	const [netIpPart, bitsPart] = cidr.split("/")
	const bits = parseInt(bitsPart, 10)
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
	return (ipToLong(ip) & mask) === (ipToLong(netIpPart) & mask)
}

// ====================================================================
// SEQUENTIAL EXECUTION WITH DELAY (instead of a worker pool)
// ====================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs fn(item) for every item ONE AT A TIME (not in parallel), with
 * a delayMs pause after each call. This is the "dumb fixed interval
 * between requests" approach — simple and predictable load.
 */
const runSequentialWithDelay = (items, delayMs, fn) =>
	items.reduce(
		(accPromise, item) =>
			accPromise.then(async (acc) => {
				const result = await fn(item)
				if (delayMs > 0) await sleep(delayMs)
				return [...acc, result]
			}),
		Promise.resolve([]),
	)

const withTimeout = (promise, ms, timeoutError = { code: "ETIMEDOUT" }) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(timeoutError), ms)
		promise.then(
			(v) => {
				clearTimeout(timer)
				resolve(v)
			},
			(e) => {
				clearTimeout(timer)
				reject(e)
			},
		)
	})

// ====================================================================
// CHECK A SINGLE IP AGAINST A SINGLE DNSBL ZONE
// ====================================================================

// Spamhaus (and some others) use the 127.255.255.x range as service
// ERROR codes, not a real listing:
//   127.255.255.252 — query error (malformed request)
//   127.255.255.254 — query arrived via a public/open resolver
//   127.255.255.255 — query rate limit exceeded
// If we see one of these addresses, it does NOT mean "this IP is
// blacklisted" — it means "we couldn't ask properly". Such results
// must NOT flow into newListings/alerts, or every checked IP would
// falsely look like a new incident.
const isResolverErrorCode = (addresses) =>
	Array.isArray(addresses) &&
	addresses.some((addr) => addr.startsWith("127.255.255."))

// Every legitimate DNSBL zone answers a "listed" query with an address
// in 127.0.0.0/8 (the loopback range is the de-facto DNSBL convention,
// used by Spamhaus, Barracuda, SpamCop, SORBS, UCEPROTECT, dan.me.uk —
// all of the zones in DEFAULT_DNSBL_ZONES). A response OUTSIDE that
// range is not a real "yes, blacklisted" answer — it's a sign of a
// hijacked/misbehaving resolver (some ISP/VPS resolvers "helpfully"
// answer NXDOMAIN queries with a real IP instead of erroring), a
// misconfigured zone, or a wildcard record on a broken third-party
// source. We treat that case as an inconclusive error, NOT as a
// listing — this is a narrow, additive check: it only ever turns a
// would-be listed:true into listed:null, never the other way around,
// so it cannot hide a real listing that already looks correct today.
const isOutsideDnsblRange = (addresses) =>
	Array.isArray(addresses) && !addresses.every((addr) => addr.startsWith("127."))

const checkDNSBL = async (ip, zone, opts = {}) => {
	const timeoutMs = opts.dnsTimeoutMs || 4000
	const retries = opts.retries ?? 1
	const query = `${ip.split(".").reverse().join(".")}.${zone}`

	const attempt = async (attemptsLeft) => {
		try {
			const addresses = await withTimeout(dns.resolve4(query), timeoutMs)

			if (isResolverErrorCode(addresses)) {
				const reason = await dns
					.resolveTxt(query)
					.then((txt) => txt.flat().join(" "))
					.catch(() => null)
				return {
					ip,
					zone,
					listed: null, // neither true nor false — an access error, not a result
					error: `resolver_blocked: ${reason || addresses.join(",")}`,
					checkedAt: new Date().toISOString(),
				}
			}

			if (isOutsideDnsblRange(addresses)) {
				return {
					ip,
					zone,
					listed: null, // not a valid DNSBL answer — do NOT treat as a real hit
					error: `unexpected_response_range: ${addresses.join(",")}`,
					checkedAt: new Date().toISOString(),
				}
			}

			const reason = await dns
				.resolveTxt(query)
				.then((txt) => txt.flat().join(" "))
				.catch(() => null)
			return {
				ip,
				zone,
				listed: true,
				addresses,
				reason,
				checkedAt: new Date().toISOString(),
			}
		} catch (err) {
			if (err && (err.code === "ENOTFOUND" || err.code === "ENODATA")) {
				return { ip, zone, listed: false, checkedAt: new Date().toISOString() }
			}
			if (attemptsLeft > 0) return attempt(attemptsLeft - 1)
			return {
				ip,
				zone,
				listed: null,
				error: (err && (err.code || err.message)) || "unknown_error",
				checkedAt: new Date().toISOString(),
			}
		}
	}

	return attempt(retries)
}

// ====================================================================
// SCAN ALL SUBNETS AGAINST ALL ZONES (sequential, with delay)
// ====================================================================

const scanSubnets = async (options = {}) => {
	const cfg = getConfig()
	const subnets = options.subnets || cfg.subnets
	const zones = options.zones || cfg.dnsblZones
	const requestDelayMs = options.requestDelayMs ?? cfg.requestDelayMs
	const dnsTimeoutMs = options.dnsTimeoutMs || cfg.dnsTimeoutMs
	const retries = options.retries ?? cfg.retries
	const excludeReserved = options.excludeReserved ?? cfg.excludeReserved

	const ips = subnetsToIPs(subnets, { excludeReserved })
	const tasks = ips.flatMap((ip) => zones.map((zone) => [ip, zone]))
	const total = tasks.length
	let done = 0

	// options.onProgress(done, total, result) — optional callback so
	// you can see progress during a long scan instead of 10+ minutes
	// of silence.
	const results = await runSequentialWithDelay(
		tasks,
		requestDelayMs,
		async ([ip, zone]) => {
			const result = await checkDNSBL(ip, zone, { dnsTimeoutMs, retries })
			done += 1
			if (options.onProgress) options.onProgress(done, total, result)
			return result
		},
	)

	return {
		scannedAt: new Date().toISOString(),
		totalIps: ips.length,
		totalZones: zones.length,
		totalChecks: results.length,
		results,
	}
}

// ====================================================================
// SPAMHAUS DROP/EDROP — a list of "bad" NETWORKS (not individual IPs),
// free, no key required, officially allowed for automated download
// (see https://www.spamhaus.org/drop/). Spamhaus policy: no more than
// once per hour, once per day recommended — hence the local cache
// file, re-downloaded only once it's stale.
// ====================================================================

/**
 * Parses the drop.txt text format:
 *   "5.42.92.0/24 ; SBL625300"
 * Lines starting with ";" are comments and are skipped.
 */
const parseDropText = (text) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith(";"))
		.map((l) => {
			const [cidr, sblId] = l.split(";").map((s) => s.trim())
			return { cidr, sblId: sblId || null }
		})
		.filter((entry) => entry.cidr && entry.cidr.includes("/"))

/** Downloads drop.txt. Requires Node.js >= 18 (global fetch). */
const fetchDropListRaw = async (url) => {
	const resp = await fetch(url)
	if (!resp.ok) throw new Error(`http_${resp.status}`)
	return resp.text()
}

/**
 * Returns the DROP entries, using a local cache file. If the cache is
 * younger than maxAgeHours, reads from disk without touching the
 * network. If it's stale (or doesn't exist yet), downloads fresh and
 * updates the cache.
 */
const loadDropList = async (options = {}) => {
	const cfg = getConfig()
	const url = options.url || cfg.dropUrl
	const cacheFile = options.cacheFile || cfg.dropCacheFile
	const maxAgeHours = options.maxAgeHours ?? cfg.dropMaxAgeHours

	try {
		const stat = fs.statSync(cacheFile)
		const ageHours = (Date.now() - stat.mtimeMs) / 3600000
		if (ageHours < maxAgeHours) {
			return parseDropText(fs.readFileSync(cacheFile, "utf8"))
		}
	} catch (_) {
		// no cache yet — download for the first time
	}

	const text = await fetchDropListRaw(url)
	fs.writeFileSync(cacheFile, text)
	return parseDropText(text)
}

/** Checks a single IP against the DROP network list (no network I/O, pure logic). */
const checkAgainstDropEntries = (ip, dropEntries) => {
	const match = dropEntries.find((entry) => ipInCidr(ip, entry.cidr))
	return match
		? { ip, listed: true, cidr: match.cidr, sblId: match.sblId }
		: { ip, listed: false }
}

/**
 * Checks a list of IPs against Spamhaus DROP and shapes the result
 * the SAME way checkDNSBL() does — with zone:"spamhaus.DROP" — so
 * diffAgainstState() handles both uniformly, no separate logic needed.
 */
const scanDropList = async (ips, options = {}) => {
	const dropEntries = await loadDropList(options)
	const checkedAt = new Date().toISOString()
	const results = ips.map((ip) => {
		const r = checkAgainstDropEntries(ip, dropEntries)
		return {
			ip,
			zone: "spamhaus.DROP",
			listed: r.listed,
			reason: r.listed
				? `netblock ${r.cidr} (${r.sblId || "no SBL ID"})`
				: null,
			checkedAt,
		}
	})
	return { scannedAt: checkedAt, totalEntries: dropEntries.length, results }
}

// ====================================================================
// STATE (file) AND DIFF — this decides what's "new" and what isn't
// ====================================================================

const loadState = (stateFile) => {
	try {
		const raw = fs.readFileSync(stateFile, "utf8")
		if (!raw.trim()) return {} // file exists but is empty — treat as first run
		return JSON.parse(raw)
	} catch (err) {
		if (err.code === "ENOENT") return {} // no file yet — first run
		if (err instanceof SyntaxError) {
			// file is corrupted/invalid JSON (e.g. left empty after an
			// interrupted run) — don't crash the cycle, just start fresh
			console.warn(
				`State file "${stateFile}" is corrupted or empty, starting from a clean state.`,
			)
			return {}
		}
		throw err
	}
}

const saveState = (stateFile, state) => {
	const tmp = `${stateFile}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
	fs.renameSync(tmp, stateFile)
}

// ====================================================================
// PER-IP SUMMARY STATE ("is this IP a problem right now, yes/no")
// ====================================================================
// A single overall status per IP across ALL zones combined, kept in a
// SEPARATE json file from the per-zone history above. This answers
// "is 176.124.138.18 fine right now" in one lookup, and is what lets
// us send ONE "recovered" notification when an IP that used to be
// flagged becomes clean everywhere — even if individual zones flicker
// true/false/error across different cycles.

const loadSummaryState = (summaryFile) => {
	try {
		const raw = fs.readFileSync(summaryFile, "utf8")
		if (!raw.trim()) return {}
		return JSON.parse(raw)
	} catch (err) {
		if (err.code === "ENOENT") return {}
		if (err instanceof SyntaxError) {
			console.warn(
				`Summary file "${summaryFile}" is corrupted or empty, starting from a clean state.`,
			)
			return {}
		}
		throw err
	}
}

const saveSummaryState = (summaryFile, summary) => {
	const tmp = `${summaryFile}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(summary, null, 2))
	fs.renameSync(tmp, summaryFile)
}

/**
 * Groups all check results by IP and produces one summary entry per
 * IP: "problem" (listed on at least one zone this cycle) or "clean"
 * (checked and clean on every zone this cycle). If an IP had NO valid
 * (non-null) checks at all this cycle — e.g. every zone errored out —
 * its previous summary entry is carried over unchanged: a temporary
 * resolver error must never look like "got healed".
 *
 * Returns { nextSummary, healedIps }, where healedIps is the list of
 * IPs that were "problem" before this cycle and are "clean" now —
 * this is exactly what should trigger a recovery notification.
 */
const updateIpSummary = (prevSummary, allResults) => {
	const byIp = allResults.reduce((acc, r) => {
		if (r.listed === null) return acc // errors don't count either way
		const bucket = acc[r.ip] || []
		return { ...acc, [r.ip]: [...bucket, r] }
	}, {})

	const checkedAt = new Date().toISOString()

	const { nextSummary, healedIps } = Object.entries(byIp).reduce(
		(acc, [ip, results]) => {
			const listedOn = results.filter((r) => r.listed).map((r) => r.zone)
			const prevEntry = prevSummary[ip]
			const wasProblem = prevEntry && prevEntry.status === "problem"

			const entry =
				listedOn.length > 0
					? { status: "problem", zones: listedOn, lastCheckedAt: checkedAt }
					: { status: "clean", lastCheckedAt: checkedAt }

			const healed = wasProblem && entry.status === "clean"

			return {
				nextSummary: { ...acc.nextSummary, [ip]: entry },
				healedIps: healed
					? [...acc.healedIps, { ip, previousZones: prevEntry.zones || [] }]
					: acc.healedIps,
			}
		},
		{ nextSummary: {}, healedIps: [] },
	)

	// IPs not checked at all this cycle keep their previous entry as-is
	const finalSummary = Object.keys(prevSummary).reduce(
		(acc, ip) => (acc[ip] ? acc : { ...acc, [ip]: prevSummary[ip] }),
		nextSummary,
	)

	return { nextSummary: finalSummary, healedIps }
}

/**
 * One "recovered" message per healed IP, in English, naming the
 * zone(s) it used to be listed on — so the source of the original
 * problem stays visible even in the recovery notice. Existing
 * per-zone problem alerts (formatSingleNewListingLine etc.) are
 * untouched — this is an ADDITIONAL message type, not a replacement.
 */
const formatHealedLine = ({ ip, previousZones }) =>
	`✅ ${ip} has recovered — no longer listed on: ${previousZones.join(", ") || "unknown source"}`

/**
 * Compares the current scan results against the previous state.
 * Implemented via reduce (no loops/mutation), returns:
 *  - newListings      — became listed:true, weren't before. ALERT.
 *  - resolvedListings — were listed:true, are now clean.
 *  - stillListed      — were and still are listed:true (no repeat alert).
 *  - nextState        — for saveState().
 *
 * IMPORTANT: on the very first run (no state file existed yet), ALL
 * current listings will land in newListings — that's expected, not a
 * bug: the module simply didn't "know" about them before.
 * Checks with listed:null (DNS failure/timeout) don't participate in
 * the diff — their history key is carried over as-is, so a temporary
 * resolver failure never looks like "got delisted".
 */
const diffAgainstState = (prevState, scanResults) => {
	const initial = {
		newListings: [],
		resolvedListings: [],
		stillListed: [],
		nextState: {},
		seenKeys: new Set(),
	}

	const acc = scanResults.reduce((acc, r) => {
		if (r.listed === null) return acc

		const key = `${r.ip}|${r.zone}`
		const prev = prevState[key]
		const seenKeys = new Set(acc.seenKeys)
		seenKeys.add(key)

		if (r.listed) {
			const wasListed = prev && prev.listed
			const entry = wasListed
				? {
						...prev,
						listed: true,
						reason: r.reason || prev.reason || null,
						lastSeenAt: r.checkedAt,
					}
				: {
						listed: true,
						reason: r.reason || null,
						firstSeenAt: r.checkedAt,
						lastSeenAt: r.checkedAt,
					}

			return {
				...acc,
				newListings: wasListed ? acc.newListings : [...acc.newListings, r],
				stillListed: wasListed ? [...acc.stillListed, r] : acc.stillListed,
				nextState: { ...acc.nextState, [key]: entry },
				seenKeys,
			}
		}

		const resolvedNow = prev && prev.listed
		return {
			...acc,
			resolvedListings: resolvedNow
				? [
						...acc.resolvedListings,
						{
							ip: r.ip,
							zone: r.zone,
							resolvedAt: r.checkedAt,
							wasListedSince: prev.firstSeenAt,
						},
					]
				: acc.resolvedListings,
			nextState: {
				...acc.nextState,
				[key]: { listed: false, lastCheckedAt: r.checkedAt },
			},
			seenKeys,
		}
	}, initial)

	// keys from the previous state that weren't checked this time
	// (subnets/zones changed, or a DNS failure happened) — carried over as-is
	const nextState = Object.keys(prevState).reduce(
		(ns, key) =>
			acc.seenKeys.has(key) ? ns : { ...ns, [key]: prevState[key] },
		acc.nextState,
	)

	return {
		newListings: acc.newListings,
		resolvedListings: acc.resolvedListings,
		stillListed: acc.stillListed,
		nextState,
	}
}

// ====================================================================
// TELEGRAM TRIGGER (HTTP POST to the Bot API, token already in env)
// ====================================================================

const escapeForTelegram = (text) => text // plain text, no markup, no escaping needed

const formatNewListingsMessage = (newListings) => {
	if (!newListings.length) return null
	const lines = newListings.map(
		(r) => `⚠️ ${r.ip} → ${r.zone}${r.reason ? ` (${r.reason})` : ""}`,
	)
	return `🚨 New blacklist hits (${newListings.length}):\n${lines.join("\n")}`
}

const formatResolvedMessage = (resolvedListings) => {
	if (!resolvedListings.length) return null
	const lines = resolvedListings.map(
		(r) => `✅ ${r.ip} → ${r.zone} (listed since ${r.wasListedSince})`,
	)
	return `Delisted (${resolvedListings.length}):\n${lines.join("\n")}`
}

/**
 * Splits a long text into chunks no longer than maxLen characters,
 * trying to break on line boundaries (Telegram's limit is 4096 chars
 * per message; we use 3500 to leave headroom).
 */
const splitIntoChunks = (text, maxLen = 3500) =>
	text.split("\n").reduce((chunks, line) => {
		if (chunks.length === 0) return [line]
		const last = chunks[chunks.length - 1]
		return (last + "\n" + line).length <= maxLen
			? [...chunks.slice(0, -1), last + "\n" + line]
			: [...chunks, line]
	}, [])

/**
 * Sends ONE message to Telegram via the Bot API HTTP POST. Token and
 * chat_id come from env (getConfig) unless passed explicitly as the
 * second argument — handy for tests. Requires Node.js >= 18 (global
 * fetch).
 */
const sendTelegramMessage = async (text, { token, chatId } = {}) => {
	const cfg = getConfig()
	const botToken = token || cfg.telegramBotToken
	const chat = chatId || cfg.telegramChatId

	if (!botToken || !chat) {
		return { ok: false, skipped: true, reason: "no_telegram_config" }
	}

	const url = `https://api.telegram.org/bot${botToken}/sendMessage`

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chat,
				text: escapeForTelegram(text),
				disable_web_page_preview: true,
			}),
		})
		const data = await resp.json().catch(() => ({}))
		if (!resp.ok || data.ok === false) {
			return { ok: false, error: data.description || `http_${resp.status}` }
		}
		return { ok: true }
	} catch (err) {
		return { ok: false, error: err.message }
	}
}

/**
 * MAIN TRIGGER. Takes the result of diffAgainstState (or any object
 * with newListings/resolvedListings fields) and, if there's anything
 * to report, sends ONE SEPARATE TELEGRAM MESSAGE PER IP (not one
 * combined message), with a 2-second delay between each message — to
 * stay under the Telegram Bot API rate limit and to make sure each
 * hit is visible as its own notification rather than getting lost in
 * a wall of text.
 *
 * Example:
 *   const diff = diffAgainstState(prevState, scanResult.results);
 *   await triggerAlerts(diff);
 */
const formatSingleNewListingLine = (r) =>
	`⚠️ ${r.ip} → ${r.zone}${r.reason ? ` (${r.reason})` : ""}`

const formatSingleResolvedLine = (r) =>
	`✅ ${r.ip} → ${r.zone} (listed since ${r.wasListedSince})`

const triggerAlerts = async (
	{ newListings = [], resolvedListings = [] },
	options = {},
) => {
	const items = [
		...newListings.map((r) => formatSingleNewListingLine(r)),
		...resolvedListings.map((r) => formatSingleResolvedLine(r)),
	]

	if (items.length === 0) {
		return { sent: false, reason: "nothing_to_report" }
	}

	// 2000ms pause between EACH individual message (one IP at a time).
	const sendResults = await runSequentialWithDelay(
		items,
		2000,
		(text) => sendTelegramMessage(text, options),
	)

	return { sent: true, count: items.length, sendResults }
}

/**
 * If the scan hit resolver-blocked errors (see isResolverErrorCode
 * above), send ONE aggregated warning message instead of spamming the
 * chat with one message per affected IP — this is a resolver/infra
 * problem, not N separate blacklist incidents.
 */
const formatResolverBlockedWarning = (failedChecks) => {
	const blocked = failedChecks.filter(
		(r) => typeof r.error === "string" && r.error.startsWith("resolver_blocked"),
	)
	if (blocked.length === 0) return null

	const zones = [...new Set(blocked.map((r) => r.zone))]
	return (
		`⚠️ DNS resolver problem: ${blocked.length} check(s) across ${zones.join(", ")} ` +
		`were rejected as "public/open resolver" — these are NOT real blacklist hits, ` +
		`just blocked queries. Fix the resolver used by this server (see IPMON_DNS_SERVERS) ` +
		`to get real results.`
	)
}

/**
 * Sibling of formatResolverBlockedWarning: aggregates the NEW
 * "unexpected_response_range" errors (see isOutsideDnsblRange above)
 * into ONE warning message instead of silently dropping them or, worse,
 * alerting on them as real listings.
 */
const formatUnexpectedRangeWarning = (failedChecks) => {
	const unexpected = failedChecks.filter(
		(r) =>
			typeof r.error === "string" &&
			r.error.startsWith("unexpected_response_range"),
	)
	if (unexpected.length === 0) return null

	const zones = [...new Set(unexpected.map((r) => r.zone))]
	return (
		`⚠️ DNS returned an address outside the normal 127.0.0.0/8 DNSBL range for ` +
		`${unexpected.length} check(s) across ${zones.join(", ")} — treated as an ` +
		`inconclusive error, NOT a real listing (likely a hijacked resolver or a ` +
		`broken/misconfigured zone).`
	)
}

/**
 * Guard against a zone that suddenly comes back "listed" for a much
 * larger share of checked IPs than any real-world DNSBL incident would
 * produce — the signature of a broken/misconfigured source (wildcard
 * DNS, wrong hostname, unauthorized-query behavior, etc.) rather than
 * an actual wave of new blacklistings. Pure function: given this
 * cycle's raw results, returns the zones that look suspicious plus
 * their stats — it does NOT mutate or filter anything itself.
 *
 * minChecks guards against noise on tiny scans (a single /28 subnet
 * hitting 2/3 listed is not the same signal as 300/500).
 */
const detectSuspiciousZones = (
	results,
	{ threshold = 0.15, minChecks = 10 } = {},
) => {
	const byZone = results.reduce((acc, r) => {
		if (r.listed === null) return acc
		const bucket = acc[r.zone] || { total: 0, listed: 0 }
		return {
			...acc,
			[r.zone]: {
				total: bucket.total + 1,
				listed: bucket.listed + (r.listed ? 1 : 0),
			},
		}
	}, {})

	return Object.entries(byZone)
		.map(([zone, stats]) => ({ zone, ...stats, ratio: stats.listed / stats.total }))
		.filter((s) => s.total >= minChecks && s.ratio > threshold)
}

/**
 * Given the zones flagged by detectSuspiciousZones, returns a NEW
 * results array where entries from those zones have listed forced to
 * null (with an explanatory error) — same shape everything else in
 * this file already knows how to skip (diffAgainstState,
 * updateIpSummary both ignore listed:null). This means a suspicious
 * zone's hits never reach newListings, never get alerted per-IP, and
 * never get written into state as real listings — without touching
 * any of that existing, already-working logic.
 */
const quarantineSuspiciousZones = (results, suspiciousZones) => {
	const suspiciousZoneNames = new Set(suspiciousZones.map((s) => s.zone))
	if (suspiciousZoneNames.size === 0) return results

	return results.map((r) =>
		suspiciousZoneNames.has(r.zone) && r.listed !== null
			? {
					...r,
					listed: null,
					error: `zone_suspicious: ${r.zone} listed an unusually high share of checked IPs this cycle`,
				}
			: r,
	)
}

const formatSuspiciousZoneWarning = (suspiciousZones) => {
	if (suspiciousZones.length === 0) return null
	const lines = suspiciousZones.map(
		(s) =>
			`${s.zone}: ${s.listed}/${s.total} (${Math.round(s.ratio * 100)}%)`,
	)
	return (
		`🚨 Suspicious DNSBL source this cycle — listed an unusually high share of ` +
		`checked IPs, quarantined and NOT alerted as real hits:\n${lines.join("\n")}\n` +
		`This usually means the zone/hostname is wrong or broken, not a real incident. ` +
		`Verify manually before trusting it again.`
	)
}

// ====================================================================
// AbuseIPDB — FULLY OPTIONAL, DOES NOTHING WITHOUT A KEY.
// No paid token is required for the module as a whole — this is an
// extra capability "in case you ever need it".
// ====================================================================

const checkAbuseIPDB = async (ip, apiKey, { threshold = 25 } = {}) => {
	if (!apiKey) return { ip, skipped: true, reason: "no_api_key" }

	const url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`

	try {
		const resp = await fetch(url, {
			headers: { Key: apiKey, Accept: "application/json" },
		})
		if (!resp.ok)
			return {
				ip,
				error: `http_${resp.status}`,
				checkedAt: new Date().toISOString(),
			}
		const data = await resp.json()
		const score = data?.data?.abuseConfidenceScore ?? 0
		return {
			ip,
			listed: score >= threshold,
			score,
			totalReports: data?.data?.totalReports ?? 0,
			isTor: data?.data?.isTor ?? false,
			usageType: data?.data?.usageType ?? null,
			checkedAt: new Date().toISOString(),
		}
	} catch (err) {
		return { ip, error: err.message, checkedAt: new Date().toISOString() }
	}
}

const scanAbuseIPDB = async (ips, options = {}) => {
	const cfg = getConfig()
	const apiKey = options.apiKey || cfg.abuseIpDbKey
	if (!apiKey) return { skipped: true, reason: "no_api_key", results: [] }

	const delayMs = options.delayMs ?? cfg.abuseIpDbDelayMs
	const threshold = options.threshold || cfg.abuseIpDbThreshold

	const results = await runSequentialWithDelay(ips, delayMs, (ip) =>
		checkAbuseIPDB(ip, apiKey, { threshold }),
	)

	return { scannedAt: new Date().toISOString(), results }
}

// ====================================================================
// MAIN ENTRY POINT FOR YOUR SCHEDULER
// ====================================================================

/**
 * One full cycle: scan -> diff -> save state -> telegram.
 * Call this on a schedule (every 1-2 hours) from your own scheduler.
 */
const runMonitoringCycle = async (overrides = {}) => {
	const cfg = getConfig()
	const stateFile = overrides.stateFile || cfg.stateFile
	const excludeReserved = overrides.excludeReserved ?? cfg.excludeReserved

	const scan = await scanSubnets(overrides)

	// Guard against a broken/misconfigured DNSBL source before it ever
	// reaches the diff/alert logic below — see detectSuspiciousZones().
	const suspiciousZoneThreshold =
		overrides.zoneSuspiciousThreshold ?? cfg.zoneSuspiciousThreshold
	const suspiciousZoneMinChecks =
		overrides.zoneSuspiciousMinChecks ?? cfg.zoneSuspiciousMinChecks
	const suspiciousZones = detectSuspiciousZones(scan.results, {
		threshold: suspiciousZoneThreshold,
		minChecks: suspiciousZoneMinChecks,
	})
	const safeDnsblResults = quarantineSuspiciousZones(scan.results, suspiciousZones)

	// Spamhaus DROP — the same IPs as scanSubnets, but checked
	// differently (CIDR membership, not a DNS query). If the download
	// fails (network/site unavailable), don't crash the whole cycle —
	// just record dropError and continue without those results.
	let dropResults = []
	let dropError = null
	if (cfg.dropEnabled) {
		try {
			const ips = subnetsToIPs(overrides.subnets || cfg.subnets, {
				excludeReserved,
			})
			const dropScan = await scanDropList(ips)
			dropResults = dropScan.results
		} catch (err) {
			dropError = err.message
		}
	}

	const allResults = [...safeDnsblResults, ...dropResults]

	const prevState = loadState(stateFile)
	const diff = diffAgainstState(prevState, allResults)

	saveState(stateFile, diff.nextState)

	// Second, separate json: one overall status per IP + "recovered"
	// notification when an IP that was previously flagged becomes
	// clean everywhere. Independent from the per-zone diff above.
	const summaryFile = overrides.summaryFile || cfg.summaryFile
	const prevSummary = loadSummaryState(summaryFile)
	const { nextSummary, healedIps } = updateIpSummary(prevSummary, allResults)
	saveSummaryState(summaryFile, nextSummary)

	const failedChecks = allResults.filter((r) => r.listed === null)

	let telegramResult = null
	let resolverWarningResult = null
	let suspiciousZoneWarningResult = null
	let healedResult = null
	if (cfg.telegramAutoSend) {
		telegramResult = await triggerAlerts(diff)

		const resolverWarning = formatResolverBlockedWarning(failedChecks)
		if (resolverWarning) {
			resolverWarningResult = await sendTelegramMessage(resolverWarning)
		}

		const unexpectedRangeWarning = formatUnexpectedRangeWarning(failedChecks)
		if (unexpectedRangeWarning) {
			await sendTelegramMessage(unexpectedRangeWarning)
		}

		const suspiciousZoneWarning = formatSuspiciousZoneWarning(suspiciousZones)
		if (suspiciousZoneWarning) {
			suspiciousZoneWarningResult = await sendTelegramMessage(suspiciousZoneWarning)
		}

		if (healedIps.length > 0) {
			const lines = healedIps.map(formatHealedLine)
			healedResult = {
				sent: true,
				count: lines.length,
				sendResults: await runSequentialWithDelay(lines, 2000, (text) =>
					sendTelegramMessage(text),
				),
			}
		}
	}

	// AbuseIPDB — runs ONLY if a key is explicitly set in env.
	// Without a key (your default case) it's simply skipped:true.
	const abuseIpDb = cfg.abuseIpDbKey
		? await scanAbuseIPDB([...new Set(diff.newListings.map((r) => r.ip))])
		: { skipped: true, reason: "no_api_key" }

	return {
		scannedAt: scan.scannedAt,
		totalIps: scan.totalIps,
		totalZones: scan.totalZones,
		totalChecks: scan.totalChecks + dropResults.length,
		newListings: diff.newListings,
		resolvedListings: diff.resolvedListings,
		stillListed: diff.stillListed,
		failedChecks,
		dropError,
		telegramResult,
		resolverWarningResult,
		suspiciousZones,
		suspiciousZoneWarningResult,
		healedIps,
		healedResult,
		abuseIpDb,
	}
}

// ====================================================================
// EXPORTS (functions and constants only, no class)
// ====================================================================

module.exports = {
	getConfig,
	cidrToIPs,
	subnetsToIPs,
	ipInCidr,
	checkDNSBL,
	scanSubnets,
	loadDropList,
	checkAgainstDropEntries,
	scanDropList,
	loadState,
	saveState,
	loadSummaryState,
	saveSummaryState,
	updateIpSummary,
	formatHealedLine,
	diffAgainstState,
	formatNewListingsMessage,
	formatResolvedMessage,
	formatResolverBlockedWarning,
	formatUnexpectedRangeWarning,
	detectSuspiciousZones,
	quarantineSuspiciousZones,
	formatSuspiciousZoneWarning,
	splitIntoChunks,
	sendTelegramMessage,
	triggerAlerts,
	checkAbuseIPDB,
	scanAbuseIPDB,
	runMonitoringCycle,
	DEFAULT_DNSBL_ZONES,
}

/**
 * ====================================================================
 * USAGE EXAMPLE (comment only, not executed)
 * ====================================================================
 *
 * const { runMonitoringCycle } = require('./ip-blacklist-monitor');
 *
 * async function tick() {
 *   const summary = await runMonitoringCycle();
 *   console.log(`Checked ${summary.totalChecks} IP/zone combinations`);
 *   console.log(`New hits: ${summary.newListings.length}`);
 *   if (summary.failedChecks.length > 20) {
 *     // many failures in a row — resolver might be blocked/unreachable
 *     console.warn('Many failed checks:', summary.failedChecks.length);
 *   }
 * }
 *
 * // once an hour:
 * // const cron = require('node-cron');
 * // cron.schedule('0 * * * *', tick);
 *
 * // once every 2 hours:
 * // cron.schedule('0 *\/2 * * *', tick);
 * ====================================================================
 */
