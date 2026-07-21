import { availableParallelism } from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

// In v7 il driver adapter e' obbligatorio: il client non ha piu' l'engine Rust che apriva la
// connessione da solo. PrismaPg avvolge il pool 'pg' e riceve la connection string. In demo-mode
// (senza DATABASE_URL) il client viene costruito ma mai interrogato, quindi la connection string
// undefined non e' un problema: nessuna connessione viene aperta a vuoto.
const databaseUrl = process.env.DATABASE_URL;

// L'adapter pg NON consuma il parametro `?schema=` della connection string (a differenza
// dell'engine Rust di v6, che lo leggeva dall'URL): lo schema va passato a parte come opzione
// `schema` del secondo argomento di PrismaPg. Senza, le query generate non vengono qualificate
// con lo schema dell'URL e funzionano solo perche' 'public' e' gia' nel search_path di default.
// Lo estraiamo dall'URL cosi' uno schema non-default resta onorato come in v6.
const schema = databaseUrl
  ? new URL(databaseUrl).searchParams.get("schema") ?? undefined
  : undefined;

// Il pool 'pg' ha default diversi dall'engine Rust di v6: senza reimpostarli l'upgrade
// cambierebbe in silenzio la semantica del pool sotto carico. Ripristiniamo i valori v6:
//  - connectionTimeoutMillis: il pool 'pg' non ha un timeout di connessione (aspetterebbe
//    all'infinito su un DB irraggiungibile), l'engine Rust usava 5s.
//  - max: v6 dimensionava il pool a num_cpus*2+1; il default di 'pg' e' 10.
//  - idleTimeoutMillis: 0 disabilita l'eviction delle connessioni idle come faceva v6; il
//    default di 'pg' (10s) le chiuderebbe, con piu' churn di riconnessione.
const adapter = new PrismaPg(
  {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    max: availableParallelism() * 2 + 1,
    idleTimeoutMillis: 0,
  },
  schema ? { schema } : undefined,
);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
