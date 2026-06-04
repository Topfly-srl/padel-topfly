# Deploy AWS EC2

Questa app puo' girare su una EC2 piccola con Docker Compose:

- `app`: Next.js
- `postgres`: database locale su volume Docker
- `caddy`: reverse proxy con HTTPS automatico

## Prerequisiti EC2

- Ubuntu 22.04/24.04 o Amazon Linux recente
- porte security group aperte: `22`, `80`, `443`
- Docker e Docker Compose installati
- dominio puntato all'IP della EC2, ad esempio `padel.topflysolutions.com`

Per un test veloce senza DNS si puo' usare solo HTTP impostando:

```env
APP_DOMAIN=:80
APP_PUBLIC_ORIGIN=http://IP_EC2
AUTH_URL=http://IP_EC2
```

Quando si passa al dominio reale, rimettere `https://...` e lasciare che Caddy generi il certificato.

## Env

Sul server, nella cartella `/opt/padel-topfly`, creare `.env.production` partendo da `.env.production.example`.

Generare i segreti:

```bash
openssl rand -base64 32
openssl rand -base64 24
```

`POSTGRES_PASSWORD` e la password dentro `DATABASE_URL` devono essere identiche.

## Deploy

Dal Mac locale:

```bash
AWS_HOST=ec2-host-o-ip AWS_USER=ubuntu ./scripts/deploy-aws.sh
```

Lo script:

1. clona o aggiorna la repo pubblica;
2. verifica che `.env.production` esista;
3. builda l'immagine;
4. avvia app, Postgres e Caddy;
5. esegue automaticamente `prisma migrate deploy` all'avvio dell'app.

## Bitwarden

Salvare in Bitwarden una nota/voce "Padel TOPFLY production" con:

- host EC2;
- utente SSH;
- contenuto `.env.production`;
- dominio;
- eventuali dettagli Microsoft Entra/Graph.

Non committare mai `.env.production`.
