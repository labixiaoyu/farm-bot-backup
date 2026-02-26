import { Socks5Client } from './socks5.js'

export type ProxyProbeResult = {
    ok: boolean
    elapsedMs: number
    ip?: string
    error?: string
    step: string
    raw?: string
}

export async function probeExitIpViaSocks5(proxyUrl: string, maxTimeSec = 10): Promise<ProxyProbeResult> {
    const startedAt = Date.now()
    let step = 'init'

    try {
        step = 'socks5_handshake'
        // 1. Establish SOCKS5 tunnel to myip.ipip.net:80
        const socket = await Socks5Client.connect(proxyUrl, { host: 'myip.ipip.net', port: 80 }, { timeout: maxTimeSec * 1000 })

        return await new Promise((resolve) => {
            const timer = setTimeout(() => {
                socket.destroy()
                resolve({ ok: false, elapsedMs: Date.now() - startedAt, error: 'TIMEOUT', step })
            }, 8000)

            socket.once('error', (err) => {
                clearTimeout(timer)
                resolve({ ok: false, elapsedMs: Date.now() - startedAt, error: `SOCKET_ERROR: ${err.message}`, step })
            })

            step = 'http_request'
            socket.write('GET / HTTP/1.1\r\nHost: myip.ipip.net\r\nConnection: close\r\nUser-Agent: curl/7.88.1\r\n\r\n')

            let data = ''
            socket.on('data', (chunk) => {
                data += chunk.toString()
            })

            socket.on('end', () => {
                clearTimeout(timer)
                const elapsedMs = Date.now() - startedAt
                try {
                    const parts = data.split('\r\n\r\n')
                    const body = parts.length > 1 ? parts[1] : data
                    const text = body.trim()

                    // Regex to extract IP
                    const match = text.match(/IP[：:]\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)
                    if (match && match[1]) {
                        resolve({ ok: true, elapsedMs, ip: match[1], raw: text.substring(0, 50), step })
                    } else {
                        const ipMatch = text.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
                        if (ipMatch) {
                            resolve({ ok: true, elapsedMs, ip: ipMatch[0], raw: text.substring(0, 50), step })
                        } else {
                            resolve({ ok: false, elapsedMs, error: 'PARSE_FAILED', raw: text.substring(0, 100), step })
                        }
                    }
                } catch (e: any) {
                    resolve({ ok: false, elapsedMs, error: `PARSE_ERROR: ${e.message}`, step })
                }
            })
        })
    } catch (err: any) {
        return { ok: false, elapsedMs: Date.now() - startedAt, error: err.message || 'UNKNOWN_ERROR', step }
    }
}
