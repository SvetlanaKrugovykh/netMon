const { runCommand } = require('../src/server/utils/commandsOS')

async function test() {
  // SNMPwalk через snmpRemotes, с value
  const command = 'snmpwalk'
  const args = ['-v', '2c', '-c', 'public', '-OXsq', '-On', '192.168.165.202', '1.3.6.1.2.1.1.1.0']
  const value = 'Status OK'
  console.log('Test 1: SNMPwalk with value')
  const result1 = await runCommand(command, args, value)
  console.log('Result:', result1)

  // SNMPwalk через snmpRemotes, без value
  console.log('Test 2: SNMPwalk without value')
  const result2 = await runCommand(command, args)
  console.log('Result:', result2)
}

test()
