const { Pool } = require('pg')
const dotenv = require('dotenv')

dotenv.config()

const pool = new Pool({
  user: process.env.TRAFFIC_DB_USER,
  host: process.env.TRAFFIC_DB_HOST,
  database: process.env.TRAFFIC_DB_NAME,
  password: process.env.TRAFFIC_DB_PASSWORD,
  port: process.env.TRAFFIC_DB_PORT,
})

const tableQueries = {
  mrtg_data: `CREATE TABLE IF NOT EXISTS mrtg_data (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL,
    ip VARCHAR(15) NOT NULL,
    dev_port INTEGER NOT NULL,
    object_name VARCHAR(50) NOT NULL,
    object_value_in BIGINT NOT NULL DEFAULT 0,
    object_value_out BIGINT NOT NULL DEFAULT 0
  )`,
}

module.exports.updateTables = function () {
  checkAndCreateTable('mrtg_data')
    .then(() => {
      console.log('[NetMon] MRTG tables created or already exist.')
    })
    .catch((err) => {
      console.error('[NetMon] Error in table creation:', err)
    })
}

async function checkAndCreateTable(tableName) {
  let client
  try {
    client = await pool.connect()
    const res = await client.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = $1
      )`,
      [tableName]
    )

    const tableExists = res.rows[0].exists
    if (!tableExists) {
      await createTable(tableName)
      console.log(`[NetMon] Table ${tableName} created successfully.`)
    } else {
      console.log(`[NetMon] Table ${tableName} already exists.`)
    }
  } catch (err) {
    console.error(`[NetMon] Error checking table ${tableName}:`, err)
  } finally {
    if (client) client.release()
  }
}

async function createTable(tableName) {
  try {
    await pool.query(tableQueries[tableName])
    console.log(`[NetMon] Table ${tableName} created successfully.`)
  } catch (err) {
    console.error(`[NetMon] Error creating table ${tableName}:`, err)
  }
}

module.exports.pool = pool
