import { getSession } from '../../core/account.js'
import { getSessionStore } from '../../store/index.js'
import { toNum } from '../../utils/long.js'

function normalizeTasks(tasks: any[]) {
  return (tasks || []).map((t: any) => ({
    id: toNum(t?.id),
    desc: t?.desc || '',
    isUnlocked: !!t?.isUnlocked,
    isClaimed: !!t?.isClaimed,
    progress: toNum(t?.progress),
    totalProgress: toNum(t?.totalProgress),
  }))
}

export async function handleTaskList(body: any): Promise<Response> {
  const { accountId, refresh } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })

  const store = getSessionStore(accountId)
  const cachedTasks = normalizeTasks(store.state.taskList)
  const needRealtime = !!refresh || cachedTasks.length === 0

  try {
    if (needRealtime) await session.task.checkAndClaimTasks()
    return Response.json({
      ok: true,
      data: {
        tasks: normalizeTasks(store.state.taskList),
        stale: !needRealtime,
      },
    })
  } catch (e: any) {
    if (cachedTasks.length > 0) {
      return Response.json({
        ok: true,
        data: {
          tasks: cachedTasks,
          stale: true,
          warning: e?.message || 'task realtime fetch failed',
        },
      })
    }
    return Response.json({ ok: false, error: e?.message || 'task fetch failed' }, { status: 500 })
  }
}
