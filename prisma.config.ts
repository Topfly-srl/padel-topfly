// Config Prisma v7. La CLI non auto-carica piu' .env: `import 'dotenv/config'` in cima
// popola process.env dal file .env in locale. In container non c'e' .env e DATABASE_URL
// arriva gia' come env var, quindi dotenv fa no-op e env('DATABASE_URL') si risolve lo stesso.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// `env('DATABASE_URL')` risolve subito e LANCIA se la variabile manca. Ma `prisma generate`
// (in build/CI) deve girare senza DB e senza URL: il provider gli basta prenderlo dallo schema.
// Percio' includiamo il blocco datasource solo quando l'URL c'e' davvero (runtime, migrate
// deploy nel container, test di integrazione). Cosi' generate resta verde a secco e migrate
// deploy continua a leggere l'URL da qui.
const databaseUrl = process.env.DATABASE_URL ? env("DATABASE_URL") : undefined;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
