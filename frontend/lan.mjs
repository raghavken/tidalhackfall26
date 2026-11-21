import { createServer, createConnection, isIPv4 } from 'node:net';

const address = process.argv[2];
const port = Number(process.argv[3] || 3000);
if (!isIPv4(address) || address.startsWith('127.') || address === '0.0.0.0' ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Usage on Windows: node lan.mjs <ThinkPad Wi-Fi IPv4> [port]');
  process.exit(1);
}
createServer(client => {
  const upstream = createConnection({ host: '127.0.0.1', port });
  client.setTimeout(0);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
}).listen(port, address, () => console.log('Wi-Fi dashboard at http://' + address + ':' + port));

