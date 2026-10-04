import { createApp } from './app.mjs';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
const app = await createApp({
  publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
  username: process.env.DEMO_USERNAME || 'demo',
  password: process.env.DEMO_PASSWORD || 'demo-passive-key',
});
app.server.on('error', (error) => {
  console.error(`Could not start demo server: ${error.code || 'server error'}`);
  void app.close().then(() => { process.exitCode = 1; });
});
app.server.listen(port, host, () => {
  console.log(`NearKey fictional demo listening on ${host}:${port}`);
  console.log('In-memory demo: restart resets account, sessions, enrolled phone and transfers.');
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  });
}
