const { Pool } = require('pg')
const fs = require('fs')
let ejs
try {
  ejs = require('ejs')
} catch (err) {
  ejs = null
  console.warn('ejs module is not installed. MRTG report generation will be unavailable on this server.')
}
const path = require('path')
const axios = require('axios')
const FormData = require('form-data')
let ChartJSNodeCanvas
try {
  ChartJSNodeCanvas = require('chartjs-node-canvas').ChartJSNodeCanvas
} catch (err) {
  ChartJSNodeCanvas = null
  if (process.env.MRTG_DEBUG === '9')
    console.warn('chartjs-node-canvas module is not installed. MRTG report generation will be unavailable on this server.')
}

const pool = new Pool({
  user: process.env.TRAFFIC_DB_USER,
  host: process.env.TRAFFIC_DB_HOST,
  database: process.env.TRAFFIC_DB_NAME,
  password: process.env.TRAFFIC_DB_PASSWORD,
  port: process.env.TRAFFIC_DB_PORT,
})

module.exports.generateMrtgReport = async function (chatID) {
  if (!ChartJSNodeCanvas || !ejs) {
    console.warn('MRTG report generation is not available on this server.')
    return { success: false, error: 'MRTG report generation is not available on this server.' }
  }
  if (!ChartJSNodeCanvas) {
    console.warn('MRTG report generation is not available on this server.')
    return { success: false, error: 'MRTG report generation is not available on this server.' }
  }
  try {
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: 800, height: 400 })
    console.log('ChartJSNodeCanvas initialized successfully')

    const INTERVAL_SECONDS = parseInt(process.env.SNMP_MRTG_POOLING_INTERVAL)
    const maxCounter64 = BigInt('18446744073709551615')

    const query = `
      SELECT ip, dev_port, object_name, object_value_in, object_value_out, timestamp
      FROM mrtg_data
      WHERE timestamp >= NOW() - INTERVAL '24 HOURS'
      ORDER BY ip, dev_port, timestamp
    `
    const { rows } = await pool.query(query)

    const groupedData = {}
    rows.forEach(row => {
      const key = `${row.ip}:${row.dev_port}`
      if (!groupedData[key]) {
        groupedData[key] = {
          ip: row.ip,
          dev_port: row.dev_port,
          timestamps: [],
          inDiffs: [],
          outDiffs: [],
          inLast: 0n,
          outLast: 0n,
        }
      }

      const last = groupedData[key]
      const row_in = BigInt(row.object_value_in)
      const row_out = BigInt(row.object_value_out)
      const divisor = BigInt(INTERVAL_SECONDS * 1024 * 1024)

      let MAX_TRAFFIC_MBPS = 1024 * 1024
      if (Number(row.dev_port) > 10 && Number(row.dev_port) < 25) MAX_TRAFFIC_MBPS = 1024

      if (row_in !== 0n) {
        let inDiff

        if (last.timestamps.length > 0) {
          if (row_in >= last.inLast) {
            inDiff = row_in - last.inLast
          } else {
            inDiff = maxCounter64 - last.inLast + row_in
          }
          inDiff = Number((inDiff * 8n) / divisor)
          inDiff = Math.min(inDiff, MAX_TRAFFIC_MBPS)

          if (inDiff > 0 && inDiff < MAX_TRAFFIC_MBPS) {
            last.inDiffs.push(inDiff)
          }
        }
        last.inLast = row_in
      }

      if (row_out !== 0n) {
        let outDiff
        if (last.timestamps.length > 0) {
          if (row_out >= last.outLast) {
            outDiff = row_out - last.outLast
          } else {
            outDiff = maxCounter64 - last.outLast + row_out
          }
          outDiff = Number((outDiff * 8n) / divisor)
          outDiff = Math.min(outDiff, MAX_TRAFFIC_MBPS)

          if (outDiff > 0 && outDiff < MAX_TRAFFIC_MBPS) {
            last.outDiffs.push(outDiff)
          }
        }
        last.outLast = row_out
        last.timestamps.push(row.timestamp)
      }
    })

    const charts = []
    for (const key in groupedData) {
      const data = groupedData[key]
      const chartConfig = {
        type: 'line',
        data: {
          labels: data.timestamps.map(ts => {
            const localDate = new Date(ts);
            return localDate.toLocaleTimeString('uk-UA', {
              timeZone: 'Europe/Kiev',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            })
          }),
          datasets: [
            {
              label: 'Input Traffic (Mbps)',
              data: data.inDiffs,
              borderColor: 'rgba(75, 192, 192, 1)',
              backgroundColor: 'rgba(75, 192, 192, 0.2)',
              fill: true,
            },
            {
              label: 'Output Traffic (Mbps)',
              data: data.outDiffs,
              borderColor: 'rgba(0, 76, 153, 1)',
              backgroundColor: 'rgba(0, 76, 153, 0.2)',
              fill: true,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { position: 'top' },
          },
          scales: {
            x: { title: { display: true, text: 'Time' } },
            y: {
              title: { display: true, text: 'Traffic (Mbps)' },
              ticks: {
                callback: value => {
                  return (value).toFixed(2) + ' Mbps'
                },
              },
            },
          },
        },
      }

      const chartImage = await chartJSNodeCanvas.renderToDataURL(chartConfig)
      charts.push({ ip: data.ip, dev_port: data.dev_port, chartImage })
    }

    const templatePath = path.join(__dirname, 'template.ejs')

    const html = await ejs.renderFile(templatePath, { charts })

    const TEMP_CATALOG = process.env.TEMP_CATALOG || './'
    const outputPath = `${TEMP_CATALOG}mrtg_report.html`

    fs.writeFileSync(outputPath, html)
    console.log(`Report generated: ${outputPath}`)

    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
    const telegramChatId = chatID
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendDocument`
    const formData = new FormData()
    formData.append('chat_id', telegramChatId)
    formData.append('document', fs.createReadStream(outputPath))

    await axios.post(url, formData, {
      headers: formData.getHeaders(),
    })

    return { success: true }
  } catch (err) {
    console.error('Error generating MRTG report:', err.message)
    return { success: false, error: err.message }
  }
}