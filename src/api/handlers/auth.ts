import { SESSION_TTL_SEC, createAuthToken, getAuthorizedSession } from '../auth.js'
import { getCardAuthProfile, verifyAndConsumeCard } from '../card-store.js'
import { checkRateLimit, randomDelay } from '../../utils/rate-limit.js'

export async function handleAuthCardLogin(body: any, req: Request): Promise<Response> {
  const ip = req.headers.get('x-forwarded-for') || 'unknown'
  // Check limit without incrementing first
  const limit = checkRateLimit(`card_login:${ip}`, 10, 60000, false)

  if (limit.limitReached) {
    return Response.json(
      { ok: false, error: `尝试次数过多，请 ${Math.ceil((limit.resetTime - Date.now()) / 1000)} 秒后再试` },
      { status: 429 }
    )
  }

  const password = String(body?.password || '')
  if (!password) return Response.json({ ok: false, error: '缺少卡密' }, { status: 400 })

  const checked = await verifyAndConsumeCard(password)
  if (!checked.ok) {
    // Only increment on actual auth failure
    checkRateLimit(`card_login:${ip}`, 10, 60000, true)
    await randomDelay(500, 2000)
    return Response.json({ ok: false, error: '卡密无效或已过期' }, { status: 401 })
  }

  const token = createAuthToken(checked.profile)
  return Response.json({
    ok: true,
    data: {
      token,
      expiresInSec: SESSION_TTL_SEC,
      profile: checked.profile,
    },
  })
}

export async function handleAuthProfile(_body: any, req: Request): Promise<Response> {
  const session = getAuthorizedSession(req)
  if (!session) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const latest = getCardAuthProfile(session.profile.cardId, session.profile.userId)
  return Response.json({ ok: true, data: latest || session.profile })
}

export async function handleAuthRedeem(body: any, req: Request): Promise<Response> {
  const session = getAuthorizedSession(req)
  if (!session) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const code = String(body?.code || '')
  if (!code) return Response.json({ ok: false, error: 'empty code' }, { status: 400 })

  const { redeemExpansionCard } = await import('../card-store.js')
  const result = await redeemExpansionCard(code, session.profile.cardId, session.profile.userId)

  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 })

  return Response.json({
    ok: true,
    data: {
      profile: result.profile,
      added: result.added,
      message: `扩容成功！当前最大绑定数已增加至 ${result.profile.maxBindAccounts}`,
    },
  })
}

export async function handleAuthRefill(body: any, req: Request): Promise<Response> {
  const session = getAuthorizedSession(req)
  if (!session) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const code = String(body?.code || '')
  if (!code) return Response.json({ ok: false, error: 'empty code' }, { status: 400 })

  const { redeemTime } = await import('../card-store.js')
  const result = await redeemTime(code, session.profile.cardId, session.profile.userId)

  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 })

  return Response.json({
    ok: true,
    data: {
      profile: result.profile,
      addedDays: result.addedDays,
      message: `续期成功！有效期已延长 ${result.addedDays} 天`,
    },
  })
}
