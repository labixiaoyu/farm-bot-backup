import { connect } from 'node:net';

const host = '100.114.70.126';
const port = 1080;

console.log(`Connecting to ${host}:${port}...`);
const start = Date.now();

const s = connect(port, host);
s.setTimeout(10000);

s.on('connect', () => {
    console.log(`Successfully connected to ${host}:${port} in ${Date.now() - start}ms`);
    s.destroy();
    process.exit(0);
});

s.on('error', (err) => {
    console.error(`Connection failed: ${err.message}`);
    console.error(err);
    process.exit(1);
});

s.on('timeout', () => {
    console.error('Connection timed out after 10s');
    s.destroy();
    process.exit(1);
});
