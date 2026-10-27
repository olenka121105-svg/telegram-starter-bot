
import { InlineKeyboard } from "grammy"

const SERVICE_ID = 49
const DEPARTMENT_ID = 37
const API = "https://eqn.hsc.gov.ua/api/v2/equeue"
const INTERVAL_MS =  2 * 1000

const watchers = new Map()
let timerStarted = false
let scanning = false

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => "")
  throw new Error(
    `API HTTP ${response.status}: ${details.slice(0, 300)}`
  )
  }

  return response.json()
}

async function getAvailability() {
  const params = new URLSearchParams({
    serviceId: String(SERVICE_ID),
    departmentId: String(DEPARTMENT_ID),
  })

  const result = await getJson(`${API}/days?${params}`)
  const dates = result.data ?? []
  const slots = []

  for (const item of dates) {
    const date = typeof item === "string" ? item : item.date
    if (!date) continue

    const query = new URLSearchParams({
      serviceId: String(SERVICE_ID),
      departmentId: String(DEPARTMENT_ID),
      date,
    })

    const response = await getJson(`${API}/slots?${query}`)

    for (const slot of response.data ?? []) {
      slots.push({
        date: date.slice(0, 10),
        start: slot.startTime,
        end: slot.stopTime,
      })
    }
  }

  return slots
}

function formatSlots(slots) {
  return slots
    .map((s) => `${s.date}: ${s.start}–${s.end}`)
    .join("\n")
}

async function scan(bot, chatId, initial = false) {
  const state = watchers.get(chatId)
  if (!state) return

  try {
    const slots = await getAvailability()
    const current = new Set(
      slots.map((s) => `${s.date}|${s.start}|${s.end}`),
    )

    if (initial) {
      state.seen = current

      await bot.api.sendMessage(
        chatId,
        slots.length
          ? `Перевірка працює! Знайдено доступні слоти:\n\n${formatSlots(slots)}`
          : "API доступне, але в цьому центрі зараз немає доступних слотів.",
      )
      return
    }

    const added = slots.filter(
      (s) => !state.seen.has(`${s.date}|${s.start}|${s.end}`),
    )

    state.seen = current

    if (added.length) {
      await bot.api.sendMessage(
        chatId,
        `🔔 З'явилися доступні слоти!\n\n${formatSlots(added)}`,
      )
    }
  } catch (error) {
    console.error("[monitor] check failed:", error.message)

    if (initial) {
      await bot.api.sendMessage(
        chatId,
        `Не вдалося отримати дані МВС: ${error.message}\n\nМожливо, API потребує авторизації або змінився.`,
      )
    }
  }
}

async function scanAll(bot) {
  if (scanning) return
  scanning = true

  try {
    for (const chatId of watchers.keys()) {
      await scan(bot, chatId)
    }
  } finally {
    scanning = false
  }
}

export function registerCommands(bot) {
  bot.command("start", (ctx) =>
    ctx.reply(
      "Бот перевірки вільних записів МВС запущений.",
      {
        reply_markup: new InlineKeyboard()
          .text("Перевірити зараз", "check")
          .row()
          .text("Стежити за слотами", "watch"),
      },
    ),
  )

  bot.command("help", (ctx) =>
    ctx.reply(
      "/check — перевірити вільні слоти\n" +
      "/watch — увімкнути сповіщення кожні 10 хвилин\n" +
      "/stop — зупинити сповіщення\n" +
      "/id — показати ID чату",
    ),
  )

  bot.command("id", (ctx) =>
    ctx.reply(`Chat ID: ${ctx.chat.id}`),
  )

  bot.command("check", async (ctx) => {
    await ctx.reply("Перевіряю доступність записів…")
    await scanOnce(ctx)
  })

  async function scanOnce(ctx) {
    try {
      const slots = await getAvailability()
      await ctx.reply(
        slots.length
          ? `Знайдено доступні слоти:\n\n${formatSlots(slots)}`
          : "Запит успішний, але доступних слотів немає.",
      )
    } catch (error) {
      console.error("[check]", error)
      await ctx.reply(
        `Не вдалося отримати дані: ${error.message}`,
      )
    }
  }

  bot.command("watch", async (ctx) => {
    const id = ctx.chat.id
    watchers.set(id, { seen: new Set() })

    await ctx.reply(
      "Увімкнув моніторинг одного сервісного центру. Перевіряю API…",
    )

    await scan(bot, id, true)

    if (!timerStarted) {
      timerStarted = true
      setInterval(() => {
        scanAll(bot).catch((err) =>
          console.error("[monitor]", err),
        )
      }, INTERVAL_MS)
    }
  })

  bot.command("stop", async (ctx) => {
    watchers.delete(ctx.chat.id)
    await ctx.reply("Сповіщення зупинено.")
  })

  bot.callbackQuery("check", async (ctx) => {
    await ctx.answerCallbackQuery()
    await scanOnce(ctx)
  })

  bot.callbackQuery("watch", async (ctx) => {
    await ctx.answerCallbackQuery()
    watchers.set(ctx.chat.id, { seen: new Set() })
    await scan(bot, ctx.chat.id, true)

    if (!timerStarted) {
      timerStarted = true
      setInterval(() => {
        scanAll(bot).catch(console.error)
      }, INTERVAL_MS)
    }
  })

  bot.on("message:text", (ctx) => {
    if (!ctx.message.text.startsWith("/")) {
      return ctx.reply("Скористайся /help, щоб побачити команди.")
    }
  })
}
