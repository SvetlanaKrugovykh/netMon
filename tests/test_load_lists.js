require('dotenv').config()
const { loadipList } = require('../src/server/services/ipNetWatchService.js')
const { loadServicesList } = require('../src/server/services/portNetWatchService.js')
const { loadSnmpObjectsList } = require('../src/server/services/snmpNetWatchService.js')

async function testLoadLists() {
  console.log('=== Testing Load Lists ===\n')

  try {
    console.log('1. Loading IP List...')
    const ipList = await loadipList()
    console.log(`✅ IP List loaded: ${ipList.length} items`)
    if (ipList.length > 0) {
      console.log('First item:', ipList[0])
    }
  } catch (err) {
    console.error('❌ IP List error:', err.message)
  }

  console.log('\n2. Loading Services List...')
  try {
    const servicesList = await loadServicesList()
    console.log(`✅ Services List loaded: ${servicesList.length} items`)
    if (servicesList.length > 0) {
      console.log('First item:', servicesList[0])
    }
  } catch (err) {
    console.error('❌ Services List error:', err.message)
  }

  console.log('\n3. Loading SNMP Objects List...')
  try {
    const snmpObjectsList = await loadSnmpObjectsList()
    console.log(`✅ SNMP Objects List loaded: ${snmpObjectsList.length} items`)
    if (snmpObjectsList.length > 0) {
      console.log('First item:', snmpObjectsList[0])
    }
  } catch (err) {
    console.error('❌ SNMP Objects List error:', err.message)
  }

  console.log('\n=== Test Complete ===')
}

testLoadLists().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
