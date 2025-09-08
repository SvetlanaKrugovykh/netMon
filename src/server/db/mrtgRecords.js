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

module.exports.mrtgToDB = async function (data) {
  try {
    if (process.env.MRTG_DEBUG === '9') console.log('MRTG data for DB:', data)
    const mrtgRecords = []

    for (const ip of data) {
      if (process.env.MRTG_DEBUG === '9') console.log('MRTG data for DB:', ip)
      const { ip_address, oid, value, port } = ip

      const parsedValue = Number(value)
      if (isNaN(parsedValue)) {
        console.log(`Invalid SNMP value received: ${value} (OID: ${oid})`)
        continue
      }

      if (oid.includes('1.3.6.1.2.1.31.1.1.1.6')) {
        mrtgRecords.push({
          timestamp: new Date(),
          ip: ip_address,
          dev_port: port,
          object_name: 'ifHCInOctets',
          object_value_in: parsedValue,
          object_value_out: 0,
        })
      } else if (oid.includes('1.3.6.1.2.1.31.1.1.1.10')) {
        mrtgRecords.push({
          timestamp: new Date(),
          ip: ip_address,
          dev_port: port,
          object_name: 'ifHCOutOctets',
          object_value_in: 0,
          object_value_out: parsedValue,
        })
      }
    }

    for (const record of mrtgRecords) {
      const result = await pool.query(
        `
        INSERT INTO mrtg_data (timestamp, ip, dev_port, object_name, object_value_in, object_value_out)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
        [
          record.timestamp,
          record.ip,
          record.dev_port,
          record.object_name,
          record.object_value_in,
          record.object_value_out,
        ]
      )
      if (process.env.MRTG_DEBUG === '9') console.log('Insert result:', result.rowCount)
    }
  } catch (err) {
    console.log('Error processing MRTG data:', err.message)
  }
}