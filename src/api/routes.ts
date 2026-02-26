﻿﻿﻿import { isAuthorized } from './auth.js'
import {
  handleAccountAdd,
  handleAccountConfigGet,
  handleAccountConfigUpdate,
  handleAccountList,
  handleAccountPause,
  handleAccountPollQR,
  handleAccountQRLogin,
  handleAccountRelogin,
  handleAccountRemove,
} from './handlers/account.js'
import { handleAuthCardLogin, handleAuthProfile, handleAuthRedeem, handleAuthRefill } from './handlers/auth.js'
import { handleFarmHarvest, handleFarmReplant, handleFarmStatus } from './handlers/farm.js'
import { handleFriendList, handleFriendPatrol } from './handlers/friend.js'
import {
  handleSystemConfig,
  handleSystemLogs,
  handleSystemProxy,
  handleSystemProxyProbe,
  handleSystemProxyRemove,
  handleSystemProxyHealth,
  handleSystemSeeds,
  handleSystemVersion,
  handleSystemSettings,
  handleSystemAnnouncement,
} from './handlers/system.js'
import { handleTaskList } from './handlers/task.js'
import { handleWarehouseBag } from './handlers/warehouse.js'
import { handleOpenAPISpec, handleSwagger } from './swagger.js'

type RouteHandler = (body: any, req: Request) => Promise<Response>

const routes: Record<string, RouteHandler> = {
  'POST /auth/card-login': handleAuthCardLogin,
  'POST /auth/profile': handleAuthProfile,
  'POST /auth/redeem': handleAuthRedeem,
  'POST /auth/refill': handleAuthRefill,
  'POST /account/list': handleAccountList,
  'POST /account/add': handleAccountAdd,
  'POST /account/pause': handleAccountPause,
  'POST /account/relogin': handleAccountRelogin,
  'POST /account/config/get': handleAccountConfigGet,
  'POST /account/config/update': handleAccountConfigUpdate,
  'POST /account/remove': handleAccountRemove,
  'POST /account/qr-login': handleAccountQRLogin,
  'POST /account/poll-qr': handleAccountPollQR,
  'POST /farm/status': handleFarmStatus,
  'POST /farm/harvest': handleFarmHarvest,
  'POST /farm/replant': handleFarmReplant,
  'POST /friend/list': handleFriendList,
  'POST /friend/patrol': handleFriendPatrol,
  'POST /warehouse/bag': handleWarehouseBag,
  'POST /task/list': handleTaskList,
  'POST /system/logs': handleSystemLogs,
  'POST /system/config': handleSystemConfig,
  'POST /system/proxy': handleSystemProxy,
  'POST /system/proxy/probe': handleSystemProxyProbe,
  'POST /system/proxy/remove': handleSystemProxyRemove, // Added
  'POST /system/proxy/health': handleSystemProxyHealth, // Added
  'POST /system/seeds': handleSystemSeeds,
  'POST /system/version': handleSystemVersion,
  'GET /system/settings': handleSystemSettings,
  'GET /system/announcement': handleSystemAnnouncement,
  'GET /swagger': handleSwagger,
  'GET /openapi.json': handleOpenAPISpec,
}

const publicRoutes = new Set<string>(['POST /auth/card-login', 'GET /swagger', 'GET /openapi.json', 'GET /system/settings'])

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const method = req.method.toUpperCase()
  const path = url.pathname

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const key = `${method} ${path}`
  const handler = routes[key]

  if (!handler) {
    return Response.json({ ok: false, error: `未知路由: ${method} ${path}` }, { status: 404, headers: corsHeaders })
  }

  if (!publicRoutes.has(key) && !isAuthorized(req)) {
    return Response.json({ ok: false, error: '未授权，请先通过卡密登录' }, { status: 401, headers: corsHeaders })
  }

  try {
    let body: any = {}
    if (method === 'POST' && req.headers.get('content-type')?.includes('json')) {
      body = await req.json().catch(() => ({}))
    }

    const response = await handler(body, req)
    for (const [k, v] of Object.entries(corsHeaders)) {
      response.headers.set(k, v)
    }
    return response
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500, headers: corsHeaders })
  }
}

export function getRouteDefinitions() {
  return Object.keys(routes).map((key) => {
    const [method, path] = key.split(' ')
    return { method, path }
  })
}
