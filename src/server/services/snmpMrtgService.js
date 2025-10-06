const { runCommand } = require('../utils/commandsOS')
const { sendReqToDB } = require('../modules/to_local_DB')
const { mrtgToDB } = require('../db/mrtgRecords')
require('dotenv').config()

async function loadSnmpMrtgObjectsList() {
  try {
    const data = await sendReqToDB('__GetSnmpMrtgObjects__', '', '')
    const parsedData = JSON.parse(data)
    const snmpObjectsList = parsedData.ResponseArray
    return snmpObjectsList
  } catch (err) {
    console.log('Error in loadSnmpMrtgObjectsList:', err)
    return []
  }
}

async function loadSnmpMrtgObjectData(snmpMrtgObjectsList) {

  if (!Array.isArray(snmpMrtgObjectsList)) {
    console.log(`[${new Date().toISOString()}] snmpMrtgObjectsList is not an array or is undefined`)
    return
  }

  let response = ''
  const data = []

  try {
    for (let snmpObject of snmpMrtgObjectsList) {
      const unixTimestamp = Math.floor(Date.now() / 1000)
      try {
        const oid = `${snmpObject.oid}.${snmpObject.port}`
        const cmdArgs = ['-v', '2c', '-c', 'public', '-Oqv', '-On', snmpObject.ip_address, oid]
        response = await runCommand('snmpget', cmdArgs)
        response = (typeof response === 'string') ? response.replace(/\s+/g, ' ').trim() : ''

        // Extract numeric value from SNMP response (e.g., "value 12345 Status OK" -> 12345)
        let cleanValue = response
        if (typeof response === 'string') {
          // Remove "value", "Status OK", "Status PROBLEM" and extract number
          cleanValue = response.replace(/value/gi, '').replace(/Status OK/gi, '').replace(/Status PROBLEM/gi, '').trim()
          const match = cleanValue.match(/-?\d+(\.\d+)?/)
          if (match) {
            cleanValue = match[0]
          } else {
            // No numeric value found in string like "Status OK" - skip this record
            if (process.env.MRTG_DEBUG === '9') console.log(`Skipping non-numeric SNMP value: ${response} (OID: ${snmpObject.oid})`)
            continue
          }
        }

        const snmpValue = cleanValue

        const snmpData = {
          ip_address: snmpObject.ip_address,
          oid: snmpObject.oid,
          value: snmpValue,
          port: snmpObject.port,
          unixTimestamp: unixTimestamp
        }
        data.push(snmpData)
      } catch (err) {
        if (err && typeof err.message === 'string' && err.message.toLowerCase().includes('timeout')) {
          console.log(`Timeout for ${snmpObject.ip_address}:${snmpObject.oid}`)
        } else {
          console.log(`Error executing SNMP command for ${snmpObject.ip_address}:${snmpObject.oid}: ${err && err.message ? err.message : err}`)
        }
      }
    }
    await mrtgToDB(data)
  } catch (err) {
    console.log('Critical error in loadSnmpMrtgObjectData:', err)
  }
}



module.exports = { loadSnmpMrtgObjectsList, loadSnmpMrtgObjectData }