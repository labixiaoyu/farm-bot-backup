import { getSession } from '../../core/account.js'
import { getSessionStore } from '../../store/index.js'
import { toNum } from '../../utils/long.js'

function normalizeFriends(list: any[]) {
  return (list || []).map((f: any) => ({
    gid: toNum(f?.gid),
    name: f?.name || '',
    level: toNum(f?.level),
    actions: (f?.actions || []).map((x: any) => String(x)),
  }))
}

export async function handleFriendList(body: any): Promise<Response> {
  const { accountId, refresh } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })

  const store = getSessionStore(accountId)
  const cachedFriends = normalizeFriends(store.state.friendList)
  const needRealtime = !!refresh || cachedFriends.length === 0

  try {
    if (needRealtime) await session.friend.checkFriends()
    return Response.json({
      ok: true,
      data: {
        friends: normalizeFriends(store.state.friendList),
        progress: store.state.friendPatrolProgress,
        stats: store.state.friendStats,
        stale: !needRealtime,
      },
    })
  } catch (e: any) {
    if (cachedFriends.length > 0) {
      return Response.json({
        ok: true,
        data: {
          friends: cachedFriends,
          progress: store.state.friendPatrolProgress,
          stats: store.state.friendStats,
          stale: true,
          warning: e?.message || 'friend realtime fetch failed',
        },
      })
    }
    return Response.json({ ok: false, error: e?.message || 'friend fetch failed' }, { status: 500 })
  }
}

export async function handleFriendPatrol(body: any): Promise<Response> {
  const { accountId } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })

  try {
    session.friend.start()
    return Response.json({ ok: true })
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'friend patrol start failed' }, { status: 500 })
  }
}
