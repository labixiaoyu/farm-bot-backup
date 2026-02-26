import { existsSync, readFileSync, writeFileSync, promises as fs } from 'node:fs'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'

export type CardType = '测试卡' | '1天卡' | '3天卡' | '5天卡' | '周卡' | '月卡' | '永久卡' | 'expansion'

export type CardRecord = {
  id: string
  hash: string
  status: 'active' | 'disabled' | 'used'
  cardType?: CardType
  expiresAt?: number
  maxActivations?: number
  usedCount?: number
  maxBindAccounts?: number
  boundUserId?: string
  boundAccountGids?: number[]
  lastUsedAt?: number
  code?: string
  note?: string
  creatorId?: string
}

export async function redeemExpansionCard(code: string, targetCardId: string, boundUserId: string): Promise<{ ok: true; profile: CardAuthProfile; added: number } | { ok: false; error: string }> {
  const value = code.trim()
  if (!value) return { ok: false, error: 'empty card code' }

  const db = loadCardDb()
  const now = Date.now()

  // 1. Find and validate the expansion card
  const inputHash = hashCard(value)
  const expansionCard = db.cards.find((c) => hashEquals(c.hash, inputHash))

  if (!expansionCard) return { ok: false, error: 'invalid expansion card' }
  if (expansionCard.status !== 'active') return { ok: false, error: 'card not active' }
  if (expansionCard.cardType !== 'expansion') return { ok: false, error: 'not an expansion card' }
  if (expansionCard.boundUserId) return { ok: false, error: 'card already used' }

  // 2. Find the target user card
  const targetCard = db.cards.find((c) => c.id === targetCardId && c.boundUserId === boundUserId)
  if (!targetCard) return { ok: false, error: 'target card not found' }
  if (targetCard.status !== 'active') return { ok: false, error: 'target card disabled' }

  // 3. Apply expansion
  const addAmount = expansionCard.maxBindAccounts && expansionCard.maxBindAccounts > 0 ? expansionCard.maxBindAccounts : 1
  const currentMax = targetCard.maxBindAccounts || 1
  targetCard.maxBindAccounts = currentMax + addAmount

  // 4. Mark expansion card as used
  expansionCard.status = 'used'
  expansionCard.boundUserId = boundUserId // Link to the user who redeemed it
  expansionCard.usedCount = 1
  expansionCard.lastUsedAt = now

  await saveCardDbAsync(db)

  return { ok: true, profile: profileFromCard(targetCard), added: addAmount }
}

export async function redeemTime(code: string, targetCardId: string, boundUserId: string): Promise<{ ok: true; profile: CardAuthProfile; addedDays: number } | { ok: false; error: string }> {
  const value = code.trim()
  if (!value) return { ok: false, error: 'empty card code' }

  const db = loadCardDb()
  const now = Date.now()

  // 1. Find and validate the refill card
  const inputHash = hashCard(value)
  const refillCard = db.cards.find((c) => hashEquals(c.hash, inputHash))

  if (!refillCard) return { ok: false, error: 'invalid card' }
  if (refillCard.status !== 'active') return { ok: false, error: 'card not active' }
  if (refillCard.boundUserId) return { ok: false, error: 'card already used' }

  // 2. Find the target user card
  const targetCard = db.cards.find((c) => c.id === targetCardId && c.boundUserId === boundUserId)
  if (!targetCard) return { ok: false, error: 'target card not found' }
  if (targetCard.status !== 'active') return { ok: false, error: 'target card disabled' }

  // 3. Calculate added time
  let daysToAdd = 30
  const type = inferCardType(refillCard)
  if (type === '1天卡') daysToAdd = 1
  if (type === '3天卡') daysToAdd = 3
  if (type === '5天卡') daysToAdd = 5
  if (type === '周卡') daysToAdd = 7
  if (type === '测试卡') daysToAdd = 0.25

  const addedMs = daysToAdd * 24 * 3600 * 1000
  // If expired, start from now. If active, add to existing expiration.
  const currentExpiry = targetCard.expiresAt || now
  const newExpiry = Math.max(currentExpiry, now) + addedMs

  targetCard.expiresAt = newExpiry

  // 4. Mark refill card as used
  refillCard.status = 'used'
  refillCard.boundUserId = boundUserId
  refillCard.usedCount = 1
  refillCard.lastUsedAt = now

  await saveCardDbAsync(db)

  return { ok: true, profile: profileFromCard(targetCard), addedDays: daysToAdd }
}

type CardDb = {
  version: 2
  cards: CardRecord[]
}

export type CardAuthProfile = {
  cardId: string
  userId: string
  cardType: CardType
  expiresAt?: number
  maxBindAccounts: number
  boundAccountCount: number
  boundAccountGids: number[]
}

const CARD_DB_FILE = join(process.cwd(), '.farm-cards.json')

let cachedDb: CardDb | null = null
let lastMtime = 0

function createEmptyDb(): CardDb {
  return { version: 2, cards: [] }
}


function hashCard(card: string): string {
  return createHash('sha256').update(card).digest('hex')
}

function hashEquals(leftHex: string, rightHex: string): boolean {
  try {
    const left = Buffer.from(leftHex, 'hex')
    const right = Buffer.from(rightHex, 'hex')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

function inferCardType(card: CardRecord): CardType {
  if (card.cardType) return card.cardType
  if (!card.expiresAt) return '永久卡'

  const diff = card.expiresAt - Date.now()
  if (diff <= 0) return '1天卡' // Expired, default to smallest

  const leftDays = diff / (24 * 3600 * 1000)

  if (leftDays <= 0.26) return '测试卡' // ~6 hours (0.25 days)
  if (leftDays <= 1.1) return '1天卡'
  if (leftDays <= 3.1) return '3天卡'
  if (leftDays <= 5.1) return '5天卡'
  if (leftDays <= 7.1) return '周卡'
  if (leftDays <= 32) return '月卡'
  return '月卡'
}

export function loadCardDb(): CardDb {
  if (!existsSync(CARD_DB_FILE)) return createEmptyDb()
  try {
    const stat = require('node:fs').statSync(CARD_DB_FILE)
    if (cachedDb && stat.mtimeMs === lastMtime) {
      return cachedDb
    }

    const raw = JSON.parse(readFileSync(CARD_DB_FILE, 'utf8')) as any
    const cards = Array.isArray(raw?.cards) ? raw.cards : []
    const db = {
      version: 2,
      cards: cards.map((c: any) => {
        let code = String(c?.code || '')
        let note = String(c?.note || '')
        // Migration: If no code but note looks like a card code
        if (!code && note.startsWith('FARM-')) {
          code = note
          note = ''
        }
        return {
          id: String(c?.id || randomUUID()),
          hash: String(c?.hash || ''),
          code,
          status: c?.status === 'disabled' ? 'disabled' : 'active',
          cardType: c?.cardType,
          expiresAt: typeof c?.expiresAt === 'number' ? c.expiresAt : undefined,
          maxActivations: typeof c?.maxActivations === 'number' ? c.maxActivations : 1,
          usedCount: typeof c?.usedCount === 'number' ? c.usedCount : 0,
          maxBindAccounts: typeof c?.maxBindAccounts === 'number' ? c.maxBindAccounts : 1,
          boundUserId: typeof c?.boundUserId === 'string' ? c.boundUserId : undefined,
          boundAccountGids: Array.isArray(c?.boundAccountGids) ? c.boundAccountGids.map((x: any) => Number(x) || 0).filter((x: number) => x > 0) : [],
          lastUsedAt: typeof c?.lastUsedAt === 'number' ? c.lastUsedAt : undefined,
          note,
          creatorId: typeof c?.creatorId === 'string' ? c.creatorId : undefined,
        }
      }),
    }

    cachedDb = db
    lastMtime = stat.mtimeMs
    return db
  } catch {
    return createEmptyDb()
  }
}

/** @deprecated Use saveCardDbAsync instead */
export function saveCardDb(db: CardDb): void {
  writeFileSync(CARD_DB_FILE, JSON.stringify(db, null, 2), 'utf8')
  // Update cache immediately to prevent reload on next read (race condition slightly possible but acceptable for single process)
  try {
    const stat = require('node:fs').statSync(CARD_DB_FILE)
    cachedDb = db
    lastMtime = stat.mtimeMs
  } catch { }
}

export async function saveCardDbAsync(db: CardDb): Promise<void> {
  await fs.writeFile(CARD_DB_FILE, JSON.stringify(db, null, 2), 'utf8')
  // Update cache immediately
  try {
    const stat = await fs.stat(CARD_DB_FILE)
    cachedDb = db
    lastMtime = stat.mtimeMs
  } catch { }
}

function profileFromCard(card: CardRecord): CardAuthProfile {
  return {
    cardId: card.id,
    userId: card.boundUserId || '',
    cardType: inferCardType(card),
    expiresAt: card.expiresAt,
    maxBindAccounts: card.maxBindAccounts && card.maxBindAccounts > 0 ? card.maxBindAccounts : 1,
    boundAccountCount: (card.boundAccountGids || []).length,
    boundAccountGids: card.boundAccountGids || [],
  }
}

export async function verifyAndConsumeCard(card: string): Promise<{ ok: true; profile: CardAuthProfile } | { ok: false; error: string }> {
  const value = card.trim()
  if (!value) return { ok: false, error: 'empty card' }

  const db = loadCardDb()
  if (db.cards.length === 0) return { ok: false, error: 'card db empty' }

  const inputHash = hashCard(value)
  const now = Date.now()

  const matched = db.cards.find((c) => hashEquals(c.hash, inputHash))
  if (!matched) return { ok: false, error: 'card invalid' }
  if (matched.status !== 'active') return { ok: false, error: 'card disabled' }
  if (typeof matched.expiresAt === 'number' && matched.expiresAt > 0 && now > matched.expiresAt) {
    return { ok: false, error: 'card expired' }
  }

  const used = matched.usedCount || 0
  const max = matched.maxActivations || 0
  if (!matched.boundUserId && max > 0 && used >= max) return { ok: false, error: 'card exhausted' }

  if (!matched.boundUserId) {
    matched.boundUserId = `U${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
    matched.usedCount = used + 1
  }

  if (!Array.isArray(matched.boundAccountGids)) matched.boundAccountGids = []
  if (!matched.maxBindAccounts || matched.maxBindAccounts <= 0) matched.maxBindAccounts = 1
  matched.lastUsedAt = now

  await saveCardDbAsync(db)

  return { ok: true, profile: profileFromCard(matched) }
}

export function getCardAuthProfile(cardId: string, userId: string): CardAuthProfile | null {
  const db = loadCardDb()
  const matched = db.cards.find((c) => c.id === cardId && c.boundUserId === userId)
  if (!matched) return null
  return profileFromCard(matched)
}

export async function bindAccountToCardUser(cardId: string, userId: string, gid: number): Promise<{ ok: true; profile: CardAuthProfile } | { ok: false; error: string }> {
  const accountGid = Number(gid) || 0
  if (accountGid <= 0) return { ok: false, error: 'invalid gid' }

  const db = loadCardDb()
  const matched = db.cards.find((c) => c.id === cardId && c.boundUserId === userId)
  if (!matched) return { ok: false, error: 'card/user not found' }

  const list = Array.isArray(matched.boundAccountGids) ? matched.boundAccountGids : []
  const maxBind = matched.maxBindAccounts && matched.maxBindAccounts > 0 ? matched.maxBindAccounts : 1

  if (!list.includes(accountGid) && list.length >= maxBind) {
    return { ok: false, error: `绑定账号数已达上限(${maxBind})` }
  }

  if (!list.includes(accountGid)) list.push(accountGid)
  matched.boundAccountGids = list
  matched.lastUsedAt = Date.now()

  await saveCardDbAsync(db)
  return { ok: true, profile: profileFromCard(matched) }
}

export async function updateCard(id: string, partial: Partial<CardRecord>): Promise<boolean> {
  const db = loadCardDb()
  const idx = db.cards.findIndex(c => c.id === id)
  if (idx === -1) return false

  db.cards[idx] = { ...db.cards[idx], ...partial }
  await saveCardDbAsync(db)
  return true
}

export async function generateCards(
  count: number,
  type: CardType,
  note: string = '',
  creatorId: string = 'author'
): Promise<CardRecord[]> {
  const db = loadCardDb()
  const newCards: CardRecord[] = []

  for (let i = 0; i < count; i++) {
    const code = 'FARM-' + randomUUID().replace(/-/g, '').toUpperCase().slice(0, 16)
    const card: CardRecord = {
      id: randomUUID(),
      hash: hashCard(code),
      code,
      status: 'active',
      cardType: type,
      note,
      creatorId,
      maxBindAccounts: 1,
    }

    if (type === 'expansion') {
      card.maxBindAccounts = 1
    }

    newCards.push(card)
    db.cards.push(card)
  }

  await saveCardDbAsync(db)
  return newCards
}
