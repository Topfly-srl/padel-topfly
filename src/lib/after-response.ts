import { after } from "next/server";

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
  const safeTask = async () => {
    try {
      await task();
    } catch {
      // Gli effetti collaterali gestiscono gia' i propri errori salvando lo stato (FAILED/PENDING).
      // Qui evitiamo solo che un'eccezione inattesa diventi un unhandled rejection.
    }
  };

  try {
    after(safeTask);
  } catch {
    // `after()` chiamato fuori da un request scope: fallback best-effort.
    void safeTask();
  }
}
