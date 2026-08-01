"use strict"

/**
 * ip-blacklist-monitor.js
 * ------------------------------------------------------------------
 * ЧИСТО ФУНКЦИОНАЛЬНЫЙ модуль (без class/this/прототипов) для
 * мониторинга попадания IP из ваших подсетей в DNSBL/RBL и
 * оповещения о НОВЫХ инцидентах в Telegram через Bot API (HTTP POST).
 *
 * Логика в двух словах:
 *  1) subnetsToIPs()  — разворачиваем список CIDR (можно указывать
 *     маленькие /28, /27 и т.п., чтобы не гонять пустые адреса) в
 *     плоский список IP.
 *  2) scanSubnets()   — последовательно (не параллельно!) опрашиваем
 *     каждый IP по каждой DNSBL-зоне с фиксированной паузой между
 *     запросами (IPMON_REQUEST_DELAY_MS). Никакого пула воркеров —
 *     просто одна очередь и sleep().
 *  3) diffAgainstState() — сравниваем результат с сохранённым на
 *     диске состоянием и получаем newListings (то, чего не было
 *     в прошлый раз) и resolvedListings (то, что разлистилось).
 *  4) triggerAlerts()  — если newListings/resolvedListings не пустые,
 *     формируем текст и шлём в Telegram-группу через HTTP POST.
 *  5) runMonitoringCycle() — склеивает всё вместе, это единственная
 *     функция, которую вы вызываете по расписанию (cron / systemd
 *     timer / ваша система мониторинга). Внутри модуля никакого
 *     setInterval/cron нет.
 *
 * AbuseIPDB-проверка оставлена в файле как ПОЛНОСТЬЮ опциональный
 * кусок: без ключа в env она просто не выполняется. Никаких платных
 * токенов для работы модуля не требуется — вся основная логика
 * работает только на бесплатных DNS-запросах к DNSBL-зонам.
 * ------------------------------------------------------------------
 */

const dns = require("dns").promises
const fs = require("fs")
const path = require("path")

// ====================================================================
// КОНФИГУРАЦИЯ ИЗ ENV (чистая функция без побочных эффектов на вход)
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
	// Список подсетей. Можно указывать И большие /24 и /23, И маленькие
	// /28 (255.255.255.240) / /27 (255.255.255.224) — если вы знаете,
	// какие конкретные блоки реально заняты абонентами, просто
	// перечислите их здесь через запятую, а не весь /24 или /23 целиком.
	subnets: splitEnvList(
		process.env.IPMON_SUBNETS,
		"91.220.106.0/24,176.124.138.0/23",
	),

	dnsblZones: splitEnvList(
		process.env.IPMON_DNSBL_ZONES,
		DEFAULT_DNSBL_ZONES.join(","),
	),

	// Пауза между КАЖДЫМ отдельным DNS-запросом, мс. Это единственный
	// регулятор нагрузки — без всякого concurrency-пула.
	requestDelayMs: parseInt(process.env.IPMON_REQUEST_DELAY_MS || "200", 10),

	dnsTimeoutMs: parseInt(process.env.IPMON_DNS_TIMEOUT_MS || "4000", 10),
	retries: parseInt(process.env.IPMON_RETRIES || "1", 10),
	excludeReserved: (process.env.IPMON_EXCLUDE_RESERVED || "true") === "true",

	// Дефолт рассчитан на размещение файла модуля по пути
	// src/server/modules/ip-blacklist-monitor/monitor.js — тогда
	// ../../data/ указывает на src/server/data/. Если ваш модуль лежит
	// в другом месте — просто задайте IPMON_STATE_FILE в .env явно,
	// он всегда имеет приоритет над этим дефолтом.
	stateFile:
		process.env.IPMON_STATE_FILE ||
		path.join(__dirname, "../../data/dnsbl-state.json"),

	// --- Telegram ---
	telegramBotToken: process.env.IPMON_TELEGRAM_BOT_TOKEN || "",
	telegramChatId: process.env.IPMON_TELEGRAM_CHAT_ID || "",
	telegramAutoSend: (process.env.IPMON_TELEGRAM_AUTOSEND || "true") === "true",

	// --- Spamhaus DROP/EDROP (бесплатно, без ключа, разрешено к автоматическому
	// скачиванию самой Spamhaus — их условие: не чаще 1 раза в час,
	// рекомендуют раз в сутки; поэтому используем локальный кэш-файл) ---
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
// CIDR -> список IP (чистые функции)
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
 * Проверяет, попадает ли конкретный IP в CIDR-диапазон.
 * Нужна для списков типа Spamhaus DROP, где публикуются не отдельные
 * IP, а целые "плохие" сети (например, "5.42.92.0/24") — там нельзя
 * просто резолвить DNS, нужно самим проверить вхождение в диапазон.
 */
const ipInCidr = (ip, cidr) => {
	const [netIpPart, bitsPart] = cidr.split("/")
	const bits = parseInt(bitsPart, 10)
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
	return (ipToLong(ip) & mask) === (ipToLong(netIpPart) & mask)
}

// ====================================================================
// ПОСЛЕДОВАТЕЛЬНЫЙ ЗАПУСК С ПАУЗОЙ (вместо пула воркеров)
// ====================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Выполняет fn(item) для каждого item ПО ОЧЕРЕДИ (не параллельно),
 * с паузой delayMs после каждого вызова. Именно это и есть тот самый
 * "тупой интервал между запросами", который вы просили — просто и
 * предсказуемо по нагрузке.
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
// ПРОВЕРКА ОДНОГО IP ПО ОДНОЙ DNSBL-ЗОНЕ
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
// СКАНИРОВАНИЕ ВСЕХ ПОДСЕТЕЙ ПО ВСЕМ ЗОНАМ (последовательно, с паузой)
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

	const results = await runSequentialWithDelay(
		tasks,
		requestDelayMs,
		([ip, zone]) => checkDNSBL(ip, zone, { dnsTimeoutMs, retries }),
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
// SPAMHAUS DROP/EDROP — список "плохих" СЕТЕЙ (не отдельных IP),
// бесплатный, без ключа, официально разрешён к автоматическому
// скачиванию (см. https://www.spamhaus.org/drop/). Правило Spamhaus:
// не скачивать чаще 1 раза в час, лучше раз в сутки — поэтому кэшируем
// в файл и качаем заново только когда кэш устарел.
// ====================================================================

/**
 * Разбирает текстовый формат drop.txt:
 *   "5.42.92.0/24 ; SBL625300"
 * Строки, начинающиеся с ";", — комментарии, пропускаем.
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

/** Скачивает drop.txt. Требует Node.js >= 18 (глобальный fetch). */
const fetchDropListRaw = async (url) => {
	const resp = await fetch(url)
	if (!resp.ok) throw new Error(`http_${resp.status}`)
	return resp.text()
}

/**
 * Отдаёт список DROP-записей, используя локальный кэш-файл. Если кэш
 * младше maxAgeHours — читает из файла, без похода в сеть. Если
 * устарел (или файла ещё нет) — скачивает заново и обновляет кэш.
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
		// кэша ещё нет — качаем в первый раз
	}

	const text = await fetchDropListRaw(url)
	fs.writeFileSync(cacheFile, text)
	return parseDropText(text)
}

/** Проверяет один IP на вхождение в список DROP-сетей (без сети, чистая логика). */
const checkAgainstDropEntries = (ip, dropEntries) => {
	const match = dropEntries.find((entry) => ipInCidr(ip, entry.cidr))
	return match
		? { ip, listed: true, cidr: match.cidr, sblId: match.sblId }
		: { ip, listed: false }
}

/**
 * Проверяет список IP на вхождение в Spamhaus DROP и приводит
 * результат к ТОЙ ЖЕ форме, что возвращает checkDNSBL() — с полем
 * zone:"spamhaus.DROP" — чтобы diffAgainstState() отработал их
 * одинаково, без отдельной логики.
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
// СОСТОЯНИЕ (файл) И DIFF — тут решается, что "новое", а что не новое
// ====================================================================

const loadState = (stateFile) => {
	try {
		return JSON.parse(fs.readFileSync(stateFile, "utf8"))
	} catch (err) {
		if (err.code === "ENOENT") return {} // первый запуск
		throw err
	}
}

const saveState = (stateFile, state) => {
	const tmp = `${stateFile}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
	fs.renameSync(tmp, stateFile)
}

/**
 * Сравнивает текущие результаты скана с прошлым состоянием.
 * Реализовано через reduce (без циклов/мутации), возвращает:
 *  - newListings      — стали listed:true, раньше не были. АЛЕРТ.
 *  - resolvedListings — были listed:true, теперь чисты.
 *  - stillListed      — были и остаются listed:true (без повторного алерта).
 *  - nextState        — для saveState().
 *
 * ВАЖНО: если это самый первый запуск (файла состояния не было),
 * ВСЕ текущие попадания попадут в newListings — это ожидаемо, а не
 * баг: модуль ещё не знал про них "раньше".
 * Проверки с listed:null (сбой DNS/таймаут) в диффе не участвуют —
 * история по такому ключу просто переносится как есть, чтобы
 * временный сбой резолвера не выглядел как "разлистился".
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
// TELEGRAM-ТРИГГЕР (HTTP POST в Bot API, токен уже в env)
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
 * Режем длинный текст на части не больше maxLen символов, стараясь
 * резать по границам строк (у Telegram лимит 4096 символов на
 * сообщение, берём с запасом 3500).
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
 * Отправляет ОДНО сообщение в Telegram через Bot API HTTP POST.
 * Токен и chat_id берутся из env (getConfig), либо можно передать
 * явно вторым аргументом — удобно для тестов.
 * Требует Node.js >= 18 (глобальный fetch).
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
 * ГЛАВНЫЙ ТРИГГЕР. Принимает результат diffAgainstState (или объект
 * с полями newListings/resolvedListings) и, если есть что сообщать,
 * шлёт сообщение(я) в Telegram. Именно эту функцию вызывайте из
 * своей системы мониторинга сразу после скана/диффа.
 *
 * Пример:
 *   const diff = diffAgainstState(prevState, scanResult.results);
 *   await triggerAlerts(diff);
 */
const triggerAlerts = async (
	{ newListings = [], resolvedListings = [] },
	options = {},
) => {
	const parts = [
		formatNewListingsMessage(newListings),
		formatResolvedMessage(resolvedListings),
	].filter(Boolean)

	if (parts.length === 0) {
		return { sent: false, reason: "nothing_to_report" }
	}

	const chunks = splitIntoChunks(parts.join("\n\n"))

	const sendResults = await runSequentialWithDelay(
		chunks,
		500, // небольшая пауза между частями одного алерта
		(chunk) => sendTelegramMessage(chunk, options),
	)

	return { sent: true, chunks: chunks.length, sendResults }
}

// ====================================================================
// AbuseIPDB — ПОЛНОСТЬЮ ОПЦИОНАЛЬНО, БЕЗ КЛЮЧА ПРОСТО НЕ РАБОТАЕТ.
// Никакой платный токен не требуется для работы модуля в целом —
// это дополнительная возможность "если вдруг понадобится".
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
// ГЛАВНАЯ ФУНКЦИЯ ДЛЯ ВСТРАИВАНИЯ В СИСТЕМУ МОНИТОРИНГА
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

	// Spamhaus DROP — те же самые IP, что и в scanSubnets, но проверка
	// по-другому (вхождение в CIDR, не DNS-запрос). Если скачивание
	// списка не удалось (сеть/сайт недоступен) — не роняем весь цикл,
	// просто помечаем dropError и идём дальше без этих результатов.
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

	// AbuseIPDB — выполняется ТОЛЬКО если явно задан ключ в env.
	// Если ключа нет (ваш случай по умолчанию) — просто skipped:true.
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
// ЭКСПОРТ (только функции и константы, никакого class)
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
 * ПРИМЕР ИСПОЛЬЗОВАНИЯ (комментарий, ничего не выполняется)
 * ====================================================================
 *
 * const { runMonitoringCycle } = require('./ip-blacklist-monitor');
 *
 * async function tick() {
 *   const summary = await runMonitoringCycle();
 *   console.log(`Проверено ${summary.totalChecks} комбинаций IP/зона`);
 *   console.log(`Новых попаданий: ${summary.newListings.length}`);
 *   if (summary.failedChecks.length > 20) {
 *     // много сбоев подряд — возможно резолвер режет/недоступен
 *     console.warn('Много неудачных проверок:', summary.failedChecks.length);
 *   }
 * }
 *
 * // раз в час:
 * // const cron = require('node-cron');
 * // cron.schedule('0 * * * *', tick);
 *
 * // раз в 2 часа:
 * // cron.schedule('0 *\/2 * * *', tick);
 * ====================================================================
 */
