const util = require('util')
const exec = util.promisify(require('child_process').exec)

async function runCommand(command, args = [], value = '') {
  let fullCommand = command

  if (args.length > 0) {
    fullCommand += ` ${args.join(' ')}`
  }

  try {
    const { stdout, stderr } = await exec(fullCommand)

    if (command.includes('pfctl')) {
      console.log(`${new Date()}: ${command} out: ${stdout}`)
    }

    if (command === 'snmpwalk') {
      if (fullCommand.includes('1.3.6.1.2.1.31.1.1.1.6') || fullCommand.includes('1.3.6.1.2.1.31.1.1.1.10')) {
        return stdout.split(' ').pop().trim()
      }

      if (stdout.includes(value)) {
        return 'Status OK'
      } else {
        return 'Status PROBLEM'
      }
    } else {
      if (stdout.length > 0) console.log(`${new Date()}: ${command} out: ${stdout}`)
      if (stderr.length > 0) console.error(`${new Date()}: ${command} err: ${stderr}`)
      return { stdout, stderr }
    }
  } catch (error) {
    throw new Error(`Error of command execution: ${error.message}`)
  }
}


module.exports = { runCommand }
