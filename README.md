# Padel TOPFLY

Web app interna mobile-first per prenotare il campo da padel aziendale senza login utente.

## Stack

- Next.js App Router + TypeScript
- Prisma + Postgres
- Auth.js / NextAuth con Microsoft Entra ID solo per area admin
- Microsoft Graph per inviti Outlook e promemoria

## Setup locale

1. Copia `.env.example` in `.env.local` e configura almeno `DATABASE_URL`.
2. Per sviluppo admin senza Microsoft 365, lascia `AUTH_DEV_MODE="true"`.
3. Genera Prisma:

```bash
npm run prisma:generate
```

4. Esegui le migrazioni:

```bash
npm run prisma:migrate
```

5. Avvia l'app:

```bash
npm run dev
```

## Microsoft 365

Gli utenti normali prenotano senza login: scelgono slot, compilano nome/email e ricevono il link di gestione via invito Outlook.

Per l'area `/admin`, disattiva `AUTH_DEV_MODE`, registra l'app in Microsoft Entra ID e configura:

- `MICROSOFT_ENTRA_ID_ID`
- `MICROSOFT_ENTRA_ID_SECRET`
- `MICROSOFT_ENTRA_ID_TENANT_ID`
- `MS_GRAPH_*`

La mailbox del campo, ad esempio `padel@azienda.it`, viene usata per creare gli eventi Outlook con reminder 1h prima e link modifica/cancellazione.
