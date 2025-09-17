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
  let debugLog = ''
  
  if (SNMP_DEBUG_LEVEL > 1) {
    debugLog += `[START] ${new Date().toISOString()} Command: ${command} Args: ${args.join(' ')} Value: ${value}\n`
  }
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
    if (targetIp) {
      const remote = snmpRemotes.find(r => targetIp.startsWith(r.subnet))
      if (remote && process.env.SNMP_TOKEN) {
        try {
          let remoteCommand = command
          if (args.length > 0) {
            remoteCommand += ` ${args.join(' ')}`
          }
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[REMOTE] Full command: ${remoteCommand}\n`
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
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[REMOTE] Response: ${stdout}\n`
          }
          if (command.includes('pfctl')) {
            logWithTime(`${command} out: ${stdout}`)
          }
          if (stderr && stderr.toLowerCase().includes('timeout')) {
            logWithTime(`[ERROR] Timeout for ${command}`)
          } else if (stderr) {
            logWithTime(`[ERROR] ${command}: ${stderr.split('\n')[0]}`)
          }
          if (remoteCommand.includes('1.3.6.1.2.1.31.1.1.1.6') || remoteCommand.includes('1.3.6.1.2.1.31.1.1.1.10')) {
            const result = stdout.split(' ').pop().trim()
            if (SNMP_DEBUG_LEVEL > 1) {
              debugLog += `[RETURN] ${result}\n`
              logWithTime(`[DEBUG]\n${debugLog}`)
            }
            return result
          }
          if (stdout.includes(value)) {
            if (SNMP_DEBUG_LEVEL > 1) {
              debugLog += `[RETURN] Status OK\n`
              logWithTime(`[DEBUG]\n${debugLog}`)
            }
            return 'Status OK'
          } else {
            if (SNMP_DEBUG_LEVEL > 1) {
              debugLog += `[RETURN] Status PROBLEM\n`
              logWithTime(`[DEBUG]\n${debugLog}`)
            }
            return 'Status PROBLEM'
          }
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[RETURN] { stdout, stderr }\n`
            logWithTime(`[DEBUG]\n${debugLog}`)
          }
          return { stdout, stderr }
        } catch (err) {
          if (err && err.message && err.message.toLowerCase().includes('timeout')) {
            logWithTime(`[ERROR] Timeout for ${command}`)
          } else {
            logWithTime('[ERROR] SNMP remote axios:', err.message || err)
          }
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[RETURN] null (error)\n`
            logWithTime(`[DEBUG]\n${debugLog}`)
          }
          return null
        }
      }
    }
  }
  try {
    if (SNMP_DEBUG_LEVEL > 1) {
      debugLog += `[LOCAL] Full command: ${fullCommand}\n`
    }
    const { stdout, stderr } = await exec(fullCommand)
    if (SNMP_DEBUG_LEVEL > 1) {
      debugLog += `[LOCAL] Response stdout: ${stdout}\n`
      debugLog += `[LOCAL] Response stderr: ${stderr}\n`
    }
    if (command.includes('pfctl')) {
      logWithTime(`${command} out: ${stdout}`)
    }
    if (stderr && stderr.toLowerCase().includes('timeout')) {
      logWithTime(`[ERROR] Timeout for ${command}`)
    } else if (stderr) {
      logWithTime(`[ERROR] ${command}: ${stderr.split('\n')[0]}`)
    }
    if (fullCommand.includes('1.3.6.1.2.1.31.1.1.1.6') || fullCommand.includes('1.3.6.1.2.1.31.1.1.1.10')) {
      const result = stdout.split(' ').pop().trim()
      if (SNMP_DEBUG_LEVEL > 1) {
        debugLog += `[RETURN] ${result}\n`
        logWithTime(`[DEBUG]\n${debugLog}`)
      }
      return result
    }
    if (stdout.includes(value)) {
      if (SNMP_DEBUG_LEVEL > 1) {
        debugLog += `[RETURN] Status OK\n`
        logWithTime(`[DEBUG]\n${debugLog}`)
      }
      return 'Status OK'
    } else {
      if (SNMP_DEBUG_LEVEL > 1) {
        debugLog += `[RETURN] Status PROBLEM\n`
        logWithTime(`[DEBUG]\n${debugLog}`)
      }
      return 'Status PROBLEM'
    }
    if (SNMP_DEBUG_LEVEL > 1) {
      debugLog += `[RETURN] { stdout, stderr }\n`
      logWithTime(`[DEBUG]\n${debugLog}`)
    }
    return { stdout, stderr }
  } catch (error) {
    if (error && error.message && error.message.toLowerCase().includes('timeout')) {
      logWithTime(`[ERROR] Timeout for ${command}`)
    } else {
      logWithTime(`[ERROR] ${command}: ${error.message}`)
    }
    if (SNMP_DEBUG_LEVEL > 1) {
      debugLog += `[RETURN] null (error)\n`
      logWithTime(`[DEBUG]\n${debugLog}`)
    }
    return null
  }
}

module.exports = { runCommand }
