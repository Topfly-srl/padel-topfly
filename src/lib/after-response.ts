import { after } from "next/server";

const pendingTasks = new Set<Promise<void>>();

function runTrackedTask(task: () => Promise<unknown>) {
  const pendingTask = (async () => {
    try {
      await task();
    } catch {
      // Gli effetti collaterali gestiscono gia' i propri errori salvando lo stato (FAILED/PENDING).
      // Qui evitiamo solo che un'eccezione inattesa diventi un unhandled rejection.
    }
  })();

  pendingTasks.add(pendingTask);
  void pendingTask.finally(() => {
    pendingTasks.delete(pendingTask);
  });
  return pendingTask;
}

/**
 * Esegue lavoro accessorio e potenzialmente lento (invio email, sync Microsoft Graph/Outlook)
 * DOPO che la risposta HTTP e' stata inviata, così la latenza di Graph non rallenta l'utente.
 *
 * La parte transazionale (creazione prenotazione, firma, conteggi) resta sincrona: qui finiscono
 * solo gli effetti collaterali idempotenti che aggiornano lo stato (emailStatus, outlookSyncStatus)
 * con la loro stessa logica di persistenza.
 *
 * Fuori da un contesto richiesta (test, script, demo mode) `after()` non e' disponibile: in quel
 * caso eseguiamo il task best-effort senza bloccare e ingoiando eventuali errori, perche' il
 * fallimento di una notifica accessoria non deve mai propagarsi all'operazione principale.
 */
export function runAfterResponse(task: () => Promise<unknown>) {
  const safeTask = () => runTrackedTask(task);

  try {
    after(safeTask);
  } catch {
    // `after()` chiamato fuori da un request scope: fallback best-effort.
    void safeTask();
  }
}

// I test d'integrazione svuotano un Postgres condiviso tra uno scenario e il successivo. Un timeout
// fisso non garantisce che email e sync Graph siano davvero terminati, soprattutto sotto carico:
// questa barriera aspetta i task reali e ripete il controllo se un task ne ha accodato un altro.
export async function waitForAfterResponseTasks() {
  while (pendingTasks.size > 0) {
    await Promise.all([...pendingTasks]);
  }
}
