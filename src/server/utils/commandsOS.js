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
  let isSnmpSingleOid = false
  let snmpTimeoutSec = parseInt(process.env.SNMP_CLIENT_TIMEOUT_SEC) || 5
  if (command.includes('snmpwalk') && args.length > 0) {
    const oidArgs = args.filter(a => /^\.?\d+(\.\d+)+$/.test(a))
    if (oidArgs.length === 1) {
      isSnmpSingleOid = true
    }
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
    if (command.includes('snmpwalk') && isSnmpSingleOid) {
      let localArgs = args.filter(a => a !== '-OXsq')
      if (!localArgs.includes('-Oqv')) localArgs.unshift('-Oqv')
      if (!localArgs.includes('-On')) localArgs.unshift('-On')
      if (!localArgs.includes('-t')) {
        localArgs.unshift((snmpTimeoutSec).toString())
        localArgs.unshift('-t')
      }
      fullCommand = 'snmpget' + ` ${localArgs.join(' ')}`
    } else {
      fullCommand += ` ${args.join(' ')}`
    }
  }

  if (command.includes('snmpwalk') && args.length > 0 && needRemoteCheck) {
    if (targetIp) {
      const remote = snmpRemotes.find(r => targetIp.startsWith(r.subnet))
      if (remote && process.env.SNMP_TOKEN) {
        try {
          let remoteCommand = command
          let remoteArgs = [...args]
          let useSnmpget = false
          let remoteTimeout = snmpTimeoutSec;
          const oidArgs = args.filter(a => /^\.?\d+(\.\d+)+$/.test(a))
          if (oidArgs.length === 1) {
            remoteCommand = 'snmpget'
            useSnmpget = true
            remoteArgs = args.filter(a => a !== '-OXsq')
            if (!remoteArgs.includes('-Oqv')) remoteArgs.unshift('-Oqv')
            if (!remoteArgs.includes('-On')) remoteArgs.unshift('-On')
            if (!remoteArgs.includes('-t')) {
              remoteArgs.unshift(remoteTimeout.toString())
              remoteArgs.unshift('-t')
            }
          }
          let remoteCommandLine = remoteCommand
          if (remoteArgs.length > 0) {
            remoteCommandLine += ` ${remoteArgs.join(' ')}`
          }
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[REMOTE] Full command: ${remoteCommandLine}\n`
          }
          const postData = {
            cmdText: remoteCommandLine,
            value: value === undefined ? '' : value
          }
          if (SNMP_DEBUG_LEVEL > 0) logWithTime('[REMOTE SNMP POST]', { url: remote.url, body: postData })
          const postHeaders = {
            Authorization: process.env.SNMP_TOKEN,
            'Content-Type': 'application/json'
          }
          let response
          try {
            const axiosTimeoutMs = parseInt(process.env.SNMP_CLIENT_TIMEOUT_SEC) * 1000 || 10000
            const localAddr = process.env.SNMP_SOURCE_IP || undefined
            const startedAll = Date.now()
            let lastErr = null
            for (let attempt = 1; attempt <= 2; attempt++) {
              const attemptStart = Date.now()
              try {
                response = await axios.post(
                  remote.url,
                  postData,
                  {
                    headers: postHeaders,
                    timeout: axiosTimeoutMs,
                    localAddress: localAddr
                  }
                )
                const elapsedMs = Date.now() - attemptStart
                if (SNMP_DEBUG_LEVEL > 1) {
                  debugLog += `[REMOTE] AXIOS SUCCESS attempt=${attempt} elapsedMs=${elapsedMs}\n`
                }
                break
              } catch (err) {
                lastErr = err
                const isTimeout = err.code === 'ECONNABORTED' || (err.message && err.message.toLowerCase().includes('timeout'))
                const elapsedMs = Date.now() - attemptStart
                logWithTime(`[ERROR] REMOTE axios attempt ${attempt} ${isTimeout ? 'TIMEOUT' : 'FAIL'}`, {
                  url: remote.url,
                  ip: targetIp,
                  oid: args && args.length > 0 ? args[args.length - 1] : undefined,
                  expectedValue: value === undefined ? '' : value,
                  axiosTimeoutMs,
                  localAddress: localAddr,
                  elapsedMs,
                  totalElapsedMs: Date.now() - startedAll,
                  error: err.message || err
                })
                if (attempt === 2) {
                  throw err
                }
              }
            }
            if (!response) {
              return null
            }
          } catch (err) {

            if (SNMP_DEBUG_LEVEL > 1) {
              debugLog += `[REMOTE] AXIOS FINAL ERROR: ${err.message}\n`
              logWithTime(`[DEBUG]\n${debugLog}`)
            }
            return null
          }
          const stdout = response.data.result || ''
          const stderr = response.data.stderr || ''
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[REMOTE] Response: ${stdout}\n`
          }
          if (command.includes('pfctl')) {
            logWithTime(`${command} out: ${stdout}`)
          }
          if (stderr && stderr.toLowerCase().includes('timeout')) {
            logWithTime(`[ERROR] Timeout for ${command}`, {
              phase: 'remote-stdout-stderr',
              fullCommand: remoteCommand,
              args,
              ip: targetIp,
              oid: args && args.length > 0 ? args[args.length - 1] : undefined,
              expectedValue: value === undefined ? '' : value,
              localAddress: process.env.SNMP_SOURCE_IP,
              stderrFirstLine: stderr.split('\n')[0]
            })
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
          const evalResult = (() => {
            if (!value) {
              PROBLEM
              return 'Status OK'
            }
            const operStatusMap = {
              up: '1',
              down: '2',
              testing: '3',
              unknown: '4',
              dormant: '5',
              notPresent: '6',
              lowerLayerDown: '7'
            }
            const tokens = stdout.trim().split(/\s+/)
            const lastToken = tokens[tokens.length - 1] || ''
            let normalized = lastToken
            if (operStatusMap[normalized] !== undefined) {
              normalized = operStatusMap[normalized]
            }
            const expectedNumeric = /^\d+$/.test(value)
            const normalizedNumeric = /^\d+$/.test(normalized)
            if (expectedNumeric && normalizedNumeric) {
              return normalized === value ? 'Status OK' : `Status PROBLEM (got=${normalized} expected=${value})`
            }
            return stdout.includes(value) ? 'Status OK' : 'Status PROBLEM'
          })()
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[RETURN] ${evalResult}\n`
            logWithTime(`[DEBUG]\n${debugLog}`)
          }
          return evalResult
          if (SNMP_DEBUG_LEVEL > 1) {
            debugLog += `[RETURN] { stdout, stderr }\n`
            logWithTime(`[DEBUG]\n${debugLog}`)
          }
          return { stdout, stderr }
        } catch (err) {
          if (err && err.message && err.message.toLowerCase().includes('timeout')) {
            logWithTime(`[ERROR] Timeout for ${command}`, {
              phase: 'remote-catch',
              fullCommand: fullCommand,
              args,
              ip: targetIp,
              oid: args && args.length > 0 ? args[args.length - 1] : undefined,
              expectedValue: value === undefined ? '' : value,
              localAddress: process.env.SNMP_SOURCE_IP,
              error: err.message
            })
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
      logWithTime(`[ERROR] Timeout for ${command}`, {
        phase: 'local-stderr',
        fullCommand,
        args,
        expectedValue: value === undefined ? '' : value,
        stderrFirstLine: stderr.split('\n')[0]
      })
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
    if (!value) {
      if (SNMP_DEBUG_LEVEL > 1) {
        debugLog += `[RETURN] Status OK (no expected value)\n`
        logWithTime(`[DEBUG]\n${debugLog}`)
      }
      return 'Status OK'
    }
    const operStatusMap = { up: '1', down: '2', testing: '3', unknown: '4', dormant: '5', notPresent: '6', lowerLayerDown: '7' }
    const tokens = stdout.trim().split(/\s+/)
    const lastToken = tokens[tokens.length - 1] || ''
    let normalized = lastToken
    if (operStatusMap[normalized] !== undefined) normalized = operStatusMap[normalized]
    const expectedNumeric = /^\d+$/.test(value)
    const normalizedNumeric = /^\d+$/.test(normalized)
    let finalStatus
    if (expectedNumeric && normalizedNumeric) {
      finalStatus = (normalized === value) ? 'Status OK' : `Status PROBLEM (got=${normalized} expected=${value})`
    } else {
      finalStatus = stdout.includes(value) ? 'Status OK' : 'Status PROBLEM'
    }
    if (SNMP_DEBUG_LEVEL > 1) {
      debugLog += `[RETURN] ${finalStatus}\n`
      logWithTime(`[DEBUG]\n${debugLog}`)
    }
    return finalStatus
    if (SNMP_DEBUG_LEVEL > 1) {
      debugLog += `[RETURN] { stdout, stderr }\n`
      logWithTime(`[DEBUG]\n${debugLog}`)
    }
    return { stdout, stderr }
  } catch (error) {
    if (error && error.message && error.message.toLowerCase().includes('timeout')) {
      logWithTime(`[ERROR] Timeout for ${command}`, {
        phase: 'local-exec-catch',
        fullCommand,
        args,
        expectedValue: value === undefined ? '' : value,
        error: error.message
      })
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
