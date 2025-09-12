const { runCommand } = require('../src/server/utils/commandsOS')
require('dotenv').config()

async function test() {
  const testIp = process.env.TEST_SNMP_IP
  const command = 'snmpwalk'

  const args = [
    '-v', '2c',
    '-c', 'public',
    '-OXsq', '-On',
    testIp,
    '1.3.6.1.2.1.1.1.0'
  ]
  const value = '???'
  console.log('Test 1: SNMPwalk with value')
  const result1 = await runCommand(command, args, value)
  console.log('Result:', result1)

  console.log('Test 2: SNMPwalk without value')
  const result2 = await runCommand(command, args)
  console.log('Result:', result2)
}

test()
