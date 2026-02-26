import { connect } from 'node:net';

const proxyHost = '100.114.70.126';
const proxyPort = 1080;

async function test() {
    console.log(`Connecting to proxy ${proxyHost}:${proxyPort}...`);
    const s = connect(proxyPort, proxyHost);

    const timeout = setTimeout(() => {
        console.error('TIMED OUT');
        s.destroy();
        process.exit(1);
    }, 5000);

    await new Promise(resolve => s.on('connect', resolve));
    console.log('TCP Connected. Sending HTTP GET...');

    s.write('GET / HTTP/1.1\r\nHost: www.google.com\r\n\r\n');

    s.on('data', (data) => {
        clearTimeout(timeout);
        console.log('Received Response:');
        console.log(data.toString().substring(0, 100));
        s.destroy();
        process.exit(0);
    });

    s.on('error', (err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });
}

test().catch(console.error);
