require('dotenv').config()
const { netWatchPingerProbe } = require('../src/server/services/ipNetWatchService')

const testIp = process.env.TEST_PING_IP || '8.8.8.8'

const ipObj = { ip_address: testIp, status: 'alive' }

console.log('--- Ping Test ---')
netWatchPingerProbe(ipObj)