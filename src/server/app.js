const Fastify = require('fastify')
const dotenv = require('dotenv')
const { updateTables } = require('./db/tablesUpdate')
const authPlugin = require('./plugins/app.auth.plugin')
const { startOpticMeasurementsScheduler } = require('./services/opticDailyMeasurementsService')
const { startMainMeasurementsScheduler } = require('./services/mainDailyMeasurementsService')

dotenv.config()

console.log('[NetMon] Starting Network Monitoring Server...')

updateTables()

const app = Fastify({
  trustProxy: true
})


app.register(authPlugin)
app.register(require('./routes/mrtg.route'), { prefix: '/api' })

const HOST = process.env.HOST || '127.0.0.1'

app.listen({ port: process.env.PORT || 8080, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  console.log(`[APP] Service listening on ${address} | ${new Date()}`)
})

setTimeout(() => {
  console.log('[NetMon] Initializing monitoring services...')

  try {
    const services = []

    // Start monitoring services using netWatchService
    try {
      const { netWatchStarter, mrtgWatchStarter } = require('./services/netWatchService')
      netWatchStarter()
      mrtgWatchStarter()
      console.log('[NetMon] Monitoring services started via netWatchService.')
    } catch (err) {
      console.error('[NetMon] Error starting monitoring services:', err.message)
    }

    try {
      startOpticMeasurementsScheduler()
      console.log('[NetMon] Optic daily measurements scheduler started.')
      startMainMeasurementsScheduler()
      console.log('[NetMon] Main daily measurements scheduler started.')
    } catch (err) {
      console.error('[NetMon] Error starting optic measurements scheduler:', err.message)
    }
  } catch (err) {
    console.error('[NetMon] Error starting services:', err.message)
  }
}, 5000)

process.on('SIGINT', () => {
  console.log('[NetMon] Shutting down gracefully...')
  process.exit(0)
})

console.log('[NetMon] Server initialization complete. Monitoring will start in 5 seconds...')

