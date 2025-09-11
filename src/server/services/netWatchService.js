const { netWatchPingerProbe, netWatchPingerWithDelay, loadipList } = require('./ipNetWatchService.js')
const { checkServiceStatus, loadServicesList } = require('./portNetWatchService.js')
const { checksnmpObjectStatus, loadSnmpObjectsList } = require('./snmpNetWatchService.js')
const { loadSnmpMrtgObjectsList, loadSnmpMrtgObjectData } = require('./snmpMrtgService')

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
    setInterval(() => {
      try {
        snmpObjectsList.forEach(snmpObject => {
          checksnmpObjectStatus(snmpObject)
        })
      } catch (err) {
        console.log(err)
      }
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