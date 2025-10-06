const { netWatchPingerProbe, netWatchPingerWithDelay, loadipList } = require('./ipNetWatchService.js')
const { checkServiceStatus, loadServicesList } = require('./portNetWatchService.js')
const { checksnmpObjectStatus, loadSnmpObjectsList } = require('./snmpNetWatchService.js')
const { loadSnmpMrtgObjectsList, loadSnmpMrtgObjectData } = require('./snmpMrtgService.js')

let ipCheckDelayList = []

async function netWatchStarter() {

  let ipList = await loadipList()
  let servicesList = await loadServicesList()
  let snmpObjectsList = await loadSnmpObjectsList()

  const pingPoolingInterval = parseInt(process.env.PING_POOLING_INTERVAL) * 1000
  const servicesPoolingInterval = parseInt(process.env.SERVICES_POOLING_INTERVAL) * 1000
  const snmpPoolingInterval = parseInt(process.env.SNMP_POOLING_INTERVAL) * 1000 || 320000
  const pingWithDelayPoolingInterval = parseInt(process.env.PING_WITH_DELAY_POOLING_INTERVAL) * 1000 || 60000

  ipCheckDelayList = ipList.filter(ip => ip.ckeckDelay).map(ip => ip.ip_address)

  if (process.env.NETWATCHING_ENABLED === 'true') {
    setInterval(() => {
      try {
        ipList.forEach(ip_address => {
          netWatchPingerProbe(ip_address)
        })
      } catch (err) {
        console.log(err)
      }
    }, pingPoolingInterval)

    setInterval(() => {
      try {
        netWatchPingerWithDelay(ipCheckDelayList)
      } catch (err) {
        console.log(err)
      }
    }, pingWithDelayPoolingInterval)

    setInterval(() => {
      try {
        servicesList.forEach(service => {
          checkServiceStatus(service)
        })
      } catch (err) {
        console.log(err)
      }
    }, servicesPoolingInterval)
  }

  if (process.env.SNMP_POOLING_ENABLE === 'true') {
    let snmpCycleId = 0
    async function pollSnmpObjectsSequentially() {
      snmpCycleId++
      const cycleTimestamp = new Date().toISOString()
      console.log(`[SNMP] Start poll cycle`, { cycleId: snmpCycleId, timestamp: cycleTimestamp, objects: snmpObjectsList.length })
      let okCount = 0
      let failCount = 0
      for (const snmpObject of snmpObjectsList) {
  console.log(`[SNMP][pollSnmpObjectsSequentially] Polling object`, { cycleId: snmpCycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
        let processed = false
        try {
          await checksnmpObjectStatus(snmpObject, snmpCycleId)
          processed = true
          okCount++
        } catch (err) {
          failCount++
          console.log(`[SNMP][pollSnmpObjectsSequentially] Error in poll cycle`, { cycleId: snmpCycleId, ip: snmpObject.ip_address, oid: snmpObject.oid, error: err && err.message ? err.message : err })
        }
        if (!processed) {
          console.log(`[SNMP][pollSnmpObjectsSequentially] Object not processed (error or timeout)`, { cycleId: snmpCycleId, ip: snmpObject.ip_address, oid: snmpObject.oid })
        }
        await new Promise(res => setTimeout(res, 3000))
      }
  console.log(`[SNMP][pollSnmpObjectsSequentially] Poll cycle summary`, { cycleId: snmpCycleId, ok: okCount, fail: failCount, total: snmpObjectsList.length })
      console.log(`[SNMP] End poll cycle`, { cycleId: snmpCycleId, timestamp: new Date().toISOString() })
    }
    setInterval(() => {
      pollSnmpObjectsSequentially()
    }, snmpPoolingInterval)
  }
}

async function mrtgWatchStarter() {
  let snmpMrtgObjectsList = await loadSnmpMrtgObjectsList()
  const snmpMrtgPollingInterval = parseInt(process.env.SNMP_MRTG_POOLING_INTERVAL) * 1000 || 600000

  if (process.env.SNMP_POOLING_ENABLE === 'true') {
    setInterval(() => {
      try {
        loadSnmpMrtgObjectData(snmpMrtgObjectsList)
      } catch (err) {
        console.log(err)
      }
    }, snmpMrtgPollingInterval)
  }
}


module.exports = {
  netWatchStarter,
  mrtgWatchStarter,
  ipCheckDelayListContainer: { list: ipCheckDelayList }
}