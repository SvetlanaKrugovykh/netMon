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

let snmpRoutes = []
try {
  const routesPath = path.join(__dirname, 'snmp_routes.json')
  snmpRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
} catch (e) {
  snmpRoutes = []
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
  const SNMP_DEBUG_LEVEL = parseInt(process.env.SNMP_DEBUG_LEVEL) || 0
  let needRemoteCheck = true
  let targetIp = null
  if (command.includes('snmpwalk') && args.length > 0) {
    targetIp = args.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))
    let sourceIp = process.env.SNMP_SOURCE_IP || ''
    if (targetIp) {
      const route = snmpRoutes.find(r => targetIp.startsWith(r.subnet))
      if (route && route['snmp-net-source-ip']) {
        sourceIp = route['snmp-net-source-ip']
        needRemoteCheck = false
      }
      if (sourceIp && needRemoteCheck) {
        fullCommand += ` -s ${sourceIp}`
      } else if (sourceIp && !needRemoteCheck) {
        fullCommand += ` -s ${sourceIp}`
      }
    }
  }

  if (args.length > 0) {
    fullCommand += ` ${args.join(' ')}`
  }

  if (command.includes('snmpwalk') && args.length > 0 && needRemoteCheck) {
    // Если не нашли в routes — проверяем remotes
    if (targetIp) {
      const remote = snmpRemotes.find(r => targetIp.startsWith(r.subnet))
      if (remote && process.env.SNMP_TOKEN) {
        try {
          // Для remote -s не нужен, поэтому пересобираем команду без -s
          let remoteCommand = command
          if (args.length > 0) {
            remoteCommand += ` ${args.join(' ')}`
          }
          const postData = {
            cmdText: remoteCommand,
            value: value === undefined ? '' : value
          }
          if (SNMP_DEBUG_LEVEL > 0) logWithTime('[REMOTE SNMP POST]', { url: remote.url, body: postData })
          const postHeaders = {
            Authorization: process.env.SNMP_TOKEN,
            'Content-Type': 'application/json'
          }
          const response = await axios.post(remote.url, postData, { headers: postHeaders })
          const stdout = response.data.result || ''
          const stderr = response.data.stderr || ''
          if (command.includes('pfctl')) {
            logWithTime(`${command} out: ${stdout}`)
          }
          if (stderr && stderr.toLowerCase().includes('timeout')) {
            logWithTime(`[ERROR] Timeout for ${command}`)
          } else if (stderr) {
            logWithTime(`[ERROR] ${command}: ${stderr.split('\n')[0]}`)
          }
          if (remoteCommand.includes('1.3.6.1.2.1.31.1.1.1.6') || remoteCommand.includes('1.3.6.1.2.1.31.1.1.1.10')) {
            return stdout.split(' ').pop().trim()
          }
          if (stdout.includes(value)) {
            return 'Status OK'
          } else {
            return 'Status PROBLEM'
          }
          return { stdout, stderr }
        } catch (err) {
          if (err && err.message && err.message.toLowerCase().includes('timeout')) {
            logWithTime(`[ERROR] Timeout for ${command}`)
          } else {
            logWithTime('[ERROR] SNMP remote axios:', err.message || err)
          }
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
