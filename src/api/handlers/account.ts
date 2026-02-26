import { mapLoginError } from '../../utils/error-map.js'
import { getAuthorizedSession } from '../auth.js'
import { bindAccountToCardUser } from '../card-store.js'
import { accountConfigSchema } from '../../config/schema.js'
import { addAccount, getSession, loginWithQR, pauseAccount, reloginAccount, removeAccount } from '../../core/account.js'
import { accountStore } from '../../store/index.js'
async function bindByAuth(req: Request, gid: number): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const auth = getAuthorizedSession(req)
  if (!auth) return { ok: false, error: '未授权' }
  const bindResult = await bindAccountToCardUser(auth.profile.cardId, auth.profile.userId, gid)
  if (!bindResult.ok) return { ok: false, error: bindResult.error }
  return { ok: true, data: bindResult.profile }
}

export async function handleAccountList(body: any, req: Request): Promise<Response> {
  const auth = getAuthorizedSession(req)
  if (!auth) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  // Reload card to get latest bound accounts, or trust auth profile if it's fresh enough.
  // Ideally we trust the auth profile or refresh it. 
  // Given we just updated CardAuthProfile to include boundAccountGids, we can use it.
  // However, for consistency, let's re-read the card to ensure we don't show stale data if binding changed.
  const { getCardAuthProfile } = await import('../card-store.js')
  const latestProfile = getCardAuthProfile(auth.profile.cardId, auth.profile.userId)
  const allowedGids = new Set(latestProfile?.boundAccountGids || [])

  const accounts = accountStore.getAccounts()
    .filter(a => allowedGids.has(Number(a.gid || 0)))
    .map((a) => ({
      id: a.id,
      platform: a.platform,
      qqNumber: a.qqNumber || '',
      gid: Number(a.gid || 0),
      name: a.name,
      level: a.level,
      status: a.status,
      statusReason: a.statusReason || '',
      statusAt: a.statusAt || 0,
      proxy: a.proxy, // Ensure proxy is included as per previous tasks, though not explicitly in issue 3, it's good for consistency
    }))
  return Response.json({ ok: true, data: accounts })
}

export async function handleAccountAdd(body: any, req: Request): Promise<Response> {
  const { platform, code } = body ?? {}
  if (!platform || !code) return Response.json({ ok: false, error: '缺少 platform 或 code' }, { status: 400 })
  if (platform !== 'qq' && platform !== 'wx') return Response.json({ ok: false, error: 'platform 必须是 qq 或 wx' }, { status: 400 })

  try {
    const session = await addAccount(platform, code)
    const gid = Number(session.conn.userState.gid || 0)
    const bind = await bindByAuth(req, gid)
    if (!bind.ok) {
      session.stop() // Use session.stop() instead of removeAccount for full cleanup
      removeAccount(session.id)
      return Response.json({ ok: false, error: bind.error }, { status: 403 })
    }
    return Response.json({ ok: true, data: { id: session.id, profile: bind.data } })
  } catch (e: any) {
    // If we have an intermediate session object that failed somewhere, it should ideally be handled by addAccount/start
    // But since account.ts calls addAccount which calls session.start, the throw from session.start will land here.
    return Response.json({ ok: false, error: mapLoginError(e) }, { status: 500 })
  }
}

export async function handleAccountPause(body: any): Promise<Response> {
  const { id } = body ?? {}
  if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 })
  pauseAccount(id)
  return Response.json({ ok: true })
}

export async function handleAccountRelogin(body: any): Promise<Response> {
  const { id } = body ?? {}
  if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 })
  try {
    const session = await reloginAccount(id)
    return Response.json({ ok: true, data: { id: session.id } })
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
}

export async function handleAccountRemove(body: any): Promise<Response> {
  const { id } = body ?? {}
  if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 })
  removeAccount(id)
  return Response.json({ ok: true })
}

export async function handleAccountQRLogin(): Promise<Response> {
  try {
    const { qrInfo } = await loginWithQR()
    return Response.json({
      ok: true,
      data: {
        url: qrInfo.url,
        loginCode: qrInfo.loginCode,
        qrText: qrInfo.qrText,
      },
    })
  } catch (e: any) {
    return Response.json({ ok: false, error: mapLoginError(e) }, { status: 500 })
  }
}

export async function handleAccountPollQR(body: any, req: Request): Promise<Response> {
  const { loginCode } = body ?? {}
  if (!loginCode) return Response.json({ ok: false, error: '缺少 loginCode' }, { status: 400 })

  try {
    const { pollQRScanResultDetailed } = await import('../../protocol/login.js')
    // Poll for 2 seconds. If timeout, we return 'waiting' status to frontend.
    const loginRet = await pollQRScanResultDetailed(loginCode, { pollIntervalMs: 500, timeoutMs: 2000 })
    const code = loginRet.code
    const uin = loginRet.uin ? String(loginRet.uin) : ''
    const session = await addAccount('qq', code, { uin })
    const gid = Number(session.conn.userState.gid || 0)
    const bind = await bindByAuth(req, gid)
    if (!bind.ok) {
      removeAccount(session.id)
      return Response.json({ ok: false, error: bind.error }, { status: 403 })
    }
    return Response.json({ ok: true, data: { id: session.id, code, profile: bind.data } })
  } catch (e: any) {
    if (e.message && e.message.includes('扫码超时')) {
      return Response.json({ ok: true, data: { status: 'waiting' } })
    }
    return Response.json({ ok: false, error: mapLoginError(e) }, { status: 500 })
  }
}

export async function handleAccountConfigGet(body: any): Promise<Response> {
  const { id } = body ?? {}
  if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 })
  const session = getSession(id)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })
  return Response.json({ ok: true, data: session.accountConfig })
}

export async function handleAccountConfigUpdate(body: any): Promise<Response> {
  const { id, config } = body ?? {}
  if (!id) return Response.json({ ok: false, error: '缺少 id' }, { status: 400 })
  if (!config || typeof config !== 'object') return Response.json({ ok: false, error: '缺少 config' }, { status: 400 })
  const session = getSession(id)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })
  try {
    const merged = accountConfigSchema.parse({ ...session.accountConfig, ...config })
    const next = session.updateAccountConfig(merged)
    return Response.json({ ok: true, data: next })
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'invalid config' }, { status: 400 })
  }
}
