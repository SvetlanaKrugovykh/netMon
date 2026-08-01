"use strict"

/**
 * run-first-cycle.js
 * ------------------------------------------------------------------
 * ПЕРВЫЙ РЕАЛЬНЫЙ прогон мониторинга — не тест, не дебаг-скрипт.
 * В отличие от testblkl.js:
 *   - НЕТ никаких тестовых/синтетических IP (203.0.113.x и т.п.)
 *   - НЕТ отдельного testblkl-state.json — используется ровно тот
 *     файл, что указан в IPMON_STATE_FILE вашего .env
 *   - НЕТ обрезки списка IP/зон — сканируются ВСЕ подсети из
 *     IPMON_SUBNETS по ВСЕМ зонам из IPMON_DNSBL_ZONES + Spamhaus DROP
 *
 * То есть после этого запуска ip-blacklist-state.json — это уже
 * настоящее боевое состояние, с которым дальше будет работать cron.
 * Второй раз этот скрипт запускать не нужно — просто добавляйте
 * runMonitoringCycle() в свой cron-таск.
 *
 * Запуск (путь к monitor.js поправьте под вашу структуру):
 *   node run-first-cycle.js
 * ------------------------------------------------------------------
 */

let loadEnv
try {
	loadEnv = require("dotenv")
} catch (_) {
	loadEnv = null
}
if (loadEnv) loadEnv.config()

// Поправьте путь под реальное расположение monitor.js в вашем проекте
const { runMonitoringCycle, getConfig } = require("./ip-blacklist-monitor/monitor")

const main = async () => {
	const cfg = getConfig()

	console.log("=== Первый боевой прогон мониторинга ===")
	console.log(`Подсети: ${cfg.subnets.join(", ")}`)
	console.log(`Зоны: ${cfg.dnsblZones.join(", ")}`)
	console.log(`Файл состояния (продакшен): ${cfg.stateFile}`)
	console.log(
		`Telegram авто-отправка: ${cfg.telegramAutoSend ? "ВКЛЮЧЕНА (алерт уйдёт по-настоящему)" : "выключена"}`,
	)
	console.log("\nЗапускаю полный цикл, это займёт несколько минут...\n")

	console.time("Время выполнения")
	const summary = await runMonitoringCycle({
		onProgress: (done, total, result) => {
			// печатаем КАЖДУЮ проверку отдельной строкой — чтобы сразу видеть,
			// что процесс реально двигается, а не создаёт иллюзию тишины
			const status =
				result.listed === true
					? "LISTED"
					: result.listed === false
						? "чисто"
						: `ОШИБКА(${result.error})`
			console.log(`[${done}/${total}] ${result.ip} -> ${result.zone}: ${status}`)
		},
	})
	console.timeEnd("Время выполнения")

	console.log(
		`\nПроверено: ${summary.totalIps} IP x ${summary.totalZones} зон = ${summary.totalChecks} запросов`,
	)

	console.log(
		`\nТекущие попадания в блэклисты (все они попадут в newListings, т.к. это первый запуск — это нормально):`,
	)
	if (summary.newListings.length === 0) {
		console.log("  Ничего не найдено — все проверенные адреса чистые.")
	} else {
		summary.newListings.forEach((r) =>
			console.log(`  ⚠️  ${r.ip} -> ${r.zone}${r.reason ? ` (${r.reason})` : ""}`),
		)
	}

	if (summary.dropError) {
		console.log(`\nSpamhaus DROP: ошибка загрузки списка — ${summary.dropError}`)
		console.log("(это не касается DNSBL-результатов выше, DROP — отдельный источник)")
	}

	if (summary.failedChecks.length > 0) {
		console.log(`\nСбои DNS-резолвера (таймаут/ошибка): ${summary.failedChecks.length}`)
		console.log("Если их много — резолвер режет запросы, стоит явно задать dns.setServers().")
		summary.failedChecks
			.slice(0, 15)
			.forEach((r) => console.log(`  ✖ ${r.ip} -> ${r.zone}: ${r.error}`))
	}

	console.log(`\nСостояние записано в: ${cfg.stateFile}`)
	console.log(
		summary.telegramResult
			? `Telegram: ${JSON.stringify(summary.telegramResult)}`
			: "Telegram: сообщение не отправлялось (авто-отправка выключена в .env)",
	)

	console.log("\n=== ГОТОВО. Этот файл состояния теперь можно смело подключать к node-cron. ===")
}

main().catch((err) => {
	console.error("\nОшибка первого боевого запуска:", err)
	process.exit(1)
})
