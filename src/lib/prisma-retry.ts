function isPrismaTransactionConflict(error: unknown) {
  if (error === null || typeof error !== "object") {
    return false;
  }

  // Forma classica: l'engine Rust di v6 (e le eccezioni note del client) marcavano i conflitti
  // di serializzazione/deadlock col codice P2034. La teniamo per compatibilita' e a prova di futuro.
  if ((error as { code?: unknown }).code === "P2034") {
    return true;
  }

  // Forma v7 col driver adapter pg: la serialization failure NON passa piu' da P2034. Arriva come
  // DriverAdapterError con `code` undefined e lo SQLSTATE Postgres grezzo dentro `cause.originalCode`
  // (40001 = serialization_failure, 40P01 = deadlock_detected: gli stessi due casi che P2034 copriva).
  // Verificato contro Postgres reale forzando un conflitto Serializable con l'adapter.
  //
  // ATTENZIONE (vincolo noto, non un bug attuale): questa forma la producono solo le query TIPIZZATE
  // del client. Un 40001 sollevato da SQL GREZZO ($queryRawUnsafe/$executeRawUnsafe) arriva invece
  // come PrismaClientKnownRequestError P2010 ('Raw query failed') SENZA `cause.originalCode`, quindi
  // NON verrebbe riconosciuto qui e NON verrebbe ritentato. Oggi e' innocuo perche' tutti i body di
  // $transaction Serializable passati a retryPrismaTransaction usano solo query tipizzate. Se un
  // domani si aggiungesse SQL grezzo dentro una di quelle transazioni, il retry salterebbe in
  // silenzio: non basta allargare qui (P2010 e' generico e ritentarlo alla cieca maschererebbe
  // errori reali), andrebbe estratto lo SQLSTATE dal messaggio o tenuto il body su query tipizzate.
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object") {
    const originalCode = (cause as { originalCode?: unknown }).originalCode;
    if (originalCode === "40001" || originalCode === "40P01") {
      return true;
    }
  }

  return false;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function retryPrismaTransaction<T>(
  operation: () => Promise<T>,
  attempts = 3,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isPrismaTransactionConflict(error) || attempt === attempts) {
        throw error;
      }

      await sleep(20 * attempt);
    }
  }

  throw lastError;
}
