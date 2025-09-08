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
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`))
      }
    })
    
    process.on('error', (error) => {
      reject(error)
    })
  })
}

module.exports = { runCommand }
