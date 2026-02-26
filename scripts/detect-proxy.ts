import { connect } from 'node:net'

const host = '518109.dns36.cn'
const port = 62222

console.log(`Connecting to ${host}:${port}...`)
const socket = connect(port, host, () => {
    console.log('Connected. Sending SOCKS5 Handshake...')
    // SOCKS5: VER=5, NMETHODS=1, METHODS=[0]
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
})

socket.on('data', (data) => {
    console.log('Received data:', data)
    console.log('Hex:', data.toString('hex'))
    console.log('String:', data.toString())

    if (data[0] === 0x05) {
        console.log('✅ Detected SOCKS5')
    } else if (data.toString().startsWith('HTTP')) {
        console.log('✅ Detected HTTP Proxy')
    } else {
        console.log('❓ Unknown Protocol')
    }
    socket.end()
})

socket.on('error', (err) => {
    console.error('Socket error:', err.message)
})

socket.on('end', () => {
    console.log('Disconnected')
})
