/**
 * Тест воспроизводит РЕАЛЬНЫЙ вызов, который делает прод при опросе MRTG —
 * то есть не голый `snmpget`, а именно utils/commandsOS.js -> runCommand(),
 * со всей логикой выбора source-IP / удалённого прокси / snmp_routes.json / snmp_remotes.json.
 *
 * Запуск на сервере из корня проекта:
 *   node src/server/tests/manual/testMrtgRunCommand.js
 *
 * Можно передать свой IP/OID/порт аргументами:
 *   node src/server/tests/manual/testMrtgRunCommand.js 192.168.165.205 1.3.6.1.2.1.31.1.1.1.6 1
 */

require("dotenv").config()
const path = require("path")
const { execSync } = require("child_process")
const { runCommand } = require("../../utils/commandsOS")

const SEP = "=".repeat(70)

const argIp = process.argv[2] || "192.168.165.205"
const argOid = process.argv[3] || "1.3.6.1.2.1.31.1.1.1.6"
const argPort = process.argv[4] || "1"

function loadJson(rel) {
	try {
		return require(path.join(__dirname, "../../utils", rel))
	} catch (e) {
		return null
	}
}

async function main() {
	console.log(SEP)
	console.log("Конфигурация окружения, влияющая на выбор пути опроса")
	console.log(SEP)
	console.log({
		SNMP_SOURCE_IP: process.env.SNMP_SOURCE_IP,
		SNMP_TIMEOUT: process.env.SNMP_TIMEOUT,
		SNMP_CLIENT_TIMEOUT_SEC: process.env.SNMP_CLIENT_TIMEOUT_SEC,
		SNMP_DEBUG_LEVEL: process.env.SNMP_DEBUG_LEVEL,
		SNMP_TOKEN: process.env.SNMP_TOKEN
			? `${process.env.SNMP_TOKEN.slice(0, 12)}...(len=${process.env.SNMP_TOKEN.length})`
			: "(не задан)",
	})

	const routes = loadJson("snmp_routes.json") || []
	const remotes = loadJson("snmp_remotes.json") || []

	const matchedRoute = routes.find((r) => argIp.startsWith(r.subnet))
	const matchedRemote = remotes.find((r) => argIp.startsWith(r.subnet))

	console.log("")
	console.log(`Целевой IP: ${argIp}`)
	console.log(
		"Совпадение в snmp_routes.json (source-ip bind, приоритет НАД remote-прокси):",
		matchedRoute || "— нет —",
	)
	console.log(
		"Совпадение в snmp_remotes.json (remote HTTP-прокси):",
		matchedRemote || "— нет —",
	)

	if (matchedRoute) {
		const sourceIp = matchedRoute["snmp-net-source-ip"]
		console.log("")
		console.log(
			`⚠️  Т.к. IP матчится в snmp_routes.json, remote-прокси используется НЕ будет.`,
		)
		console.log(
			`    Вместо этого локальный snmpget получит флаг -s ${sourceIp} (bind на этот IP).`,
		)
		console.log("")
		console.log(SEP)
		console.log(
			`Проверка: поднят ли ${sourceIp} на сетевых интерфейсах ЭТОГО сервера`,
		)
		console.log(SEP)
		try {
			const out = execSync(
				`ip -o addr show 2>/dev/null || ifconfig 2>/dev/null`,
			).toString()
			console.log(out)
			if (out.includes(sourceIp)) {
				console.log(
					`✅ ${sourceIp} найден среди локальных адресов — bind должен проходить нормально.`,
				)
			} else {
				console.log(
					`❌ ${sourceIp} НЕ найден среди локальных адресов интерфейсов этого сервера!`,
				)
				console.log(
					`   Именно поэтому "snmpget -s ${sourceIp} ..." будет падать с ошибкой`,
				)
				console.log(
					`   ("Cannot find device/address" / "bind: Cannot assign requested address"),`,
				)
				console.log(
					`   а твой ручной "snmpget 192.168.165.205 ..." без -s работает нормально.`,
				)
			}
		} catch (e) {
			console.log("Не удалось получить список интерфейсов:", e.message)
		}
	} else if (matchedRemote) {
		console.log("")
		console.log(
			`⚠️  Т.к. IP матчится в snmp_remotes.json (и НЕ матчится в routes), опрос пойдёт`,
		)
		console.log(
			`    через удалённый HTTP-прокси: ${matchedRemote.url}, с заголовком Authorization: SNMP_TOKEN.`,
		)
		console.log(
			`    Если токен протух/сервис недоступен — вызов вернёт null молча (см. ниже).`,
		)
	} else {
		console.log("")
		console.log(
			"ℹ️  IP не матчится ни под routes, ни под remotes — опрос пойдёт локальным snmpget без -s.",
		)
	}

	console.log("")
	console.log(SEP)
	console.log(
		`Реальный вызов runCommand() как это делает loadSnmpMrtgObjectData()`,
	)
	console.log(SEP)
	const oid = `${argOid}.${argPort}`
	const cmdArgs = ["-v", "2c", "-c", "public", "-Oqv", "-On", argIp, oid]
	console.log("Аргументы:", cmdArgs)

	const started = Date.now()
	let result
	let threw = null
	try {
		result = await runCommand("snmpget", cmdArgs)
	} catch (err) {
		threw = err
	}
	const elapsed = Date.now() - started

	console.log(`Выполнено за ${elapsed} мс`)

	if (threw) {
		console.log("❌ runCommand выбросил исключение:", threw.message)
	} else if (result === null || result === undefined) {
		console.log(
			'❌ runCommand вернул null/undefined — именно так выглядит "тихий" провал,',
		)
		console.log(
			"   после которого loadSnmpMrtgObjectData() пропускает объект БЕЗ записи в БД",
		)
		console.log(
			'   и без явной ошибки в логах (см. snmpMrtgService.js: response превращается в "").',
		)
	} else if (
		result === "" ||
		result === "Status OK" ||
		result === "Status PROBLEM"
	) {
		console.log(`⚠️  runCommand вернул нечисловое значение: "${result}"`)
		console.log(
			"   Числовое значение не будет извлечено -> запись в БД пропускается.",
		)
	} else {
		console.log(`✅ runCommand вернул значение: "${result}"`)
		console.log(
			"   Похоже на нормальный числовой SNMP-результат — эта часть цепочки работает.",
		)
	}
}

main().catch((err) => {
	console.error("Необработанная ошибка теста:", err)
	process.exit(1)
})
