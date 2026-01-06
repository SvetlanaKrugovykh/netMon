const fs = require('fs')
const path = require('path')
const snmp = require('snmp-native')
const cron = require('node-cron')
const { runCommand } = require('../utils/commandsOS')
const { sendToChat } = require('../modules/to_local_DB')

const CRON_SCHEDULE = process.env.MAIN_MEASUREMENTS_CRON || '0 */3 * * *'
const MAIN_COMMUNITY = process.env.MAIN_SNMP_COMMUNITY || 'public'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
const MAIN_ENABLED = process.env.MAIN_MEASUREMENTS_ENABLED !== 'false'
const IMMEDIATE_RUN = process.env.MAIN_MEASUREMENTS_RUN_IMMEDIATELY === 'true'
const SNMP_CLIENT_TIMEOUT_SEC = parseInt(process.env.SNMP_CLIENT_TIMEOUT_SEC || '5', 10)
const QUIET_START = parseInt(process.env.MAIN_MEASUREMENTS_QUIET_START_HOUR || '23', 10)
const QUIET_END = parseInt(process.env.MAIN_MEASUREMENTS_QUIET_END_HOUR || '7', 10)

function parseThreshold(value) {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function resolveConfigPath() {
  const envPath = (process.env.MAIN_MEASUREMENTS_CONFIG || '').trim()
  if (envPath) {
    const abs = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath)
    if (fs.existsSync(abs)) {
      console.log('[MainDaily] Using config from MAIN_MEASUREMENTS_CONFIG:', abs)
      return abs
    }
    console.error('[MainDaily] MAIN_MEASUREMENTS_CONFIG points to missing file:', abs)
  }

  const localPath = path.resolve(__dirname, '..', '..', 'data', 'mainMeasurements.local.json')
  if (fs.existsSync(localPath)) {
    console.log('[MainDaily] Using local config:', localPath)
    return localPath
  }

  const samplePath = path.resolve(__dirname, '..', '..', 'data', 'mainMeasurements.sample.json')
  if (fs.existsSync(samplePath)) {
    console.log('[MainDaily] Using sample config:', samplePath)
    return samplePath
  }

  return localPath
}

function evaluateStatus(numericValue, min, max) {
  if (!Number.isFinite(numericValue) || (min === undefined && max === undefined)) {
    return { icon: '❔', note: '' }
  }
  if (min !== undefined && numericValue < min) {
    return { icon: '🔴', note: 'below min' }
  }
  if (max !== undefined && numericValue > max) {
    return { icon: '🔴', note: 'above max' }
  }
  return { icon: '✅', note: '' }
}

function loadMeasurementsConfig() {
  try {
    const cfgPath = resolveConfigPath()
    const raw = fs.readFileSync(cfgPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('[MainDaily] Config is not an array, path:', cfgPath)
      return []
    }
    const normalized = parsed
      .map(item => ({
        name: item.name || item.description,
        ip_address: item.ip_address,
        oid: item.oid,
        unit: item.unit || '',
        value: item.value || '',
        min: parseThreshold(item.min),
        max: parseThreshold(item.max)
      }))
      .filter(item => item.name && item.ip_address && item.oid)
    if (normalized.length === 0) {
      console.error('[MainDaily] Config array is empty after validation')
    }
    return normalized
  } catch (err) {
    console.error('[MainDaily] Unable to read config file', { error: err.message })
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
      const isSingleOid = /^\.?\d+(?:\.\d+)+$/.test(item.oid)
      if (isSingleOid) {
        const session = new snmp.Session({ host: item.ip_address, community: MAIN_COMMUNITY, timeout: SNMP_CLIENT_TIMEOUT_SEC * 1000 })
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
          console.error('[MainDaily] SNMP-native error', { name: item.name, ip: item.ip_address, oid: item.oid, error: err.message })
          response = null
        } finally {
          try { session.close() } catch (_) {}
        }
      } else {
        response = await runCommand(
          'snmpwalk',
          ['-v', '2c', '-c', MAIN_COMMUNITY, '-OXsq', '-On', item.ip_address, item.oid],
          item.value || ''
        )
      }
    } catch (err) {
      console.error('[MainDaily] SNMP error', { name: item.name, ip: item.ip_address, oid: item.oid, error: err.message })
      response = null
    }

    const cleaned = cleanValue(response)
    const numericValue = Number.parseFloat(cleaned)
    const numeric = Number.isFinite(numericValue) ? numericValue : undefined
    const formattedValue = cleaned ? `${cleaned}${item.unit ? ` ${item.unit}` : ''}` : 'n/a'
    results.push({
      name: item.name,
      value: formattedValue,
      raw: response,
      min: item.min,
      max: item.max,
      numeric
    })
  }
  return results
}

function formatMessage(results) {
  if (!results || results.length === 0) return { message: '', hasAlert: false }

  const ts = new Date()
  const tsStr = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`

  let hasAlert = false
  function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return 'n/a';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days} дн ${hours} ч ${minutes} мин`;
  }

  const dataWithIcons = results.map(item => {
    const directionIcon = item.name.toLowerCase().includes('rx')
      ? '📥'
      : item.name.toLowerCase().includes('tx')
        ? '📤'
        : '  '
    let status, value, thresholdText = ''
    if (item.name.toLowerCase().includes('uptime')) {
      // Uptime: < 86400
      if (item.numeric !== undefined && item.numeric < 86400) {
        status = { icon: '🔴', note: 'rebooted today' }
        hasAlert = true
      } else {
        status = { icon: '✅', note: '' }
      }
      value = formatUptime(item.numeric)
    } else {
      status = evaluateStatus(item.numeric, item.min, item.max)
      if (status.icon === '🔴') hasAlert = true
      value = item.value
      const thresholds = []
      if (item.min !== undefined) thresholds.push(`min ${item.min}`)
      if (item.max !== undefined) thresholds.push(`max ${item.max}`)
      thresholdText = thresholds.length ? thresholds.join(' / ') : ''
    }
    return { name: item.name, value, directionIcon, statusIcon: status.icon, thresholdText }
  })

  const nameWidth = Math.max(...dataWithIcons.map(item => item.name.length))
  const alignmentPos = nameWidth + 2

  const rows = dataWithIcons.map(item => {
    const nameCell = item.name.padEnd(alignmentPos, ' ')
    const thresholds = item.thresholdText ? `  [${item.thresholdText}]` : ''
    // Highlight value in bold for Telegram HTML
    const valueBold = item.value.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `${item.directionIcon} ${item.statusIcon} ${nameCell}<b>${valueBold}</b>${thresholds}`
  })

  return {
    message: [
      '📊 Main Measurements Report',
      `🕐 ${tsStr}`,
      '',
      ...rows,
      '',
      '✅ Measurements completed'
    ].join('\n'),
    hasAlert
  }
}

function isQuietHours(date = new Date()) {
  const hour = date.getHours()
  if (Number.isNaN(QUIET_START) || Number.isNaN(QUIET_END)) return false
  if (QUIET_START === QUIET_END) return false
  if (QUIET_START < QUIET_END) {
    return hour >= QUIET_START && hour < QUIET_END
  }
  // Quiet hours wrap past midnight
  return hour >= QUIET_START || hour < QUIET_END
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[MainDaily] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
    return
  }
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  try {
    const response = await sendToChat(apiUrl, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, text)
    if (!response) {
      console.error('[MainDaily] Failed to send Telegram message')
    } else {
      console.log('[MainDaily] ✅ Measurements sent to Telegram')
    }
  } catch (err) {
    console.error('[MainDaily] Telegram send error:', err.message || err)
  }
}

async function runMainMeasurementsOnce(dryRun = false) {
  const config = loadMeasurementsConfig()
  if (!config.length) {
    console.error('[MainDaily] Nothing to measure (empty config)')
    return
  }

  const results = await collectMeasurements(config)
  const { message, hasAlert } = formatMessage(results)
  if (!message) {
    console.error('[MainDaily] Nothing to send to Telegram (empty message)')
    return
  }

  const quiet = isQuietHours()
  if (quiet && !hasAlert) {
    console.log('[MainDaily] Quiet hours with all parameters OK -> message suppressed')
    return
  }

  if (dryRun) {
    console.log('[MainDaily][DRY-RUN] Message preview:')
    console.log(message)
    return
  }

  await sendTelegramMessage(message)
}

function scheduleNextRun() {
  console.log('[MainDaily] Cron scheduler enabled for:', CRON_SCHEDULE)
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log('[MainDaily] Cron triggered at', new Date().toISOString())
    await runMainMeasurementsOnce()
  })
}

function startMainMeasurementsScheduler() {
  if (!MAIN_ENABLED) {
    console.log('[MainDaily] Scheduler disabled via MAIN_MEASUREMENTS_ENABLED')
    return
  }
  const now = new Date()
  console.log('[MainDaily] Scheduler enabled. Current time (local):', now.toLocaleString())
  console.log('[MainDaily] Cron expression:', CRON_SCHEDULE)
  if (IMMEDIATE_RUN) {
    console.log('[MainDaily] IMMEDIATE_RUN is true -> executing once now')
    runMainMeasurementsOnce((process.env.MAIN_MEASUREMENTS_DRY_RUN || '').toLowerCase() === 'true')
  }
  scheduleNextRun()
}

module.exports = {
  startMainMeasurementsScheduler,
  runMainMeasurementsOnce
}
