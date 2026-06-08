function isPrismaTransactionConflict(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  );
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
