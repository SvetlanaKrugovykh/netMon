#!/usr/bin/env node
require('dotenv').config()

const { runOpticMeasurementsOnce } = require('../src/server/services/opticDailyMeasurementsService')

async function main() {
  const args = process.argv.slice(2)
  const isDry = args.includes('--dry')

  console.log('[OpticDaily][Runner] Starting once. DRY-RUN =', isDry)
  console.log('[OpticDaily][Runner] Community =', process.env.OPTIC_SNMP_COMMUNITY || 'public')
  try {
    await runOpticMeasurementsOnce(isDry)
    console.log('[OpticDaily][Runner] Completed successfully')
  } catch (err) {
    console.error('[OpticDaily][Runner] Failed:', err && err.message ? err.message : err)
    process.exitCode = 1
  }
}

main()
