import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}

export async function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            try {
                const str = Buffer.concat(chunks).toString()
                if (!str) {
                    resolve({})
                    return
                }
                resolve(JSON.parse(str))
            } catch (e) {
                reject(e)
            }
        })
        req.on('error', reject)
    })
}

export function resolveUploadRoot(): string {
    const liveRoot = '/var/www/farm'
    if (existsSync(liveRoot)) return liveRoot
    const webDistRoot = join(process.cwd(), 'web-terminal', 'dist')
    if (existsSync(webDistRoot)) return webDistRoot
    return join(process.cwd(), 'dist')
}

export function normalizeLineBreaks(text: unknown): string {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\\n/g, '\n')
}
