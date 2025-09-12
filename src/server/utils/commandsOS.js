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
  function logWithTime(...args) {
    const now = new Date()
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    console.error(ts, ...args)
  }
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
            cmdText: fullCommand,
            value: value
          }, {
            headers: {
              Authorization: process.env.SNMP_TOKEN,
              'Content-Type': 'application/json'
            }
          })
          return response.data.result || response.data || ''
        } catch (err) {
          logWithTime('[ERROR] SNMP remote axios:', err.message || err)
          return null
        }
      }
    }
  }
  try {
    const { stdout, stderr } = await exec(fullCommand)
    if (command.includes('pfctl')) {
      logWithTime(`${command} out: ${stdout}`)
    }
    if (stderr && stderr.toLowerCase().includes('timeout')) {
      logWithTime(`[ERROR] Timeout for ${command}`)
    } else if (stderr) {
      logWithTime(`[ERROR] ${command}: ${stderr.split('\n')[0]}`)
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
      logWithTime(`[ERROR] Timeout for ${command}`)
    } else {
      logWithTime(`[ERROR] ${command}: ${error.message}`)
    }
    return null
  }
}

module.exports = { runCommand }
