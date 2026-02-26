import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildDashboardData, type AdminAccountView } from './dashboard.js'

type LeaderboardItem = {
    gid: number
    name: string
    value: number
    label: string
}

type LeaderboardResponse = {
    onlineTime: LeaderboardItem[]
    level: LeaderboardItem[]
    goldGain: LeaderboardItem[]
    expGain: LeaderboardItem[]
}

function fmtDuration(sec: number): string {
    if (sec < 60) return `${sec}秒`
    if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return `${h}小时${m}分`
}

import { AuthSession } from '../auth.js'

// ...

export async function handleLeaderboard(req: IncomingMessage, res: ServerResponse, session?: AuthSession) {
    if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
        return
    }

    const dashboard = await buildDashboardData(session)
    // Flatten all accounts
    const allAccounts: AdminAccountView[] = []

    // Dashboard data is already filtered by buildDashboardData based on session role!
    // So we just need to trust dashboard.cards
    for (const card of dashboard.cards) {
        allAccounts.push(...card.accounts)
    }

    // Unbound accounts are also filtered in buildDashboardData (agents get 0 unbound items usually)
    allAccounts.push(...dashboard.unboundAccounts)

    // Helper for formatting
    const toItem = (acc: AdminAccountView, val: number, label: string): LeaderboardItem => ({
        gid: acc.gid,
        name: acc.name,
        value: val,
        label
    })

    // 1. Online Time (accumulated) - Include offline accounts
    const byTime = [...allAccounts]
        .filter(a => (a.runtimeSec || 0) > 0)
        .sort((a, b) => (b.runtimeSec || 0) - (a.runtimeSec || 0))
        .slice(0, 10)

    const onlineTime = byTime.map(a => ({
        gid: a.gid,
        name: a.name,
        value: a.runtimeSec || 0,
        label: fmtDuration(a.runtimeSec || 0)
    }))

    // 2. Level - Include offline accounts
    const byLevel = [...allAccounts]
        .filter(a => (a.level || 0) > 0)
        .sort((a, b) => (b.level || 0) - (a.level || 0))
        .slice(0, 10)

    const level = byLevel.map(a => ({
        gid: a.gid,
        name: a.name,
        value: a.level || 0,
        label: `Lv${a.level}`
    }))

    // 3. Gold Gain
    const byGold = [...allAccounts]
        .map(a => ({ acc: a, gain: a.income?.gold || 0 }))
        .filter(x => x.gain > 0)
        .sort((a, b) => b.gain - a.gain)
        .slice(0, 10)

    const goldGain = byGold.map(x => ({
        gid: x.acc.gid,
        name: x.acc.name,
        value: x.gain,
        label: '金币'
    }))

    // 4. Exp Gain
    const byExp = [...allAccounts]
        .map(a => ({ acc: a, gain: a.income?.exp || 0 }))
        .filter(x => x.gain > 0)
        .sort((a, b) => b.gain - a.gain)
        .slice(0, 10)

    const expGain = byExp.map(x => ({
        gid: x.acc.gid,
        name: x.acc.name,
        value: x.gain,
        label: '经验'
    }))

    const data: LeaderboardResponse = {
        onlineTime,
        level,
        goldGain,
        expGain
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data }))
}
