import { createApp } from '../server/app.mjs';
import { hostedConfig } from '../server/hosted-config.mjs';

// Vercel owns the listener. Export the server so HTTP and WebSocket upgrades
// use the same function without writing to the ephemeral filesystem.
const app = await createApp(hostedConfig());
export default app.server;
