require('dotenv').config()
const { runCommand } = require('../src/server/utils/commandsOS')

const testIp = process.env.TEST_SNMP_IP
const args = [
  '-v', '2c',
  '-c', 'public',
  '-OXsq', '-On',
  testIp,
  '1.3.6.1.2.1.31.1.1.1.6.25'
]

runCommand('snmpwalk', args)
  .then(result => {
    console.log('SNMP result:', result)
  })
  .catch(err => {
    console.error('SNMP error:', err)
  })