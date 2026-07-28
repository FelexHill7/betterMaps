import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './api.ts';
import { attachRealtime } from './realtime.ts';

const PORT = Number(process.env.PORT ?? 5178);
const app = express();

app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, at: Date.now() }));
app.use('/api', api);

// In production the built SPA is served from the same origin, so a phone only
// needs one URL and the WebSocket rides the same host.
const dist = resolve(import.meta.dirname, '../../web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(resolve(dist, 'index.html'));
  });
}

const server = createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  console.log(`betterMaps api  →  http://localhost:${PORT}`);
  console.log(`         socket  →  ws://localhost:${PORT}/ws`);
  if (!existsSync(dist)) console.log('         (run `npm run dev` for the web app on :5177)');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
