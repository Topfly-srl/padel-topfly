import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = {
  "@": path.resolve(__dirname, "./src"),
};

// Due progetti separati:
// - "unit": i test demo-mode di sempre, veloci e senza DB (prisma/config mockati). E' quello che
//   gira con `npm test`, quindi la CI standard resta demo-only e non ha bisogno di un Postgres.
// - "integration": SOLO i *.int.test.ts, che parlano con un Postgres vero. Girano con
//   `npm run test:integration` (che passa --project integration) e si auto-skippano senza
//   DATABASE_URL, cosi' un run locale distratto non esplode.
// I file *.int.test.ts sono esclusi dal progetto unit: senza l'exclude verrebbero raccolti anche
// li' (finiscono comunque in *.test.ts) e girerebbero senza DB.
export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.int.test.ts"],
          // Un solo Postgres condiviso: se i file girassero in parallelo il truncate di uno
          // cancellerebbe i dati di un altro a meta' test. Li serializziamo (un file per volta,
          // stessa connessione Prisma) cosi' ognuno ha il DB tutto per se'.
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
