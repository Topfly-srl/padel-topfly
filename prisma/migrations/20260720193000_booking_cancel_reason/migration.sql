-- Motivo di annullamento facoltativo: chi annulla (referente dalla pagina di gestione o admin)
-- puo' indicare una causale breve da una piccola select. E' additiva e nullable, quindi il flusso
-- attuale senza motivo resta identico: le righe storiche restano a NULL e nessun vincolo cambia.
-- Il tetto dei 200 caratteri lo applica il service, non lo schema, come per gli altri String liberi.
ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
