const util = require('util')
const exec = util.promisify(require('child_process').exec)

async function runCommand(command, args = [], value = '') {
  let fullCommand = command
  if (command === 'snmpwalk' && process.env.SNMP_SOURCE_IP) {
    fullCommand += ` -s ${process.env.SNMP_SOURCE_IP}`
  }
  if (args.length > 0) {
    fullCommand += ` ${args.join(' ')}`
  }
  try {
    const { stdout, stderr } = await exec(fullCommand)
    if (command.includes('pfctl')) {
      console.log(`${new Date()}: ${command} out: ${stdout}`)
    }
    if (stderr) {
      console.error(`[ERROR] ${command}: ${stderr.split('\n')[0]}`)
    }
    if (fullCommand.includes('1.3.6.1.2.1.31.1.1.1.6') || fullCommand.includes('1.3.6.1.2.1.31.1.1.1.10')) {
      return stdout.split(' ').pop().trim()
    }
    if (stdout.includes(value)) {
      return 'Status OK'
    } else {
      return 'Status PROBLEM'
    }
    return { stdout, stderr }
  } catch (error) {
    console.error(`[ERROR] ${command}: ${error.message}`)
    return null
  }
}

module.exports = { runCommand }
