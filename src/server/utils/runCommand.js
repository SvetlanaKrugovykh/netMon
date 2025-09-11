const { spawn } = require('child_process')

async function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    })

    let stdout = ''
    let stderr = ''

    process.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    process.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    process.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: code })
      } else {
        if (stderr && stderr.toLowerCase().includes('timeout')) {
          console.error(`[ERROR] Timeout for ${command} ${args.join(' ')} | CMD: ${command} ${args.join(' ')}`)
        } else {
          console.error(`Command failed: ${command} ${args.join(' ')}`)
        }
        resolve({ stdout, stderr, exitCode: code })
      }
    })

    process.on('error', (error) => {
      reject(error)
    })
  })
}

module.exports = { runCommand }
