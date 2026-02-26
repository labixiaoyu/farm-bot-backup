import { connect } from 'node:net';

const proxyHost = '100.114.70.126';
const proxyPort = 1080;
const targetHost = 'myip.ipip.net';
const targetPort = 80;

async function test() {
    console.log(`Connecting to proxy ${proxyHost}:${proxyPort}...`);
    const s = connect(proxyPort, proxyHost);

    s.on('error', (err) => {
        console.error('TCP Connect Error:', err.message);
        process.exit(1);
    });

    await new Promise(resolve => s.on('connect', resolve));
    console.log('TCP Connected. Sending handshake...');

    // Handshake: VER=5, NMETHODS=1, METHOD=0 (No Auth)
    s.write(Buffer.from([0x05, 0x01, 0x00]));

    const res = await new Promise(resolve => s.once('data', resolve));
    console.log('Handshake Response:', res.toString('hex'));

    if (res[0] !== 0x05 || res[1] !== 0x00) {
        console.error('Handshake failed or auth required');
        s.destroy();
        process.exit(1);
    }

    console.log('Sending connect request to target...');
    // Connect: VER=5, CMD=1, RSV=0, ATYP=3, HostLen, Host, Port
    const hostBuf = Buffer.from(targetHost);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort);
    const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf
    ]);
    s.write(req);

    const res2 = await new Promise(resolve => s.once('data', resolve));
    console.log('Connect Response:', res2.toString('hex'));

    if (res2[1] === 0x00) {
        console.log('Successfully proxied to target!');
    } else {
        console.error('Proxy connect failed with code:', res2[1]);
    }
    s.destroy();
}

test().catch(console.error);
