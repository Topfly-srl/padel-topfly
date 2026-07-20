#!/usr/bin/env bash
# Backup notturno del database Postgres di Padel TOPFLY.
#
# Pensato per girare da cron come root in /opt/padel-topfly (vedi
# /etc/cron.d/padel-backup installato dal workflow Deploy Production). Crea un
# dump gzippato in /var/backups/padel-topfly e pota i dump piu' vecchi di 14
# giorni. Il pg_dump e' lo stesso comando del pre-deploy nel workflow.
set -euo pipefail

APP_DIR="/opt/padel-topfly"
COMPOSE_FILE="docker-compose.production.yml"
BACKUP_DIR="/var/backups/padel-topfly"
RETENTION_DAYS=14

cd "${APP_DIR}"

install -d -m 750 "${BACKUP_DIR}"

timestamp="$(date +%Y%m%d-%H%M%S)"
dump_file="${BACKUP_DIR}/padel_topfly_${timestamp}.sql.gz"
# Scrive prima su un file temporaneo cosi' un dump interrotto non lascia mai un
# .sql.gz troncato dall'aspetto valido; la trap lo rimuove se qualcosa fallisce.
tmp_file="$(mktemp "${BACKUP_DIR}/.padel_topfly_${timestamp}.XXXXXX")"
cleanup() { rm -f "${tmp_file}"; }
trap cleanup EXIT

echo "[$(date -Is)] Avvio backup Postgres verso ${dump_file}"

# Stesso pg_dump del pre-deploy nel workflow, qui compresso al volo con gzip.
# set -o pipefail fa fallire lo script se pg_dump non riesce anche se gzip esce 0.
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  pg_dump -U padel -d padel_topfly \
  | gzip -c > "${tmp_file}"

chmod 600 "${tmp_file}"
mv "${tmp_file}" "${dump_file}"

echo "[$(date -Is)] Dump completato: $(du -h "${dump_file}" | cut -f1) ${dump_file}"

# Prune dei backup piu' vecchi della retention. -mtime +N tiene i file toccati
# entro N giorni e rimuove quelli piu' vecchi. Oltre ai dump notturni .sql.gz
# poto anche i dump pre-deploy NON compressi 'padel_topfly_*.sql' e le copie
# 'env.production.*.bak' che il workflow di deploy lascia in questa stessa
# cartella a ogni esecuzione: senza questo, si accumulano all'infinito e
# riempiono il disco della Lightsail. I temporanei .padel_topfly_*.XXXXXX
# iniziano con un punto e non matchano nessuno dei pattern.
deleted="$(find "${BACKUP_DIR}" -maxdepth 1 -type f \
  \( -name 'padel_topfly_*.sql.gz' -o -name 'padel_topfly_*.sql' -o -name 'env.production.*.bak' \) \
  -mtime +"${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"
echo "[$(date -Is)] Prune completato: rimossi ${deleted} dump piu' vecchi di ${RETENTION_DAYS} giorni"
