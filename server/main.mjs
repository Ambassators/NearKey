import { createApp } from './app.mjs';
import { wifiAddress } from './network.mjs';

const wifi = process.argv.includes('--wifi');
const host = process.env.HOST || (wifi ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const phoneOrigin = process.env.PHONE_ORIGIN || (wifi ? `http://${wifiAddress()}:${port}` : publicOrigin);
const app = await createApp({
  publicOrigin, phoneOrigin,
  username: process.env.DEMO_USERNAME || 'admin',
  password: process.env.DEMO_PASSWORD || 'password',
});
app.server.on('error', (error) => {
  console.error(`Could not start demo server: ${error.code || 'server error'}`);
  void app.close().then(() => { process.exitCode = 1; });
});
app.server.listen(port, host, () => {
  console.log(`NearKey 2FA demo listening on ${host}:${port}`);
  console.log(`Browser: ${publicOrigin}`);
  console.log(`Phone pairing: ${phoneOrigin}`);
  console.log('In-memory demo: restart resets sessions, enrolled phone and sign-in activity.');
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  });
}
