import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';

await migrate();

const app = buildApp();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
