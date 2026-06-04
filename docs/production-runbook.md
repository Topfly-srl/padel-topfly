# Stato Produzione E Checklist

Documento di stato per Padel TOPFLY aggiornato dopo il primo deploy AWS.

## Produzione Attiva

URL:

- <https://padel.topflysolutions.com>

Risorse:

- GitHub repo: `Topfly-srl/padel-topfly`.
- AWS Lightsail instance: `padel-topfly`.
- Static IP: `18.194.7.194`.
- DNS: `padel.topflysolutions.com`.
- Server path: `/opt/padel-topfly`.
- Runtime: Docker Compose.
- Database: Postgres locale in Docker.
- Reverse proxy: Caddy.
- Certificato HTTPS: Let's Encrypt via Caddy.

## Cosa E' Gia' Fatto

- App Next.js deployata in produzione.
- Repo GitHub pubblica.
- AWS Lightsail creata e configurata.
- Static IP associato.
- DNS aziendale configurato via cPanel/Serverplan.
- HTTPS attivo con redirect automatico da HTTP.
- Postgres locale persistente su volume Docker.
- Migrazioni Prisma eseguite automaticamente all'avvio app.
- Login pubblico eliminato per gli utenti normali.
- Prenotazione pubblica con nome/cognome + email.
- "Le mie prenotazioni" basata su token salvati nel browser.
- Modifica/cancellazione prenotazione tramite token.
- Area `/admin` protetta da Microsoft Entra ID.
- Admin abilitato: `antony.buffone@topflysolutions.com`.
- UX desktop sistemata: sidebar riepilogo + prenotazioni sticky insieme.
- UI brandizzata TOPFLY con palette rossa aziendale.

## Cosa Non E' Ancora Fatto

- Microsoft Graph/Outlook non configurato.
- Mailbox/calendario dedicato `padel@topflysolutions.com` da confermare o creare.
- Inviti Outlook automatici non ancora attivi.
- Reminder Outlook 1h non ancora attivo.
- Backup automatici non ancora configurati.
- Monitoraggio/alerting non ancora configurato.
- Eventuale pagina/documento interno per annunciare il link ai dipendenti.

## Test Da Fare Prima Di Annunciare In Azienda

Da browser normale:

1. Aprire <https://padel.topflysolutions.com>.
2. Creare una prenotazione con nome e email aziendale.
3. Verificare che lo slot risulti occupato con solo nome visibile.
4. Verificare "Le mie prenotazioni".
5. Modificare la prenotazione.
6. Cancellare la prenotazione.
7. Creare due prenotazioni future con la stessa email.
8. Tentare una terza prenotazione futura con la stessa email e verificare il blocco.

Da admin:

1. Aprire <https://padel.topflysolutions.com/admin>.
2. Fare login Microsoft con account admin.
3. Creare un blocco campo.
4. Verificare che un utente non possa prenotare su quello slot.
5. Rimuovere il blocco.
6. Controllare storico/audit.

Da terminale locale:

```bash
curl -I https://padel.topflysolutions.com
curl -I http://padel.topflysolutions.com
```

Atteso:

- HTTPS: `HTTP/2 200`.
- HTTP: `308 Permanent Redirect`.

## Procedura Aggiornamento Codice

Locale:

```bash
npm run lint
npm test
npm run build
git status --short
```

Dopo commit/push su `main`, server:

```bash
cd /opt/padel-topfly
git pull origin main
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml ps
```

Verifica:

```bash
sudo docker compose -f docker-compose.production.yml logs -f app
curl -I https://padel.topflysolutions.com
```

## Procedura Aggiornamento Env

Prima backup:

```bash
cd /opt/padel-topfly
sudo cp .env.production .env.production.backup.$(date +%Y%m%d-%H%M%S)
sudo nano .env.production
```

Se cambiano solo env app:

```bash
sudo docker compose -f docker-compose.production.yml up -d --force-recreate app
sudo docker compose -f docker-compose.production.yml ps
```

Se cambia dominio/Caddy:

```bash
sudo docker compose -f docker-compose.production.yml up -d
sudo docker compose -f docker-compose.production.yml logs -f caddy
```

## Backup E Conservazione Credenziali

Da salvare in Bitwarden:

- `.env.production` completo.
- `AUTH_SECRET`.
- `POSTGRES_PASSWORD`.
- Microsoft Entra client ID, tenant ID e client secret.
- Static IP e dati server.
- Eventuali Graph secret futuri.

Da non salvare in Git:

- `.env.production`.
- backup `.env.production.backup.*`.
- chiavi SSH.
- client secret Microsoft.

## Costi

Configurazione volutamente minimale:

- una sola istanza Lightsail;
- database locale su Docker;
- niente database gestito;
- niente load balancer;
- niente CDN;
- niente snapshot automatici per ora.

Costo atteso dopo eventuale periodo gratuito: circa il costo mensile del piano Lightsail scelto.

## Prossimi Passi Consigliati

1. Salvare `.env.production` e dati server in Bitwarden.
2. Fare smoke test completo con 2-3 colleghi.
3. Configurare Microsoft Graph/Outlook.
4. Decidere se creare mailbox dedicata `padel@topflysolutions.com`.
5. Valutare snapshot manuale o backup database prima di aprire a tutti.
6. Preparare messaggio interno con link e regole d'uso.

## Comandi Di Emergenza

Riavvio app:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml restart app
```

Riavvio completo stack:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml restart
```

Fermare stack:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml down
```

Attenzione: `down` non elimina i volumi se non si usa `-v`, quindi il DB resta. Non usare `-v` in produzione.
