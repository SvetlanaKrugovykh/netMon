const axios = require('axios')
require('dotenv').config()

async function getChatId() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

  if (!TELEGRAM_BOT_TOKEN) {
    console.log('❌ TELEGRAM_BOT_TOKEN not found in .env')
    return
  }

  console.log('=== GETTING CHAT ID ===')
  console.log('Bot Token:', TELEGRAM_BOT_TOKEN.substring(0, 10) + '...')
  console.log('')
  console.log('📝 Instructions:')
  console.log('1. Go to your Telegram group')
  console.log('2. Send any message (like "test")')
  console.log('3. Wait 5 seconds and check results below...')
  console.log('')

  await new Promise(resolve => setTimeout(resolve, 5000))

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    )

    if (response.data.ok && response.data.result.length > 0) {
      console.log('📨 Recent messages found:')
      console.log('')

      const updates = response.data.result.slice(-5)

      updates.forEach((update, index) => {
        const message = update.message
        if (message && message.chat) {
          console.log(`Message ${index + 1}:`)
          console.log(`  Chat ID: ${message.chat.id}`)
          console.log(`  Chat Title: ${message.chat.title || 'Private Chat'}`)
          console.log(`  Chat Type: ${message.chat.type}`)
          console.log(`  Message: ${message.text || '[Media/Other]'}`)
          console.log(`  Date: ${new Date(message.date * 1000).toLocaleString()}`)
          console.log('---')
        }
      })

      const chatIds = [...new Set(updates
        .filter(u => u.message && u.message.chat)
        .map(u => u.message.chat.id))]

      console.log('')
      console.log('🎯 Found Chat IDs:')
      chatIds.forEach(id => console.log(`  ${id}`))

    } else {
      console.log('❌ No recent messages found')
      console.log('Make sure to send a message to the group first!')
    }

  } catch (error) {
    console.error('❌ Error:', error.message)
  }
}

getChatId()