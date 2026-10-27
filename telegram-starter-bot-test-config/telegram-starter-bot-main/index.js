// A Telegram bot you can deploy in one click and then make your own.
//
// Two ways to receive updates:
//   polling (default): the bot asks Telegram for updates. Works everywhere,
//     needs no web address, fine for almost every bot.
//   webhook: Telegram pushes updates to https://<your app>/telegram. Set
//     TELEGRAM_MODE=webhook and WEBHOOK_URL to the app's public address.
//
// Handlers live in src/commands.js. This file only wires things up.

import http from "node:http"
import { Bot, webhookCallback } from "grammy"
import { registerCommands } from "./src/commands.js"

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is missing. Open Telegram, talk to @BotFather, send /newbot, and set the token it gives you as an environment variable.")
  process.exit(1)
}

const mode = (process.env.TELEGRAM_MODE || "polling").trim().toLowerCase()
const bot = new Bot(token)

registerCommands(bot)

bot.catch((err) => {
  console.error("[bot] error while handling an update:", err.error ?? err)
})

function explain(err) {
  const code = err?.error_code ?? err?.response?.error_code
  if (code === 401) {
    console.error("Telegram rejected the token (401 Unauthorized). Copy it again from @BotFather; a revoked token stops working at once.")
  } else if (code === 404) {
    console.error("Telegram answered 404: the token is not a bot token. It looks like 123456789:AAF... and comes from @BotFather.")
  } else {
    console.error("[bot] could not reach Telegram:", err?.message ?? err)
  }
}

async function main() {
  let me
  try {
    me = await bot.api.getMe()
  } catch (err) {
    explain(err)
    process.exit(1)
  }
  console.log(`[bot] logged in as @${me.username} (${mode} mode)`)

  if (mode === "webhook") {
    const url = (process.env.WEBHOOK_URL || "").trim().replace(/\/$/, "")
    if (!url.startsWith("https://")) {
      console.error("WEBHOOK_URL is missing or not https. Set it to the app's public address, for example https://my-bot.fadehost.app")
      process.exit(1)
    }
    const secret = (process.env.WEBHOOK_SECRET || "").trim() || undefined
    const port = Number(process.env.PORT || 3000)
    const handle = webhookCallback(bot, "http", { secretToken: secret })

    http
      .createServer((req, res) => {
        if (req.method === "POST" && req.url === "/telegram") return handle(req, res)
        if (req.method === "GET" && req.url === "/") {
          res.writeHead(200, { "content-type": "text/plain" })
          return res.end(`@${me.username} is running`)
        }
        res.writeHead(404)
        res.end()
      })
      .listen(port, () => console.log(`[bot] webhook server listening on port ${port}`))

    await bot.api.setWebhook(`${url}/telegram`, { secret_token: secret })
    console.log(`[bot] webhook set to ${url}/telegram`)
    return
  }

  // Polling: make sure no webhook is left over from an earlier webhook run.
  await bot.api.deleteWebhook().catch(() => {})

  // Telegram gives a bot's updates to one poller at a time. When the same
  // token is already running somewhere else (your own computer, another
  // host, a second copy of this app), Telegram answers 409 and this copy
  // loses. It does not crash over that: it waits, asks again less and less
  // often, and takes over by itself once the other copy has stopped.
  let wait = 20
  let waitingForOther = false
  for (;;) {
    const began = Date.now()
    let settled
    try {
      await bot.start({
        onStart: () => {
          if (!waitingForOther) {
            console.log("[bot] polling for updates")
            return
          }
          // The library reports a start before the first poll is answered,
          // so only a poll that survives a while means the other copy is gone.
          settled = setTimeout(() => {
            waitingForOther = false
            wait = 20
            console.log("[bot] the other copy has stopped, this one is receiving updates now")
          }, 45_000)
        },
      })
      return
    } catch (err) {
      clearTimeout(settled)
      const code = err?.error_code ?? err?.response?.error_code
      if (code === 401 || code === 404) {
        explain(err)
        process.exit(1)
      }
      // It had been running fine for a while: this is a new episode.
      if (Date.now() - began > 120_000) {
        wait = 20
        waitingForOther = false
      }
      if (code === 409) {
        if (!waitingForOther) {
          console.error("[bot] another copy of this bot is running with the same token, and Telegram allows one at a time. Stop the other copy and this one takes over by itself. Nothing else needs to change here.")
          waitingForOther = true
        }
      } else {
        console.error("[bot] polling stopped:", err?.message ?? err)
      }
      console.error(`[bot] trying again in ${wait} seconds`)
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
      wait = Math.min(wait * 2, 300)
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`[bot] ${signal}, stopping`)
    bot.stop().finally(() => process.exit(0))
  })
}

main()
