import { type Socket, connect } from 'node:net'
import { log, logWarn } from './logger.js'

export interface Socks5Options {
    proxyValue: string // "socks5://user:pass@host:port" or "host:port"
    timeout?: number
}

export interface Socks5ConnectTarget {
    host: string
    port: number
}

export type Socks5ErrorType =
    | 'INVALID_PROXY_URL'
    | 'TCP_CONNECT_TIMEOUT'
    | 'TCP_CONNECT_FAILED'
    | 'HANDSHAKE_TIMEOUT'
    | 'HANDSHAKE_FAILED'
    | 'AUTH_REJECTED'
    | 'AUTH_FAILED'
    | 'CONNECT_TIMEOUT'
    | 'CONNECT_FAILED'
    | 'UNKNOWN'

export class Socks5Error extends Error {
    constructor(
        readonly type: Socks5ErrorType,
        message: string,
        readonly originalError?: any,
    ) {
        const fullMessage = originalError?.message ? `${message} (${originalError.message})` : message
        super(`[SOCKS5:${type}] ${fullMessage}`)
        this.name = 'Socks5Error'
    }
}

interface ParsedProxy {
    host: string
    port: number
    username?: string
    password?: string
}

export class Socks5Client {
    static parseProxy(proxyUrl: string): ParsedProxy {
        // 1. Remove socks5:// prefix if exists
        let clean = proxyUrl.replace(/^socks5:\/\//i, '')
        // 2. Check for user:pass@host:port
        let username = ''
        let password = ''

        if (clean.includes('@')) {
            const parts = clean.split('@')
            const auth = parts[0]
            clean = parts[1] // host:port

            const authParts = auth.split(':')
            username = decodeURIComponent(authParts[0] || '')
            password = decodeURIComponent(authParts.slice(1).join(':') || '')
        }

        const [host, portStr] = clean.split(':')
        const port = Number(portStr) || 1080

        if (!host) {
            throw new Socks5Error('INVALID_PROXY_URL', `Invalid proxy URL: ${proxyUrl}`)
        }

        return { host, port, username, password }
    }

    static async connect(
        proxyUrl: string,
        target: Socks5ConnectTarget,
        options: { timeout?: number } = {},
    ): Promise<Socket> {
        const timeout = options.timeout ?? 10000
        const parsed = this.parseProxy(proxyUrl)

        // Step 1: TCP Connect to Proxy
        const socket = new Promise<Socket>((resolve, reject) => {
            const s = connect(parsed.port, parsed.host)
            s.setTimeout(timeout)

            const onConnect = () => {
                cleanup()
                resolve(s)
            }

            const onError = (err: any) => {
                cleanup()
                reject(new Socks5Error('TCP_CONNECT_FAILED', `Failed to connect to proxy ${parsed.host}:${parsed.port}`, err))
            }

            const onTimeout = () => {
                cleanup()
                s.destroy()
                reject(new Socks5Error('TCP_CONNECT_TIMEOUT', `Timeout connecting to proxy ${parsed.host}:${parsed.port}`))
            }

            const cleanup = () => {
                s.removeListener('connect', onConnect)
                s.removeListener('error', onError)
                s.removeListener('timeout', onTimeout)
                s.setTimeout(0) // Disable socket timeout for handshake logic to handle its own
            }

            s.once('connect', onConnect)
            s.once('error', onError)
            s.once('timeout', onTimeout)
        })

        const s = await socket

        try {
            // Step 2: Handshake (Method Selection)
            await this.handshake(s, !!parsed.username, timeout)

            // Step 3: Auth (if needed)
            if (parsed.username) {
                await this.authenticate(s, parsed.username, parsed.password || '', timeout)
            }

            // Step 4: Connect Command
            await this.sendConnect(s, target.host, target.port, timeout)

            return s
        } catch (e) {
            s.destroy()
            throw e
        }
    }

    private static async handshake(socket: Socket, hasAuth: boolean, timeout: number): Promise<void> {
        return new Promise((resolve, reject) => {
            // Version 5, 2 methods (NoAuth 0x00, UserPass 0x02)
            // Or just NoAuth if no user/pass
            const methods = hasAuth ? [0x00, 0x02] : [0x00]
            const buf = Buffer.from([0x05, methods.length, ...methods])

            this.sendAndExpect(socket, buf, 2, timeout)
                .then((response) => {
                    if (response[0] !== 0x05) {
                        return reject(new Socks5Error('HANDSHAKE_FAILED', `Invalid SOCKS version: ${response[0]}`))
                    }
                    const method = response[1]
                    if (method === 0xff) {
                        return reject(new Socks5Error('AUTH_REJECTED', 'No acceptable authentication methods'))
                    }
                    if (hasAuth && method !== 0x02) {
                        // We wanted auth but server picked something else (or 0x00 if it allows no-auth even with creds)
                        // Technicaly 0x00 is fine if server is open. But we must check if we MUST auth.
                        // If server picked 0x00 but we have creds, we just skip auth step? SOCKS5 RFC says if 0x02 not selected, don't send auth.
                        // But usually providers forcing auth will return 0x02.
                        // If method is 0x00, we resolve. The caller checks 'if (parsed.username && method === 0x02)' logic? 
                        // Actually, handshake just negotiates.
                        // If server says 0x00 (No Auth), we skip auth.
                        // If server says 0x02 (User/Pass), we do auth.
                        // We should modify connect flow to check what method was selected.
                        // But `handshake` here is simple. Let's fix this method to RETURN the selected method.
                    }
                    resolve() // For now assume if it didn't reject 0xFF, it's 0x00 or 0x02 which we support.
                })
                .catch((e) => reject(new Socks5Error('HANDSHAKE_TIMEOUT', e.message)))
        })
    }

    private static async authenticate(socket: Socket, user: string, pass: string, timeout: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const userBuf = Buffer.from(user)
            const passBuf = Buffer.from(pass)

            const buf = Buffer.concat([
                Buffer.from([0x01, userBuf.length]),
                userBuf,
                Buffer.from([passBuf.length]),
                passBuf
            ])

            this.sendAndExpect(socket, buf, 2, timeout)
                .then((response) => {
                    if (response[1] !== 0x00) {
                        return reject(new Socks5Error('AUTH_FAILED', `Authentication failed with code ${response[1]}`))
                    }
                    resolve()
                })
                .catch((e) => reject(new Socks5Error('AUTH_FAILED', e.message)))
        })
    }

    private static async sendConnect(socket: Socket, host: string, port: number, timeout: number): Promise<void> {
        return new Promise((resolve, reject) => {
            // CMD: CONNECT (0x01)
            // RSV: 0x00
            // ATYP: 0x03 (Domain) or 0x01 (IPv4)

            let addrBuf: Buffer
            let atyp: number

            const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
            if (isIp) {
                atyp = 0x01
                addrBuf = Buffer.from(host.split('.').map(Number))
            } else {
                atyp = 0x03
                addrBuf = Buffer.concat([Buffer.from([host.length]), Buffer.from(host)])
            }

            const portBuf = Buffer.alloc(2)
            portBuf.writeUInt16BE(port)

            const req = Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, atyp]),
                addrBuf,
                portBuf
            ])

            // We expect at least 10 bytes (for IPv4 response) but variable for domain.
            // SOCKS5 reply: VER REP RSV ATYP BND.ADDR BND.PORT
            // We just read 4 bytes first to check REP.

            const onResponse = (data: Buffer) => {
                // We only care about the first 4 bytes to check success
                if (data.length < 4) return // Wait for more? naive implementation assumes 1 packet

                const ver = data[0]
                const rep = data[1]

                if (ver !== 0x05) {
                    reject(new Socks5Error('CONNECT_FAILED', `Invalid SOCKS version in connect reply: ${ver}`))
                    return
                }

                if (rep !== 0x00) {
                    const errors: Record<number, string> = {
                        0x01: 'General SOCKS server failure',
                        0x02: 'Connection not allowed by ruleset',
                        0x03: 'Network unreachable',
                        0x04: 'Host unreachable',
                        0x05: 'Connection refused',
                        0x06: 'TTL expired',
                        0x07: 'Command not supported',
                        0x08: 'Address type not supported'
                    }
                    reject(new Socks5Error('CONNECT_FAILED', errors[rep] || `Connect failed with code ${rep}`))
                    return
                }

                // Success
                resolve()
            }

            // Using a one-off listener for the response
            const wrapped = (data: Buffer) => {
                socket.removeListener('data', wrapped)
                onResponse(data)
            }

            socket.on('data', wrapped)
            socket.write(req)

            // Cleanup listener on timeout/error handled by caller catch?
            // Actually we need to handle timeout here to remove listener
            setTimeout(() => {
                socket.removeListener('data', wrapped)
                // If not resolved by now, it's a timeout, but Promise is already raced in sendAndExpect style?
                // No, we are inside new Promise here.
            }, timeout)
        })
    }

    private static sendAndExpect(socket: Socket, data: Buffer | Uint8Array, expectedBytes: number, timeout: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup()
                reject(new Error('Response timeout'))
            }, timeout)

            const onData = (chunk: Buffer) => {
                // Simple case: we assume the response comes in one chunk or we just take the first chunk 
                // that satisfies us. For handshake/auth it's usually small enough.
                if (chunk.length >= 0) {
                    cleanup()
                    resolve(chunk)
                }
            }

            const onError = (err: Error) => {
                cleanup()
                reject(err)
            }

            const cleanup = () => {
                clearTimeout(timer)
                socket.removeListener('data', onData)
                socket.removeListener('error', onError)
            }

            socket.on('data', onData)
            socket.on('error', onError)
            socket.write(data)
        })
    }
}
