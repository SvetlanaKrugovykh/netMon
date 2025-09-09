require('dotenv').config()
const { loadSnmpMrtgObjectData } = require('../src/server/services/snmpMrtgService')

const TEST_SNMP_MRTG_OBJECTS = process.env.TEST_SNMP_MRTG_OBJECTS

let snmpMrtgObjectsList
try {
  snmpMrtgObjectsList = JSON.parse(TEST_SNMP_MRTG_OBJECTS)
} catch (err) {
  console.error('Please set TEST_SNMP_MRTG_OBJECTS in your .env file as a valid JSON array')
  process.exit(1)
}

console.log('Testing loadSnmpMrtgObjectData with:', snmpMrtgObjectsList)


  (async () => {
    try {
      const result = await loadSnmpMrtgObjectData(snmpMrtgObjectsList)
      console.log('Result from loadSnmpMrtgObjectData:', result)
    } catch (err) {
      console.error('Error during loadSnmpMrtgObjectData test:', err)
    }
  })()
