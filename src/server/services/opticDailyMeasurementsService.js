const fs = require('fs')
const path = require('path')
const snmp = require('snmp-native')
const { runCommand } = require('../utils/commandsOS')
const { sendToChat } = require('../modules/to_local_DB')

const DAILY_HOUR = 9
const DAILY_MINUTE = 30
const OPTIC_COMMUNITY = process.env.OPTIC_SNMP_COMMUNITY || 'public'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
const OPTIC_ENABLED = process.env.OPTIC_MEASUREMENTS_ENABLED !== 'false'
const IMMEDIATE_RUN = process.env.OPTIC_MEASUREMENTS_RUN_IMMEDIATELY === 'true'
const SNMP_CLIENT_TIMEOUT_SEC = parseInt(process.env.SNMP_CLIENT_TIMEOUT_SEC || '5')

function resolveConfigPath() {
  // 1) explicit env override (absolute or relative to cwd)
  const envPath = (process.env.OPTIC_MEASUREMENTS_CONFIG || '').trim()
  if (envPath) {
    const abs = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath)
    if (fs.existsSync(abs)) {
      console.log('[OpticDaily] Using config from OPTIC_MEASUREMENTS_CONFIG:', abs)
      return abs
    } else {
      console.error('[OpticDaily] OPTIC_MEASUREMENTS_CONFIG points to missing file:', abs)
    }
  }
  // 2) local file next to repo (git-ignored)
  const localPath = path.resolve(__dirname, '..', '..', 'data', 'opticMeasurements.local.json')
  if (fs.existsSync(localPath)) {
    console.log('[OpticDaily] Using local config:', localPath)
    return localPath
  }
  // 3) fallback to sample committed in repo
  const samplePath = path.resolve(__dirname, '..', '..', 'data', 'opticMeasurements.sample.json')
  if (fs.existsSync(samplePath)) {
    console.log('[OpticDaily] Using sample config:', samplePath)
    return samplePath
  }
  // 4) not found => return default local path and let reader fail gracefully
  return localPath
}

function msUntilNextRun(hour, minute) {
  const now = new Date()
  const next = new Date(now.getTime())
  next.setHours(hour, minute, 0, 0)
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return { delayMs: next.getTime() - now.getTime(), next }
}

function loadMeasurementsConfig() {
  try {
    const cfgPath = resolveConfigPath()
    const raw = fs.readFileSync(cfgPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('[OpticDaily] Config is not an array, path:', cfgPath)
      return []
    }
    const normalized = parsed
      .map(item => ({
        name: item.name || item.description,
        ip_address: item.ip_address,
        oid: item.oid,
        unit: item.unit || '',
        value: item.value || ''
      }))
      .filter(item => item.name && item.ip_address && item.oid)
    if (normalized.length === 0) {
      console.error('[OpticDaily] Config array is empty after validation')
    }
    return normalized
  } catch (err) {
    console.error('[OpticDaily] Unable to read config file', { error: err.message })
    return []
  }
}

function cleanValue(raw) {
  if (!raw && raw !== 0) return ''
  return raw.toString()
    .replace(/value/gi, '')
    .replace(/Status OK/gi, '')
    .replace(/Status PROBLEM/gi, '')
    .replace(/=/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function collectMeasurements(definitions) {
  const results = []
  for (const item of definitions) {
    let response = ''
    try {
      // Prefer direct SNMP get via snmp-native to obtain raw values
      const isSingleOid = /^\.?\d+(?:\.\d+)+$/.test(item.oid)
      if (isSingleOid) {
        const session = new snmp.Session({ host: item.ip_address, community: OPTIC_COMMUNITY, timeout: SNMP_CLIENT_TIMEOUT_SEC * 1000 })
        try {
          const varbinds = await new Promise((resolve, reject) => {
            session.get({ oid: item.oid }, (error, vb) => {
              if (error) return reject(error)
              resolve(vb)
            })
          })
          if (Array.isArray(varbinds) && varbinds.length > 0) {
            response = varbinds[0].value
          } else {
            response = null
          }
        } catch (err) {
          console.error('[OpticDaily] SNMP-native error', { name: item.name, ip: item.ip_address, oid: item.oid, error: err.message })
          response = null
        } finally {
          try { session.close() } catch (_) {}
        }
      } else {
        // Fallback to CLI for non-scalar OIDs
        response = await runCommand(
          'snmpwalk',
          ['-v', '2c', '-c', OPTIC_COMMUNITY, '-OXsq', '-On', item.ip_address, item.oid],
          item.value || ''
        )
      }
    } catch (err) {
      console.error('[OpticDaily] SNMP error', { name: item.name, ip: item.ip_address, oid: item.oid, error: err.message })
      response = null
    }

    const cleaned = cleanValue(response)
    const formattedValue = cleaned ? `${cleaned}${item.unit ? ` ${item.unit}` : ''}` : 'n/a'
    results.push({
      name: item.name,
      value: formattedValue,
      raw: response
    })
  }
  return results
}

function formatMessage(results) {
  if (!results || results.length === 0) return ''

  const ts = new Date()
  const tsStr = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`

  const nameWidth = Math.max('Name'.length, ...results.map(item => item.name.length))
  const valWidth = Math.max('Value'.length, ...results.map(item => item.value.length))

  function line(char) {
    return `${char}${'-'.repeat(nameWidth + 2)}+${'-'.repeat(valWidth + 2)}${char}`
  }

  const header = line('+')
  const rows = results.map(item => {
    const nameCell = item.name.padEnd(nameWidth, ' ')
    const valCell = item.value.padEnd(valWidth, ' ')
    return `| ${nameCell} | ${valCell} |`
  })

  return [
    `Optic measurements ${tsStr}`,
    header,
    `| ${'Name'.padEnd(nameWidth, ' ')} | ${'Value'.padEnd(valWidth, ' ')} |`,
    header.replace(/\+/g, '+'),
    ...rows,
    header
  ].join('\n')
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[OpticDaily] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
    console.error('[OpticDaily] Token present:', !!TELEGRAM_BOT_TOKEN, 'Chat ID present:', !!TELEGRAM_CHAT_ID)
    return
  }
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  try {
    console.log('[OpticDaily][Telegram] Sending to chat:', TELEGRAM_CHAT_ID)
    console.log('[OpticDaily][Telegram] Message length:', text.length)
    const response = await sendToChat(apiUrl, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, text)
    console.log('[OpticDaily][Telegram] Response received:', !!response)
    if (!response) {
      console.error('[OpticDaily] Failed to send Telegram message')
    } else {
      console.log('[OpticDaily] Message sent successfully')
    }
  } catch (err) {
    console.error('[OpticDaily] Telegram send error:', err.message || err)
  }
}

async function runOpticMeasurementsOnce(dryRun = false) {
  console.log('[OpticDaily] runOpticMeasurementsOnce called with dryRun=', dryRun)
  const config = loadMeasurementsConfig()
  if (!config.length) {
    console.error('[OpticDaily] Nothing to measure (empty config)')
    return
  }

  const results = await collectMeasurements(config)
  const message = formatMessage(results)
  if (!message) {
    console.error('[OpticDaily] Nothing to send to Telegram (empty message)')
    return
  }
  const envDry = (process.env.OPTIC_DRY_RUN || '').toLowerCase() === 'true'
  console.log('[OpticDaily] dryRun=', dryRun, ', envDry=', envDry, ', OPTIC_DRY_RUN env=', process.env.OPTIC_DRY_RUN)
  if (dryRun || envDry) {
    console.log('[OpticDaily][DRY-RUN] Message to be sent:')
    console.log(message)
    return
  }
  console.log('[OpticDaily] About to send Telegram message')
  await sendTelegramMessage(message)
}

function scheduleNextRun() {
  const { delayMs, next } = msUntilNextRun(DAILY_HOUR, DAILY_MINUTE)
  console.log('[OpticDaily] Next run scheduled at (local):', next.toLocaleString())
  console.log('[OpticDaily] Next run scheduled at (UTC):  ', next.toISOString())
  setTimeout(async () => {
    await runOpticMeasurementsOnce()
    scheduleNextRun()
  }, delayMs)
}

function startOpticMeasurementsScheduler() {
  if (!OPTIC_ENABLED) {
    console.log('[OpticDaily] Scheduler disabled via OPTIC_MEASUREMENTS_ENABLED')
    return
  }
  const now = new Date()
  console.log('[OpticDaily] Scheduler enabled. Current time (local):', now.toLocaleString())
  console.log('[OpticDaily] Daily run time (local):', `${String(DAILY_HOUR).padStart(2,'0')}:${String(DAILY_MINUTE).padStart(2,'0')}`)
  if (IMMEDIATE_RUN) {
    console.log('[OpticDaily] IMMEDIATE_RUN is true -> executing once now')
    runOpticMeasurementsOnce((process.env.OPTIC_DRY_RUN || '').toLowerCase() === 'true')
  }
  scheduleNextRun()
}

module.exports = {
  startOpticMeasurementsScheduler,
  runOpticMeasurementsOnce
}
