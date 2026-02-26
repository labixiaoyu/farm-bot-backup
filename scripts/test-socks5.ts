import { Socks5Client } from '../src/utils/socks5.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

async function main() {
    const proxyArg = process.argv[2]
    let proxyUrl = proxyArg

    if (!proxyUrl || !proxyUrl.startsWith('socks5://')) {
        const proxiesPath = join(process.cwd(), 'config', 'proxies.txt')
        if (existsSync(proxiesPath)) {
            const content = readFileSync(proxiesPath, 'utf8')
            const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'))
            if (lines.length > 0) {
                if (!proxyArg) {
                    proxyUrl = lines[0].trim()
                } else {
                    proxyUrl = proxyArg
                }
            }
        }
        if (proxyArg && proxyArg.includes(':')) {
            proxyUrl = proxyArg
        }
    }

    if (proxyUrl && !proxyUrl.includes('://')) {
        proxyUrl = `socks5://${proxyUrl}`
    }

    if (!proxyUrl) {
        console.error('Usage: bun run scripts/test-socks5.ts [proxy_url]')
        process.exit(1)
    }

    const targetHost = 'myip.ipip.net'
    const targetPort = 80

    console.log(`Testing proxy: ${proxyUrl}`)
    console.log(`Target: ${targetHost}:${targetPort} (HTTP)`)

    try {
        const start = Date.now()
        console.log('1. TCP/SOCKS5 Handshake...')
        const socket = await Socks5Client.connect(proxyUrl, { host: targetHost, port: targetPort }, { timeout: 10000 })
        console.log('   Stats: Handshake Success')

        console.log('2. HTTP Request...')
        socket.write(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\nUser-Agent: curl/7.88.1\r\n\r\n`)

        let data = ''
        socket.on('data', chunk => data += chunk.toString())
        await new Promise<void>(resolve => socket.on('end', resolve))

        console.log('   Status: Response received')
        console.log('--- Response Head ---')
        console.log(data.substring(0, 500))
        console.log('----------------')
        console.log(`Total time: ${Date.now() - start}ms`)

    } catch (e: any) {
        console.error(`\nFAILED: ${e.message}`)
        if (e.type) console.error(`Error Type: ${e.type}`)
    }
}

main()
