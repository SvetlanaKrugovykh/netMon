const dotenv = require('dotenv')
const { updateTables } = require('./db/tablesUpdate')

dotenv.config()

console.log('[NetMon] Starting Network Monitoring Server...')

updateTables()

setTimeout(() => {
  console.log('[NetMon] Initializing monitoring services...')

  try {
    const services = []

    try {
      const ipNetWatchService = require('./services/ipNetWatchService')
      services.push({ name: 'IP Net Watch', service: ipNetWatchService, interval: process.env.IP_NET_WATCH_INTERVAL })
    } catch (err) {
      console.log('[NetMon] ipNetWatchService not available')
    }

    try {
      const netWatchService = require('./services/netWatchService')
      services.push({ name: 'Net Watch', service: netWatchService, interval: process.env.NET_WATCH_INTERVAL })
    } catch (err) {
      console.log('[NetMon] netWatchService not available')
    }

    try {
      const snmpMrtgService = require('./services/snmpMrtgService')
      services.push({ name: 'SNMP MRTG', service: snmpMrtgService, interval: process.env.SNMP_MRTG_POOLING_INTERVAL })
    } catch (err) {
      console.log('[NetMon] snmpMrtgService not available')
    }

    try {
      const snmpNetWatchService = require('./services/snmpNetWatchService')
      services.push({ name: 'SNMP Net Watch', service: snmpNetWatchService, interval: process.env.SNMP_NET_WATCH_INTERVAL })
    } catch (err) {
      console.log('[NetMon] snmpNetWatchService not available')
    }

    services.forEach(({ name, service, interval }) => {
      if (interval && service) {
        console.log(`[NetMon] Starting ${name} service with interval ${interval}s`)
        setInterval(() => {
          try {
            if (service.runIpNetWatch) service.runIpNetWatch()
            else if (service.runNetWatch) service.runNetWatch()
            else if (service.collectMrtgData) service.collectMrtgData()
            else if (service.runSnmpNetWatch) service.runSnmpNetWatch()
            else console.log(`[NetMon] ${name}: No suitable method found`)
          } catch (err) {
            console.error(`[NetMon] Error in ${name}:`, err.message)
          }
        }, parseInt(interval) * 1000)
      }
    })

    console.log(`[NetMon] Started ${services.length} monitoring services`)
  } catch (err) {
    console.error('[NetMon] Error starting services:', err.message)
  }
}, 5000)

process.on('SIGINT', () => {
  console.log('[NetMon] Shutting down gracefully...')
  process.exit(0)
})

console.log('[NetMon] Server initialization complete. Monitoring will start in 5 seconds...')