"use strict"

/**
 * testblkl.js
 * ------------------------------------------------------------------
 * ОТЛАДОЧНЫЙ скрипт. Запускать прямо в дебаггере на dev, ДО встраивания
 * в вашу систему мониторинга. Цель — увидеть, что именно возвращает
 * каждая функция monitor.js, шаг за шагом, с логами.
 *
 * Расположение в проекте:
 *   src/server/tests/manual/testblkl.js
 *   src/server/modules/ip-blacklist-monitor/monitor.js
 *
 * Запуск (из src/server/tests/manual/):
 *   node --inspect-brk testblkl.js
 * (или через дебаггер вашей IDE — поставьте breakpoint на любой шаг)
 *
 * ВАЖНО: этот скрипт использует ОТДЕЛЬНЫЙ файл состояния
 * (src/server/data/testblkl-state.json), чтобы не трогать состояние
 * вашей будущей продакшен-системы мониторинга.
 *
 * Что реально ходит в сеть, а что нет — чтобы не гадать:
 *   Шаг 1-2  — никакой сети, чистые вычисления над вашим .env.
 *   Шаг 3    — 1 реальный DNS-запрос (тестовый IP 127.0.0.2, не ваш).
 *   Шаг 4    — реальные DNS-запросы (2 ВАШИХ IP x 2 зоны = 4 запроса).
 *   Шаг 5    — реальное скачивание Spamhaus DROP (1 HTTP-запрос) +
 *              проверка ВАШИХ IP на вхождение в их CIDR-блоки.
 *   Шаг 6-7  — никакой сети, синтетические данные, только логика/текст.
 *   Шаг 8    — реальный HTTP POST в Telegram, но ТОЛЬКО если заполнены
 *              IPMON_TELEGRAM_BOT_TOKEN и IPMON_TELEGRAM_CHAT_ID в .env.
 *              Если пустые — увидите skipped:true без похода в сеть.
 *   Шаг 9    — реальные DNS-запросы + реальная проверка DROP
 *              (3 ВАШИХ IP x 1 зона + DROP).
 *
 * Все шаги, где упомянуты "ваши IP" — это реальные адреса, вычисленные
 * из IPMON_SUBNETS из вашего .env, без каких-либо придуманных масок
 * или посторонних диапазонов.
 * ------------------------------------------------------------------
 */

let loadEnv
try {
	loadEnv = require("dotenv")
} catch (_) {
	loadEnv = null // пакета нет — просто идём дальше, без падения
}
if (loadEnv) loadEnv.config()
// Если dotenv не установлен и переменные из .env не подхватились —
// шаг 1 (getConfig()) это сразу покажет: subnets будут дефолтными.

const path = require("path")
const {
	getConfig,
	subnetsToIPs,
	checkDNSBL,
	scanSubnets,
	scanDropList,
	diffAgainstState,
	formatNewListingsMessage,
	splitIntoChunks,
	triggerAlerts,
	runMonitoringCycle,
} = require("../../modules/ip-blacklist-monitor/monitor")

// tests/manual/testblkl.js -> ../.. -> src/server -> /data/testblkl-state.json
const TEST_STATE_FILE = path.join(__dirname, "../../data/testblkl-state.json")

const line = (title) =>
	console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`)
const log = (...args) => console.log(...args)

// --------------------------------------------------------------------
// Шаг 1: что реально загрузилось из .env / process.env
// --------------------------------------------------------------------
const step1_config = () => {
	line("ШАГ 1: getConfig() — эффективная конфигурация из env")
	const cfg = getConfig()
	log(JSON.stringify(cfg, null, 2))
	return cfg
}

// --------------------------------------------------------------------
// Шаг 2: subnetsToIPs() — разворачивает ВАШИ подсети из .env в список IP.
// Маски и адреса ниже — ровно те, что вы задали в IPMON_SUBNETS, без
// подмен и придуманных примеров.
// --------------------------------------------------------------------
const step2_subnetsToIPs = (cfg) => {
	line("ШАГ 2: subnetsToIPs() на ВАШИХ подсетях из .env")
	const ips = subnetsToIPs(cfg.subnets, {
		excludeReserved: cfg.excludeReserved,
	})
	log(`Подсети из IPMON_SUBNETS: ${cfg.subnets.join(", ")}`)
	log(`Итого уникальных IP: ${ips.length}`)
	log("Первые 5:", ips.slice(0, 5))
	log("Последние 5:", ips.slice(-5))
	const totalChecks = ips.length * cfg.dnsblZones.length
	const estimatedMinutes = (
		(totalChecks * cfg.requestDelayMs) /
		1000 /
		60
	).toFixed(1)
	log(`\nПри ${cfg.dnsblZones.length} зонах это ${totalChecks} DNS-запросов.`)
	log(
		`С паузой ${cfg.requestDelayMs}мс полный цикл займёт примерно ${estimatedMinutes} мин.`,
	)
	return ips
}

// --------------------------------------------------------------------
// Шаг 3: одна проверка checkDNSBL() на ЗАВЕДОМО ТЕСТОВОМ IP (НЕ вашем)
// --------------------------------------------------------------------
// 127.0.0.2 — стандартный "тестовый" адрес, который многие DNSBL
// (в т.ч. Spamhaus zen) специально всегда возвращают как listed —
// это сделано провайдерами именно для проверки клиентского кода,
// без риска задеть реальный чужой IP. Это НЕ ваш адрес, специально.
const step3_singleCheck = async (cfg) => {
	line(
		'ШАГ 3: checkDNSBL() на тестовом IP 127.0.0.2 (специально всегда "listed")',
	)
	const zone = cfg.dnsblZones[0]
	log(`Проверяем 127.0.0.2 по зоне ${zone} ...`)
	const result = await checkDNSBL("127.0.0.2", zone, {
		dnsTimeoutMs: cfg.dnsTimeoutMs,
		retries: cfg.retries,
	})
	log("Результат:", result)
	log(
		result.listed === true
			? "=> Ожидаемо: listed:true — механизм проверки работает корректно."
			: "=> ВНИМАНИЕ: ожидали listed:true для тестового IP. Проверьте DNS/сеть.",
	)
}

// --------------------------------------------------------------------
// Шаг 4: scanSubnets() на маленьком РЕАЛЬНОМ наборе (2 ВАШИХ IP x 2 зоны)
// --------------------------------------------------------------------
const step4_miniScan = async (cfg, realIps) => {
	line("ШАГ 4: scanSubnets() — мини-сканирование DNSBL (2 ВАШИХ IP x 2 зоны)")
	const miniSubnetSample = realIps.slice(0, 2)
	const miniZones = cfg.dnsblZones.slice(0, 2)
	log(`IP для теста (взяты из вашего .env): ${miniSubnetSample.join(", ")}`)
	log(`Зоны для теста: ${miniZones.join(", ")}`)
	log("Запускаю последовательно (это займёт пару секунд)...\n")

	// scanSubnets ожидает CIDR-список, поэтому оборачиваем каждый IP в /32
	const scan = await scanSubnets({
		subnets: miniSubnetSample.map((ip) => `${ip}/32`),
		zones: miniZones,
		excludeReserved: false, // /32 — это ровно 1 адрес, обрезать края нечего
		requestDelayMs: cfg.requestDelayMs,
	})

	log("Результат scanSubnets():")
	log(JSON.stringify(scan, null, 2))
	return scan
}

// --------------------------------------------------------------------
// Шаг 5: scanDropList() — РЕАЛЬНОЕ скачивание Spamhaus DROP (или чтение
// локального кэша, если он не старше IPMON_DROP_MAX_AGE_HOURS) и
// проверка ВСЕХ ваших реальных IP на вхождение в их CIDR-блоки.
// Если dropEnabled=false в .env — шаг просто это покажет и завершится.
// --------------------------------------------------------------------
const step5_dropList = async (cfg, realIps) => {
	line("ШАГ 5: scanDropList() — реальная проверка по Spamhaus DROP")
	if (!cfg.dropEnabled) {
		log("IPMON_DROP_ENABLED=false — шаг пропущен, DROP отключён в .env.")
		return
	}
	log(`Источник: ${cfg.dropUrl}`)
	log(
		`Кэш-файл: ${cfg.dropCacheFile} (обновляется не чаще раз в ${cfg.dropMaxAgeHours}ч)`,
	)
	log(`Проверяю ${realIps.length} ваших IP на вхождение в CIDR-блоки DROP...\n`)

	try {
		const dropScan = await scanDropList(realIps, {
			cacheFile: cfg.dropCacheFile,
			maxAgeHours: cfg.dropMaxAgeHours,
			url: cfg.dropUrl,
		})
		const listed = dropScan.results.filter((r) => r.listed)
		log(`Всего записей (CIDR-блоков) в списке DROP: ${dropScan.totalEntries}`)
		log(`Ваших IP в DROP: ${listed.length} из ${realIps.length}`)
		if (listed.length) log("Совпадения:", listed)
	} catch (err) {
		log("ОШИБКА при скачивании DROP:", err.message)
		log('(Если это "host_not_allowed" или таймаут — проверьте сетевой доступ')
		log("вашего сервера к www.spamhaus.org, это не связано с логикой модуля.)")
	}
}

// --------------------------------------------------------------------
// Шаг 6: diffAgainstState() — демонстрация на СИНТЕТИЧЕСКИХ данных.
// IP 203.0.113.x взят из блока TEST-NET-3 (RFC 5737) — официально
// зарезервирован именно для документации и примеров, это не ваш и не
// чей-то чужой реальный адрес. Никакой сети здесь нет — только логика.
// --------------------------------------------------------------------
const step6_diffDemo = () => {
	line(
		"ШАГ 6: diffAgainstState() — демонстрация логики на синтетических данных",
	)

	const fakeIp = "203.0.113.5"
	const fakeZone = "demo.zone.example"

	log("\n-- 6.1: prevState = {} (первый запуск) --")
	const round1Results = [
		{
			ip: fakeIp,
			zone: fakeZone,
			listed: true,
			reason: "demo spam listing",
			checkedAt: new Date().toISOString(),
		},
	]
	const diff1 = diffAgainstState({}, round1Results)
	log("newListings:", diff1.newListings)
	log(
		"=> Ожидаемо: попадает в newListings, потому что раньше про него не знали.",
	)

	log("\n-- 6.2: повторный скан, IP всё ещё listed:true --")
	const round2Results = [
		{
			ip: fakeIp,
			zone: fakeZone,
			listed: true,
			reason: "demo spam listing",
			checkedAt: new Date().toISOString(),
		},
	]
	const diff2 = diffAgainstState(diff1.nextState, round2Results)
	log("newListings (должно быть ПУСТО):", diff2.newListings)
	log("stillListed:", diff2.stillListed)
	log(
		"=> Ожидаемо: НЕ попадает в newListings повторно — избегаем спама алертами.",
	)

	log("\n-- 6.3: IP теперь чист (listed:false) --")
	const round3Results = [
		{
			ip: fakeIp,
			zone: fakeZone,
			listed: false,
			checkedAt: new Date().toISOString(),
		},
	]
	const diff3 = diffAgainstState(diff2.nextState, round3Results)
	log("resolvedListings:", diff3.resolvedListings)
	log(
		'=> Ожидаемо: попадает в resolvedListings, "wasListedSince" показывает когда появился.',
	)

	log("\n-- 6.4: сбой DNS (listed:null) не должен сбрасывать историю --")
	const round4Results = [
		{
			ip: fakeIp,
			zone: fakeZone,
			listed: null,
			error: "ETIMEDOUT",
			checkedAt: new Date().toISOString(),
		},
	]
	const diff4 = diffAgainstState(diff3.nextState, round4Results)
	log(
		"nextState для этого ключа сохранился как есть:",
		diff4.nextState[`${fakeIp}|${fakeZone}`],
	)
	log(
		"=> Ожидаемо: сбой проверки не создаёт ни newListing, ни resolvedListing.",
	)

	return diff1
}

// --------------------------------------------------------------------
// Шаг 7: формирование текста сообщений и разбивка на части (без сети)
// --------------------------------------------------------------------
const step7_formatting = (diff1) => {
	line("ШАГ 7: formatNewListingsMessage() / splitIntoChunks()")
	const text = formatNewListingsMessage(diff1.newListings)
	log("Текст сообщения:\n---\n" + text + "\n---")

	const longFakeList = Array.from({ length: 80 }, (_, i) => ({
		ip: `203.0.113.${i}`,
		zone: "demo.zone.example",
		reason: null,
	}))
	const longText = formatNewListingsMessage(longFakeList)
	const chunks = splitIntoChunks(longText, 500) // маленький maxLen для наглядности теста
	log(`\nДемонстрация разбивки: сообщение на ${longFakeList.length} строк`)
	log(
		`разбилось на ${chunks.length} частей (лимит для теста 500 симв. вместо 3500).`,
	)
}

// --------------------------------------------------------------------
// Шаг 8: triggerAlerts() — реальная отправка в Telegram, ЕСЛИ токен
// и chat_id заполнены в .env. Если нет — просто skipped:true, без сети.
// --------------------------------------------------------------------
const step8_telegram = async (cfg, diff1) => {
	line("ШАГ 8: triggerAlerts() (внутри — sendTelegramMessage())")
	if (!cfg.telegramBotToken || !cfg.telegramChatId) {
		log("IPMON_TELEGRAM_BOT_TOKEN / IPMON_TELEGRAM_CHAT_ID не заданы —")
		log("реальный запрос в Telegram НЕ отправляется, это ожидаемо для теста.")
	} else {
		log(
			"Токен и chat_id заданы — сейчас реально уйдёт тестовое сообщение в вашу группу!",
		)
	}

	const result = await triggerAlerts(diff1)
	log("Результат triggerAlerts():", result)
}

// --------------------------------------------------------------------
// Шаг 9: полный runMonitoringCycle() на ОТДЕЛЬНОМ тестовом файле
// состояния и урезанном наборе (3 ВАШИХ IP x 1 зона DNSBL + DROP по
// умолчанию, если IPMON_DROP_ENABLED не выключен) — чтобы не ждать
// полный цикл по всем адресам сразу.
// --------------------------------------------------------------------
const step9_fullCycleSmall = async (cfg, realIps) => {
	line(
		"ШАГ 9: runMonitoringCycle() целиком (DNSBL + DROP), на урезанном наборе IP",
	)
	log(`Использую отдельный файл состояния для теста: ${TEST_STATE_FILE}`)
	log("(чтобы не трогать состояние вашей будущей продакшен-системы)\n")

	const summary = await runMonitoringCycle({
		subnets: realIps.slice(0, 3).map((ip) => `${ip}/32`),
		zones: [cfg.dnsblZones[0]],
		excludeReserved: false,
		stateFile: TEST_STATE_FILE,
	})

	log("Итоговая сводка runMonitoringCycle():")
	log(JSON.stringify(summary, null, 2))
	log("\nЭто именно та структура, которую вы будете забирать в свою систему")
	log("мониторинга: summary.newListings — то, что должно триггерить алерт")
	log("(включая находки из Spamhaus DROP, если dropError отсутствует).")
}

// --------------------------------------------------------------------
// MAIN — запускаем шаги строго по очереди
// --------------------------------------------------------------------
const main = async () => {
	const cfg = step1_config()
	const realIps = step2_subnetsToIPs(cfg)
	await step3_singleCheck(cfg)
	await step4_miniScan(cfg, realIps)
	await step5_dropList(cfg, realIps)
	const diff1 = step6_diffDemo()
	step7_formatting(diff1)
	await step8_telegram(cfg, diff1)
	await step9_fullCycleSmall(cfg, realIps)

	line("ГОТОВО")
	log("Все шаги выполнены. Файл тестового состояния можно удалить:")
	log(`  ${TEST_STATE_FILE}`)
}

main().catch((err) => {
	console.error("\n!!! Ошибка в testblkl.js:", err)
	process.exit(1)
})

