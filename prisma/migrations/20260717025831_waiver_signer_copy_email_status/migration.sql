ALTER TABLE "WaiverSignature"
  ADD COLUMN IF NOT EXISTS "signerEmailStatus" "WaiverEmailStatus" NOT NULL DEFAULT 'SKIPPED',
  ADD COLUMN IF NOT EXISTS "signerEmailError" TEXT,
  ADD COLUMN IF NOT EXISTS "signerEmailSentAt" TIMESTAMP(3);

-- Il default 'SKIPPED' descrive una firma ospite, che una copia al firmatario non ce l'ha. Sulle
-- righe referente storiche mentirebbe: la copia il vecchio codice la mandava, dentro lo stesso
-- try dell'archivio e subito dopo di esso, registrando un esito solo in emailStatus. Lasciarle a
-- 'SKIPPED' senza errore le fa leggere come "non c'era niente da mandare", quindi l'area admin
-- direbbe "Non configurata" anche dove la copia era partita davvero, e soprattutto una riga
-- 'FAILED' non sarebbe piu' reinviabile sulla copia: il vecchio reinvio mandava entrambe le mail,
-- quello nuovo si fermerebbe all'archivio.
--
-- Ricopiare l'esito dell'archivio e' un'approssimazione - il vecchio codice mascherava dietro un
-- 'SENT' il fallimento della sola copia - ma e' molto piu' vicina al vero di 'SKIPPED' e
-- ripristina il reinvio sulle righe 'FAILED'. Tocca solo le righe ancora al valore di default,
-- cosi' non calpesta esiti gia' scritti.
UPDATE "WaiverSignature"
SET "signerEmailStatus" = "emailStatus",
    "signerEmailError" = "emailError",
    "signerEmailSentAt" = "emailSentAt"
WHERE "signerRole" = 'ORGANIZER'
  AND "signerEmailStatus" = 'SKIPPED'
  AND "signerEmailError" IS NULL
  AND "signerEmailSentAt" IS NULL;

CREATE INDEX IF NOT EXISTS "WaiverSignature_signerEmailStatus_idx"
  ON "WaiverSignature"("signerEmailStatus");
