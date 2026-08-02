"use strict"

/**
 * ip-blacklist-monitor.js
 * ------------------------------------------------------------------
 * Functional module (without class/this/prototypes) for monitoring IPs from your subnets against DNSBL/RBL and sending alerts about NEW incidents to Telegram via Bot API (HTTP POST). 
 *
 *  1) subnetsToIPs()  — expand the list of CIDR (you can specify
 *     small /28, /27, etc., to avoid querying empty addresses) into
 *     a flat list of IPs.
 *  2) scanSubnets()   — sequentially (not in parallel!) query
 *     each IP against each DNSBL zone with a fixed delay between
 *     requests (IPMON_REQUEST_DELAY_MS). No worker pool —
 *     just a single queue and sleep().
 *  3) diffAgainstState() — compare the result with the state saved on
 *     disk and get newListings (what was not there last time) and resolvedListings (what has been delisted).
 *  4) triggerAlerts()  — if newListings/resolvedListings are not empty,
 *     format the text and send it to the Telegram group via HTTP POST.
 *  5) runMonitoringCycle() — puts everything together, this is the only
 *     function you call on a schedule (cron / systemd
 *     timer / your monitoring system). There is no setInterval/cron inside the module.
 *
 * AbuseIPDB-check is left in the file as a FULLY optional
 * piece: without a key in env it simply does not run. No paid
 * tokens are required for the module to work — all the main logic
 * works only on free DNS queries to DNSBL zones.
 * ------------------------------------------------------------------
 */

const dns = require("dns").promises
const fs = require("fs")
const path = require("path")

// IMPORTANT: DO NOT set public resolvers here (1.1.1.1, 8.8.8.8, 9.9.9.9
// etc.) via dns.setServers(). Spamhaus (zen.spamhaus.org) intentionally
// blocks requests coming through public DNS resolvers, and instead of
// the real response returns the code 127.255.255.254 — because of this ALL your IPs
// would be falsely considered banned. Use the system resolver of the server
// (usually your hoster/ISP resolver) — it is free, without registration,
// without time limits, and Spamhaus does not block it.


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
	// Networks list. /24 и /23, or
	// /28 (255.255.255.240) / /27 (255.255.255.224) — to avoid querying empty addresses.
	subnets: splitEnvList(
		process.env.IPMON_SUBNETS,
		"91.220.106.0/24,176.124.138.0/23",
	),

	dnsblZones: splitEnvList(
		process.env.IPMON_DNSBL_ZONES,
		DEFAULT_DNSBL_ZONES.join(","),
	),

	requestDelayMs: parseInt(process.env.IPMON_REQUEST_DELAY_MS || "200", 10),

	dnsTimeoutMs: parseInt(process.env.IPMON_DNS_TIMEOUT_MS || "4000", 10),
	retries: parseInt(process.env.IPMON_RETRIES || "1", 10),
	excludeReserved: (process.env.IPMON_EXCLUDE_RESERVED || "true") === "true",

	stateFile:
		process.env.IPMON_STATE_FILE ||
		path.join(__dirname, "../../data/dnsbl-state.json"),

	// --- Telegram ---
	telegramBotToken: process.env.IPMON_TELEGRAM_BOT_TOKEN || "",
	telegramChatId: process.env.IPMON_TELEGRAM_CHAT_ID || "",
	telegramAutoSend: (process.env.IPMON_TELEGRAM_AUTOSEND || "true") === "true",

	// --- Spamhaus DROP/EDROP (free, no key required, officially allowed for automatic
	// download by Spamhaus — their rule: no more than once per hour,
	// recommended once per day; therefore we use a local cache file) ---
	dropEnabled: (process.env.IPMON_DROP_ENABLED || "true") === "true",
	dropUrl:
		process.env.IPMON_DROP_URL || "https://www.spamhaus.org/drop/drop.txt",
	dropCacheFile:
		process.env.IPMON_DROP_CACHE_FILE ||
		path.join(__dirname, "../../data/spamhaus-drop-cache.txt"),
	dropMaxAgeHours: parseInt(process.env.IPMON_DROP_MAX_AGE_HOURS || "24", 10),

	// --- AbuseIPDB (полностью опционально, без ключа не используется) ---
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
		throw new Error(`Некорректный CIDR: "${cidr}"`)
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
 * Checks if a specific IP falls within a CIDR range.
 * Needed for lists like Spamhaus DROP, where not individual IPs are published,
 * but entire "bad" networks (e.g., "5.42.92.0/24") — you can't just resolve DNS,
 * you need to check the range yourself.
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
 * Executes fn(item) for each item SEQUENTIALLY (not in parallel),
 * with a delay of delayMs after each call. This is the "dumb interval between requests"
 * that you asked for — simple and predictable in terms of load.
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
// CHECKING A SINGLE IP AGAINST A SINGLE DNSBL ZONE
// ====================================================================

const checkDNSBL = async (ip, zone, opts = {}) => {
	const timeoutMs = opts.dnsTimeoutMs || 4000
	const retries = opts.retries ?? 1
	const query = `${ip.split(".").reverse().join(".")}.${zone}`

	const attempt = async (attemptsLeft) => {
		try {
			const addresses = await withTimeout(dns.resolve4(query), timeoutMs)
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
// SCANNING ALL SUBNETS AGAINST ALL ZONES (sequentially, with a delay)
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

	// options.onProgress(done, total) — optional callback to track
	// progress during a long scan instead of silence for 10+ minutes.
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
// SPAMHAUS DROP/EDROP — list of "bad" NETWORKS (not individual IPs),
// free, no key required, officially allowed for automatic
// download (see https://www.spamhaus.org/drop/). Spamhaus rule:
// do not download more than once per hour, preferably once per day — therefore we cache
// to a file and download again only when the cache is outdated.
// ====================================================================

/**
 * Parses the text format of drop.txt:
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
 * Returns the list of DROP entries, using a local cache file. If the cache
 * is younger than maxAgeHours — reads from the file, without going to the network. If
 * it is outdated (or the file does not exist yet) — downloads again and updates the cache.
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
		// cache does not exist yet — download for the first time
	}

	const text = await fetchDropListRaw(url)
	fs.writeFileSync(cacheFile, text)
	return parseDropText(text)
}

const checkAgainstDropEntries = (ip, dropEntries) => {
	const match = dropEntries.find((entry) => ipInCidr(ip, entry.cidr))
	return match
		? { ip, listed: true, cidr: match.cidr, sblId: match.sblId }
		: { ip, listed: false }
}

/**
 * Checks a list of IPs against the Spamhaus DROP and returns
 * the result in THE SAME format as checkDNSBL() — with the field
 * zone:"spamhaus.DROP" — so that diffAgainstState() handles them
 * the same way, without separate logic.
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
				? `netblock ${r.cidr} (${r.sblId || "без SBL ID"})`
				: null,
			checkedAt,
		}
	})
	return { scannedAt: checkedAt, totalEntries: dropEntries.length, results }
}

// ====================================================================
// STATE (file) AND DIFF — here we determine what is "new" and what is not
// ====================================================================

const loadState = (stateFile) => {
	try {
		const raw = fs.readFileSync(stateFile, "utf8")
		if (!raw.trim()) return {} // файл существует, но пустой — как первый запуск
		return JSON.parse(raw)
	} catch (err) {
		if (err.code === "ENOENT") return {} // файла ещё нет — первый запуск
		if (err instanceof SyntaxError) {
			// файл повреждён/не валидный JSON (например, остался пустым после
			// прерванного запуска) — не роняем цикл, просто начинаем заново
			console.warn(
				`Файл состояния "${stateFile}" повреждён или пуст, начинаю с чистого состояния.`,
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

/**
 * Compares the current scan results with the previous state.
 * Implemented using reduce (no loops/mutation), returns:
 *  - newListings      — became listed:true, were not before. ALERT.
 *  - resolvedListings — were listed:true, now clean.
 *  - stillListed      — were and remain listed:true (no repeated alert).
 *  - nextState        — for saveState().
 *
 * IMPORTANT: if this is the very first run (no state file exists),
 * ALL current hits will appear in newListings — this is expected, not
 * a bug: the module did not know about them "before".
 * Checks with listed:null (DNS failure/timeout) do not participate in the diff —
 * the history for such a key is simply carried over as is, so that
 * a temporary resolver failure does not look like "resolved".
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

	// ключи из прошлого состояния, которые в этот раз не проверялись
	// (сменили список подсетей/зон или был сбой DNS) — переносим как есть
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
// TELEGRAM TRIGGER (HTTP POST to Bot API, token already in env)
// ====================================================================

const escapeForTelegram = (text) => text // используем обычный текст без разметки, спецсимволы не нужно экранировать

const formatNewListingsMessage = (newListings) => {
	if (!newListings.length) return null
	const lines = newListings.map(
		(r) => `⚠️ ${r.ip} → ${r.zone}${r.reason ? ` (${r.reason})` : ""}`,
	)
	return `🚨 Новые попадания в блэклисты (${newListings.length}):\n${lines.join("\n")}`
}

const formatResolvedMessage = (resolvedListings) => {
	if (!resolvedListings.length) return null
	const lines = resolvedListings.map(
		(r) => `✅ ${r.ip} → ${r.zone} (был в списке с ${r.wasListedSince})`,
	)
	return `Разлистились (${resolvedListings.length}):\n${lines.join("\n")}`
}

/**
 * Splits a long text into chunks no longer than maxLen characters, trying
 * to split on line boundaries (Telegram has a limit of 4096 characters per
 * message, we take 3500 to be safe).
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
 * Sends ONE message to Telegram via Bot API HTTP POST.
 * The token and chat_id are taken from env (getConfig), or can be passed
 * explicitly as the second argument — convenient for tests.
 * Requires Node.js >= 18 (global fetch).
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
 * MAIN TRIGGER. Accepts the result of diffAgainstState (or an object
 * with newListings/resolvedListings) and, if there is something to report,
 * sends a SEPARATE MESSAGE TO TELEGRAM FOR EACH IP (not a single combined
 * message), with a 2-second pause between each message — to avoid hitting
 * the Telegram Bot API rate limit and to ensure each hit is visible as a
 * separate notification, rather than getting lost in the general block.
 *
 * Пример:
 *   const diff = diffAgainstState(prevState, scanResult.results);
 *   await triggerAlerts(diff);
 */
const formatSingleNewListingLine = (r) =>
	`⚠️ ${r.ip} → ${r.zone}${r.reason ? ` (${r.reason})` : ""}`

const formatSingleResolvedLine = (r) =>
	`✅ ${r.ip} → ${r.zone} (был в списке с ${r.wasListedSince})`

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

	// Пауза 2000мс между КАЖДЫМ отдельным сообщением (по одному IP за раз).
	const sendResults = await runSequentialWithDelay(
		items,
		2000,
		(text) => sendTelegramMessage(text, options),
	)

	return { sent: true, count: items.length, sendResults }
}

// ====================================================================
// AbuseIPDB — FULLY OPTIONAL, DOES NOT WORK WITHOUT A KEY.
// No paid token is required for the module to work in general —
// this is an additional feature "if needed".
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
// MAIN FUNCTION FOR INTEGRATION INTO THE MONITORING SYSTEM
// ====================================================================

/**
 * Один полный цикл: скан -> дифф -> сохранение состояния -> телеграм.
 * Вызывайте её по расписанию (раз в 1-2 часа) из вашей системы.
 */
const runMonitoringCycle = async (overrides = {}) => {
	const cfg = getConfig()
	const stateFile = overrides.stateFile || cfg.stateFile
	const excludeReserved = overrides.excludeReserved ?? cfg.excludeReserved

	const scan = await scanSubnets(overrides)

	// Spamhaus DROP — the same IPs as in scanSubnets, but the check
	// is done differently (CIDR inclusion, not a DNS query). If downloading
	// the list fails (network/site unavailable) — we do not break the whole cycle,
	// just mark dropError and continue without these results.
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

	const allResults = [...scan.results, ...dropResults]

	const prevState = loadState(stateFile)
	const diff = diffAgainstState(prevState, allResults)

	saveState(stateFile, diff.nextState)

	let telegramResult = null
	if (cfg.telegramAutoSend) {
		telegramResult = await triggerAlerts(diff)
	}

	// AbuseIPDB — executed ONLY if an API key is explicitly set in env.
	// If there is no key (your default case) — just skipped:true.
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
		failedChecks: allResults.filter((r) => r.listed === null),
		dropError,
		telegramResult,
		abuseIpDb,
	}
}

// ====================================================================
// EXPORT (only functions and constants, no class)
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
	diffAgainstState,
	formatNewListingsMessage,
	formatResolvedMessage,
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
 * EXAMPLE USAGE (comment, does not execute)
 * ====================================================================
 *
 * const { runMonitoringCycle } = require('./ip-blacklist-monitor');
 *
 * async function tick() {
 *   const summary = await runMonitoringCycle();
 *   console.log(`Checked ${summary.totalChecks} IP/zones`);
 *   console.log(`New listings: ${summary.newListings.length}`);
 *   if (summary.failedChecks.length > 20) {
 *      console.warn('So many failed checks:', summary.failedChecks.length);
 *   }
 * }
 *
 * ====================================================================
 */
