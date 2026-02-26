import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

type CardType = '1天卡' | '3天卡' | '5天卡' | '周卡' | '月卡' | '永久卡'

type CardRecord = {
  id: string
  hash: string
  status: 'active' | 'disabled'
  cardType: CardType
  expiresAt?: number
  maxActivations?: number
  usedCount?: number
  maxBindAccounts?: number
  boundUserId?: string
  boundAccountGids?: number[]
  lastUsedAt?: number
  note?: string
}

type CardDb = {
  version: 2
  cards: CardRecord[]
}

const CARD_DB_FILE = join(process.cwd(), '.farm-cards.json')

function hashCard(card: string): string {
  return createHash('sha256').update(card).digest('hex')
}

function loadDb(): CardDb {
  if (!existsSync(CARD_DB_FILE)) return { version: 2, cards: [] }
  try {
    const parsed = JSON.parse(readFileSync(CARD_DB_FILE, 'utf8')) as Partial<CardDb>
    return { version: 2, cards: Array.isArray(parsed.cards) ? parsed.cards : [] }
  } catch {
    return { version: 2, cards: [] }
  }
}

function saveDb(db: CardDb): void {
  writeFileSync(CARD_DB_FILE, JSON.stringify(db, null, 2), 'utf8')
}

function printUsage(): void {
  console.log('Usage:')
  console.log('  bun run scripts/card-tool.ts hash <card>')
  console.log('  bun run scripts/card-tool.ts add <card> [--type TYPE] [--max-bind N] [--note TEXT]')
  console.log('  bun run scripts/card-tool.ts list')
  console.log('  TYPE: 1天卡 | 3天卡 | 5天卡 | 周卡 | 月卡 | 永久卡')
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  return args[i + 1]
}

function normalizeCardType(raw?: string): CardType {
  const val = String(raw || '月卡').trim() as CardType
  const allowed: CardType[] = ['1天卡', '3天卡', '5天卡', '周卡', '月卡', '永久卡']
  return allowed.includes(val) ? val : '月卡'
}

function expiresAtByType(type: CardType): number | undefined {
  const now = Date.now()
  if (type === '永久卡') return undefined
  const dayMap: Record<Exclude<CardType, '永久卡'>, number> = {
    '1天卡': 1,
    '3天卡': 3,
    '5天卡': 5,
    '周卡': 7,
    '月卡': 30,
  }
  return now + dayMap[type] * 24 * 60 * 60 * 1000
}

async function main() {
  const [, , cmd, ...args] = process.argv

  if (!cmd) {
    printUsage()
    process.exit(1)
  }

  if (cmd === 'hash') {
    const card = args[0]
    if (!card) {
      printUsage()
      process.exit(1)
    }
    console.log(hashCard(card))
    return
  }

  if (cmd === 'list') {
    const db = loadDb()
    console.log(JSON.stringify(db, null, 2))
    return
  }

  if (cmd === 'add') {
    const card = args[0]
    if (!card) {
      printUsage()
      process.exit(1)
    }

    const typeArg = normalizeCardType(argValue(args, '--type'))
    const maxBindArg = Number(argValue(args, '--max-bind') || 2)
    const noteArg = argValue(args, '--note')

    const db = loadDb()
    const hash = hashCard(card)
    const exists = db.cards.some((c) => c.hash === hash)
    if (exists) {
      console.log('Card already exists in DB (same hash).')
      return
    }

    const record: CardRecord = {
      id: randomUUID(),
      hash,
      status: 'active',
      cardType: typeArg,
      expiresAt: expiresAtByType(typeArg),
      maxActivations: 1,
      usedCount: 0,
      maxBindAccounts: Number.isFinite(maxBindArg) ? Math.max(1, Math.floor(maxBindArg)) : 2,
      boundAccountGids: [],
      note: noteArg || '',
    }

    db.cards.push(record)
    saveDb(db)
    console.log('Card added.')
    console.log(`id=${record.id}`)
    console.log(`type=${record.cardType}`)
    console.log(`maxBind=${record.maxBindAccounts}`)
    console.log(`hash=${record.hash}`)
    console.log(`db=${CARD_DB_FILE}`)
    return
  }

  printUsage()
  process.exit(1)
}

main()
