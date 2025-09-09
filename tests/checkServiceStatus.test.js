require('dotenv').config()
const { checkServiceStatus } = require('../src/server/services/portNetWatchService')

const TEST_SERVICE_IP = process.env.TEST_SERVICE_IP
const TEST_SERVICE_PORT = process.env.TEST_SERVICE_PORT

if (!TEST_SERVICE_IP || !TEST_SERVICE_PORT) {
  console.error('Please set TEST_SERVICE_IP and TEST_SERVICE_PORT in your .env file')
  process.exit(1)
}

const testService = {
  ip_address: TEST_SERVICE_IP,
  Port: TEST_SERVICE_PORT,
  status: 'alive', // or 'dead', depending on what you want to test
}

console.log('Testing checkServiceStatus with:', testService)

try {
  checkServiceStatus(testService)
  console.log('checkServiceStatus executed (check logs for result)')
} catch (err) {
  console.error('Error during checkServiceStatus test:', err)
}
