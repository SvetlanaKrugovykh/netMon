const fs = require('fs')
const path = require('path')
const axios = require('axios')
require('dotenv').config()

let snmpRemotes = []
try {
  const remotesPath = path.join(__dirname, 'snmp_remotes.json')
  snmpRemotes = JSON.parse(fs.readFileSync(remotesPath, 'utf8'))
} catch (e) {
  snmpRemotes = []
}
const util = require('util')
const exec = util.promisify(require('child_process').exec)

async function runCommand(command, args = [], value = '') {
  let fullCommand = command

  // if (command === 'snmpwalk' && process.env.SNMP_SOURCE_IP) {
  //   fullCommand += ` -s ${process.env.SNMP_SOURCE_IP}`
  // }

  if (args.length > 0) {
    fullCommand += ` ${args.join(' ')}`
  }

  if (command === 'snmpwalk' && args.length > 0) {
    const targetIp = args.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))
    if (targetIp) {
      const remote = snmpRemotes.find(r => targetIp.startsWith(r.subnet))
      if (remote && process.env.SNMP_TOKEN) {
        try {
          const response = await axios.post(remote.url, {
            command: fullCommand
          }, {
            headers: {
              Authorization: process.env.SNMP_TOKEN,
              'Content-Type': 'application/json'
            }
          })
          return response.data.result || response.data || ''
        } catch (err) {
          console.error('[ERROR] SNMP remote axios:', err.message || err)
          return null
        }
      }
    }
  }
  try {
    const { stdout, stderr } = await exec(fullCommand)
    if (command.includes('pfctl')) {
      console.log(`${new Date()}: ${command} out: ${stdout}`)
    }
    if (stderr && stderr.toLowerCase().includes('timeout')) {
      console.error(`[ERROR] Timeout for ${command}`)
    } else if (stderr) {
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
    if (error && error.message && error.message.toLowerCase().includes('timeout')) {
      console.error(`[ERROR] Timeout for ${command}`)
    } else {
      console.error(`[ERROR] ${command}: ${error.message}`)
    }
    return null
  }
}

module.exports = { runCommand }
