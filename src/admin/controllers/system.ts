import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, resolveUploadRoot, normalizeLineBreaks } from '../utils.js'
import { loadSystemSettings, saveSystemSettings } from '../../api/system-store.js'
import { loadCardDb } from '../../api/card-store.js'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export async function handleSettingsGet(req: IncomingMessage, res: ServerResponse) {
    const settings = loadSystemSettings()
    settings.noticeCardLogin = normalizeLineBreaks(settings.noticeCardLogin)
    settings.noticeAppLogin = normalizeLineBreaks(settings.noticeAppLogin)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: settings }))
}

export async function handleSettingsPost(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req)
    saveSystemSettings({
        ...body,
        noticeCardLogin: normalizeLineBreaks(body.noticeCardLogin),
        noticeAppLogin: normalizeLineBreaks(body.noticeAppLogin),
    })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}

export async function handleUpload(req: IncomingMessage, res: ServerResponse) {
    try {
        const body = await readBody(req)
        if (!body.image) throw new Error('No image data')

        const matches = String(body.image).match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
        if (!matches || matches.length !== 3) throw new Error('Invalid base64 string')

        const buffer = Buffer.from(matches[2], 'base64')
        const ext = matches[1].split('/')[1] || 'png'
        const filename = `bg-${Date.now()}.${ext}`

        const distRoot = resolveUploadRoot()
        const uploadDir = join(distRoot, 'uploads')
        if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

        writeFileSync(join(uploadDir, filename), buffer)
        const imageUrl = `/uploads/${filename}`

        // Handle different upload targets
        const type = body.type || 'background'
        if (type === 'functionImage') {
            const settings = loadSystemSettings()
            const currentBotConfig = settings.botConfig || {
                enabled: false,
                adminUrl: '',
                adminToken: '',
                groupId: '',
                groupIds: '',
                adText: '',
                adIntervalMin: 60,
                reportIntervalSec: 300,
                buyText: '',
                alertEnabled: true,
                alertOnlyWhenAtPossible: false,
                renewalReminderDays: 3
            }
            saveSystemSettings({
                botConfig: {
                    ...currentBotConfig,
                    functionImageUrl: imageUrl
                }
            })
        } else {
            saveSystemSettings({ backgroundImageUrl: imageUrl })
        }

        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, data: { url: imageUrl } }))
    } catch (e: any) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: e?.message || 'upload failed' }))
    }
}

// Phase 2: Backup
export async function handleBackup(req: IncomingMessage, res: ServerResponse) {
    const settings = loadSystemSettings()
    const cards = loadCardDb()

    // Simple JSON dump
    const backup = {
        ts: Date.now(),
        settings,
        cards
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="farm-backup-${Date.now()}.json"`)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="farm-backup-${Date.now()}.json"`)
    res.end(JSON.stringify(backup, null, 2))
}

export async function handleAnnouncementPost(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req)
    const { saveAnnouncement } = await import('../../api/system-store.js')
    await saveAnnouncement({
        content: String(body.content || ''),
        enabled: Boolean(body.enabled),
        level: body.level || 'info',
    })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
}
