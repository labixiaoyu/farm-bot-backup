import { getItemName } from '../../config/game-data.js'
import { getSession } from '../../core/account.js'
import { getSessionStore } from '../../store/index.js'
import { toNum } from '../../utils/long.js'

function normalizeBagItems(items: any[]): any[] {
  const merged = new Map<number, { id: number; count: number; name: string }>()
  for (const item of items || []) {
    const id = toNum(item.id)
    const count = toNum(item.count)
    const found = merged.get(id)
    if (found) {
      found.count += count
    } else {
      merged.set(id, { id, count, name: getItemName(id) })
    }
  }
  return Array.from(merged.values())
}

export async function handleWarehouseBag(body: any): Promise<Response> {
  const { accountId, refresh } = body ?? {}
  if (!accountId) return Response.json({ ok: false, error: 'missing accountId' }, { status: 400 })

  const session = getSession(accountId)
  if (!session) return Response.json({ ok: false, error: 'account not found' }, { status: 404 })
  const store = getSessionStore(accountId)
  const cachedItems = normalizeBagItems(store.state.bag || [])
  const needRealtime = !!refresh || cachedItems.length === 0

  try {
    if (needRealtime) {
      const bag = await session.warehouse.getBag()
      const items = bag.item_bag?.items?.length ? bag.item_bag.items : bag.items || []
      store.updateBag(items)
    }

    return Response.json({
      ok: true,
      data: {
        items: normalizeBagItems(store.state.bag || []),
        stale: !needRealtime,
      },
    })
  } catch (e: any) {
    if (cachedItems.length > 0) {
      return Response.json({
        ok: true,
        data: {
          items: cachedItems,
          stale: true,
          warning: e?.message || 'bag realtime fetch failed',
        },
      })
    }

    return Response.json({ ok: false, error: e?.message || 'bag fetch failed' }, { status: 500 })
  }
}
