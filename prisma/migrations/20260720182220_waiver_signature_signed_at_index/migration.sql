-- L'archivio firme admin ordina per signedAt desc (listAdminWaiverSignatures): senza indice su
-- signedAt il DB fa una sort a ogni pagina. Questo indice regge l'orderBy della lista.
CREATE INDEX IF NOT EXISTS "WaiverSignature_signedAt_idx" ON "WaiverSignature"("signedAt");
