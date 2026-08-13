/**
 * Диагностика цепочки MRTG: 1) получение списка объектов через sendReqToDB('__GetSnmpMrtgObjects__')
 *                            2) запись тестовой строки напрямую в таблицу mrtg_data
 *
 * Запуск на сервере из корня проекта:
 *   node src/server/tests/manual/testMrtgPipeline.js
 *
 * Ничего не удаляет и не трогает существующие данные — только читает список
 * и вставляет одну тестовую запись (ip = 0.0.0.0), которую потом легко найти и убрать.
 */

require("dotenv").config()
const { sendReqToDB } = require("../../modules/to_local_DB")
const { pool } = require("../../db/tablesUpdate")

const SEP = "=".repeat(70)

async function step1_loadMrtgObjectsList() {
	console.log(SEP)
	console.log(
		"ШАГ 1: loadSnmpMrtgObjectsList — запрос списка SNMP MRTG объектов",
	)
	console.log(SEP)
	console.log("URL для запроса (LOG_URL):", process.env.LOG_URL)

	const started = Date.now()
	const raw = await sendReqToDB("__GetSnmpMrtgObjects__", "", "")
	const elapsed = Date.now() - started

	console.log(`Запрос выполнен за ${elapsed} мс`)

	if (raw === null || raw === undefined) {
		console.log(
			"❌ sendReqToDB вернул null — запрос к внешней БД (1С) не удался.",
		)
		console.log(
			"   Смотри лог выше от [sendReqToDB] — там причина (таймаут / HTTP код / ошибка сети).",
		)
		return null
	}

	console.log("Сырой ответ (первые 500 символов):")
	console.log(String(raw).slice(0, 500))

	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		console.log("❌ Не удалось распарсить ответ как JSON:", err.message)
		return null
	}

	const list = parsed.ResponseArray
	if (!Array.isArray(list)) {
		console.log(
			"❌ В ответе нет массива ResponseArray, либо это не массив. Распарсенный объект:",
		)
		console.log(JSON.stringify(parsed, null, 2).slice(0, 1000))
		return null
	}

	console.log(`✅ Получено объектов для опроса: ${list.length}`)
	if (list.length > 0) {
		console.log("Пример первых 3 записей:")
		console.log(JSON.stringify(list.slice(0, 3), null, 2))
	} else {
		console.log(
			"⚠️  Список пуст. Если mrtgWatchStarter() берёт этот список один раз при старте",
		)
		console.log(
			"   и он оказался пустым — опрос SNMP и запись в БД не будут происходить никогда,",
		)
		console.log(
			"   пока процесс не перезапустят (список не обновляется по таймеру).",
		)
	}

	return list
}

async function step2_writeTestRowToDB() {
	console.log("")
	console.log(SEP)
	console.log("ШАГ 2: тестовая запись в таблицу mrtg_data (Postgres)")
	console.log(SEP)
	console.log("Подключение к БД:", {
		host: process.env.TRAFFIC_DB_HOST,
		port: process.env.TRAFFIC_DB_PORT,
		database: process.env.TRAFFIC_DB_NAME,
		user: process.env.TRAFFIC_DB_USER,
	})

	const testRecord = {
		timestamp: new Date(),
		ip: "0.0.0.0",
		dev_port: 0,
		object_name: "TEST_PROBE",
		object_value_in: 1,
		object_value_out: 2,
	}

	try {
		const client = await pool.connect()
		try {
			const result = await client.query(
				`INSERT INTO mrtg_data (timestamp, ip, dev_port, object_name, object_value_in, object_value_out)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, timestamp`,
				[
					testRecord.timestamp,
					testRecord.ip,
					testRecord.dev_port,
					testRecord.object_name,
					testRecord.object_value_in,
					testRecord.object_value_out,
				],
			)
			console.log("✅ Запись успешно вставлена:", result.rows[0])

			// Проверим также, когда была последняя РЕАЛЬНАЯ запись (не тестовая),
			// чтобы понять, с какого момента данные перестали приходить.
			const last = await client.query(
				`SELECT id, timestamp, ip, object_name
         FROM mrtg_data
         WHERE object_name != 'TEST_PROBE'
         ORDER BY timestamp DESC
         LIMIT 1`,
			)
			if (last.rows.length) {
				console.log("ℹ️  Последняя НЕ тестовая запись в таблице:", last.rows[0])
			} else {
				console.log("ℹ️  В таблице вообще нет нетестовых записей.")
			}

			console.log("")
			console.log("Чтобы удалить тестовую запись вручную:")
			console.log(`   DELETE FROM mrtg_data WHERE id = ${result.rows[0].id};`)
		} finally {
			client.release()
		}
	} catch (err) {
		console.log("❌ Ошибка записи в БД:", err.message)
		console.log(err)
	}
}

async function main() {
	const list = await step1_loadMrtgObjectsList()
	await step2_writeTestRowToDB()

	console.log("")
	console.log(SEP)
	console.log("ИТОГ")
	console.log(SEP)
	if (!list) {
		console.log("Получение списка объектов (шаг 1) — ПРОВАЛ. Смотри лог выше.")
	} else if (list.length === 0) {
		console.log(
			"Получение списка объектов (шаг 1) — вернулся пустой список (см. предупреждение выше).",
		)
	} else {
		console.log(
			`Получение списка объектов (шаг 1) — OK, ${list.length} объектов.`,
		)
	}
	console.log("Запись в БД (шаг 2) — см. лог выше.")

	await pool.end()
	process.exit(0)
}

main().catch((err) => {
	console.error("Необработанная ошибка:", err)
	process.exit(1)
})
