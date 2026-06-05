#!/usr/bin/env bash
set -euo pipefail

: "${AWS_HOST:?Set AWS_HOST to the EC2 public DNS or IP}"
AWS_USER="${AWS_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/opt/padel-topfly}"
REPO_URL="${REPO_URL:-https://github.com/Topfly-srl/padel-topfly.git}"
DOCKER_COMPOSE="${DOCKER_COMPOSE:-sudo docker compose}"

ssh "${AWS_USER}@${AWS_HOST}" "APP_DIR='${APP_DIR}' REPO_URL='${REPO_URL}' DOCKER_COMPOSE='${DOCKER_COMPOSE}' bash -s" <<'REMOTE'
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed on this EC2 instance." >&2
  exit 1
fi

sudo mkdir -p "${APP_DIR}"
sudo chown "$USER:$USER" "${APP_DIR}"

if [ ! -d "${APP_DIR}/.git" ]; then
  git clone "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
git fetch origin main
git checkout main
git pull --ff-only origin main

if [ ! -f .env.production ]; then
  echo ".env.production is missing in ${APP_DIR}. Create it before deploying." >&2
  exit 1
fi

DOCKER_COMPOSE="${DOCKER_COMPOSE:-sudo docker compose}"

$DOCKER_COMPOSE -f docker-compose.production.yml up -d --build
$DOCKER_COMPOSE -f docker-compose.production.yml ps
REMOTE
