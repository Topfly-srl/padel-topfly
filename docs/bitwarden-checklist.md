# Bitwarden Checklist

Checklist per salvare in modo ordinato tutto cio' che serve a mantenere e recuperare
Padel TOPFLY.

Non salvare questi dati in GitHub, issue, chat, screenshot o documentazione pubblica.

## Item Consigliati

### 1. Padel TOPFLY - Produzione

Tipo consigliato: **Secure note**.

Da salvare:

- URL produzione: `https://padel.topflysolutions.com`;
- repo GitHub: `https://github.com/Topfly-srl/padel-topfly`;
- server path: `/opt/padel-topfly`;
- hosting: AWS Lightsail;
- istanza: `padel-topfly`;
- regione: `eu-central-1`, Frankfurt;
- static IP: `18.194.7.194`;
- DNS: record `A` `padel.topflysolutions.com -> 18.194.7.194`;
- runtime: Docker Compose;
- servizi: `app`, `postgres`, `caddy`;
- volume DB: `padel_topfly_pgdata`;
- path backup DB/env: `/var/backups/padel-topfly`;
- mailbox Outlook: `padel@topflysolutions.com`;
- admin app: `antony.buffone@topflysolutions.com`;
- data ultimo backup manuale o snapshot importante.

Questi dati non sono tutti segreti, ma conviene averli nello stesso punto operativo.

### 2. Padel TOPFLY - Env Produzione

Tipo consigliato: **Secure note**.

Da salvare:

- contenuto completo di `.env.production` del server;
- `AUTH_SECRET`;
- `POSTGRES_PASSWORD`;
- `DATABASE_URL`;
- `MICROSOFT_ENTRA_ID_ID`;
- `MICROSOFT_ENTRA_ID_SECRET`;
- `MICROSOFT_ENTRA_ID_TENANT_ID`;
- `MS_GRAPH_TENANT_ID`;
- `MS_GRAPH_CLIENT_ID`;
- `MS_GRAPH_CLIENT_SECRET`;
- `MS_GRAPH_MAILBOX`;
- data scadenza dei client secret Microsoft.

Questa e' la nota piu' importante per disaster recovery. Deve restare aggiornata ogni
volta che cambiano env o secret.

### 3. Padel TOPFLY - GitHub Actions Deploy SSH

Tipo consigliato: **SSH key** oppure **Secure note**.

Da salvare:

- chiave privata `LIGHTSAIL_SSH_PRIVATE_KEY`;
- utente SSH: `ubuntu`;
- host: `18.194.7.194`;
- known hosts usato in `LIGHTSAIL_KNOWN_HOSTS`;
- repository variable: `PRODUCTION_AUTO_DEPLOY=true`;
- workflow: `.github/workflows/deploy-production.yml`;
- nota: chiave dedicata solo al deploy GitHub Actions.

Questa chiave serve per deploy automatico. Se viene compromessa, rimuoverla da
`~/.ssh/authorized_keys` su Lightsail, eliminarla dai GitHub Actions secrets e generarne
una nuova.

### 4. Padel TOPFLY - Microsoft Entra App

Tipo consigliato: **Secure note**.

Da salvare:

- app registration: `Padel TOPFLY Admin`;
- redirect URI:
  `https://padel.topflysolutions.com/api/auth/callback/microsoft-entra-id`;
- client ID;
- tenant ID;
- client secret;
- data scadenza secret;
- permessi Graph attesi: `Calendars.ReadWrite` e `Mail.Send` Application con admin consent;
- nota: `Mail.Send` serve solo per inviare a Cecilia i PDF dello scarico responsabilita';
- nota sicurezza: accesso Graph da limitare alla sola mailbox `padel@topflysolutions.com`
  tramite Exchange Application Access Policy o RBAC for Applications, includendo `Mail.Send`;
- stato della policy Exchange: configurata/non configurata, data verifica, chi l'ha
  verificata.

### 5. Padel TOPFLY - Mailbox Outlook

Tipo consigliato: **Secure note**.

Da salvare:

- mailbox: `padel@topflysolutions.com`;
- tipo mailbox: condivisa/tecnica;
- proprietari o membri autorizzati;
- eventuali alias;
- note su licenza, se presente;
- policy: non usare questa mailbox come account personale.

Se la mailbox ha credenziali di login dedicate, salvarle in un item separato e abilitare
le protezioni Microsoft disponibili.

### 6. Accessi Infrastruttura Collegati

Se non sono gia' in Bitwarden aziendale, creare o verificare item separati per:

- account AWS/TOPFLY o procedura SSO;
- account cPanel/Serverplan per DNS;
- account GitHub con accesso al repo/organizzazione `Topfly-srl`;
- account Microsoft 365/Entra amministrativo.

Non duplicare password personali dentro la nota Padel se sono gia' gestite in item
aziendali dedicati. Nella nota Padel basta indicare dove trovarle.

## Cosa Non Salvare

- token di gestione prenotazione degli utenti;
- dump database completi, salvo policy aziendale esplicita;
- screenshot con segreti visibili;
- chiavi temporanee gia' revocate;
- vecchi client secret Microsoft scaduti o eliminati.

## Rotazione Consigliata

- Microsoft client secret: prima della scadenza indicata in Entra.
- GitHub Actions SSH key: quando cambia chi amministra il progetto o se finisce in chat/log.
- `AUTH_SECRET`: solo se sospetti compromissione, sapendo che puo' invalidare sessioni.
- `POSTGRES_PASSWORD`: solo con finestra di manutenzione, aggiornando anche `DATABASE_URL`.

## Dopo Ogni Modifica Ai Segreti

1. aggiornare Bitwarden;
2. aggiornare GitHub Actions secrets o `.env.production`, se coinvolti;
3. riavviare app o workflow;
4. testare login admin, creazione prenotazione, firma waiver, invio PDF e cancellazione Outlook;
5. annotare data e motivo della modifica.

## Checklist Security Audit

Da aggiornare quando si chiude un finding del report
[`docs/security-audit.md`](security-audit.md):

- verifica `Mail.Send` limitato alla sola mailbox Padel;
- Application Access Policy/RBAC Exchange per Graph;
- eventuale rotazione deploy key GitHub Actions;
- stato branch protection GitHub;
- data ultimo snapshot/backup DB verificato.
- path backup operativo: `/var/backups/padel-topfly`.
