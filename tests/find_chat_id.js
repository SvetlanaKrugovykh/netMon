const axios = require('axios')
require('dotenv').config()

async function getAllChatUpdates() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

  if (!TELEGRAM_BOT_TOKEN) {
    console.log('❌ TELEGRAM_BOT_TOKEN not found in .env')
    return
  }

  console.log('=== FINDING CORRECT CHAT ID ===')
  console.log('')
  console.log('📝 STEP BY STEP:')
  console.log('1. First, start private chat with @NetNotifySilverBot and send /start')
  console.log('2. Then go to your group and send: /chatid')
  console.log('3. Or forward any message from group to the bot')
  console.log('4. Press Enter to continue...')

  await new Promise(resolve => {
    process.stdin.once('data', () => resolve())
  })

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    )

    console.log('📊 Full API Response:')
    console.log(JSON.stringify(response.data, null, 2))

    if (response.data.ok && response.data.result.length > 0) {
      console.log('')
      console.log('📨 FOUND UPDATES:')
      console.log('')

      response.data.result.forEach((update, index) => {
        console.log(`--- Update ${index + 1} ---`)

        if (update.message) {
          const msg = update.message
          console.log('Type: message')
          console.log(`Chat ID: ${msg.chat.id}`)
          console.log(`Chat Type: ${msg.chat.type}`)
          console.log(`Chat Title: ${msg.chat.title || 'Private'}`)
          console.log(`Text: ${msg.text || '[no text]'}`)
          console.log(`From: ${msg.from.first_name} (${msg.from.username || 'no username'})`)

          if (msg.forward_from_chat) {
            console.log('🔄 FORWARDED FROM:')
            console.log(`  Original Chat ID: ${msg.forward_from_chat.id}`)
            console.log(`  Original Chat Title: ${msg.forward_from_chat.title}`)
            console.log(`  Original Chat Type: ${msg.forward_from_chat.type}`)
          }
        }

        console.log('')
      })

    } else {
      console.log('❌ No updates found. Make sure bot receives messages!')
    }

  } catch (error) {
    console.error('❌ Error:', error.message)
    if (error.response) {
      console.log('Response:', error.response.data)
    }
  }
}

getAllChatUpdates()