FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder

WORKDIR /app
ARG APP_ENV
ARG APP_BASE_PATH
ARG APP_PUBLIC_ORIGIN
ARG AUTH_URL
ARG NEXT_PUBLIC_APP_BASE_PATH
ENV APP_ENV=$APP_ENV
ENV APP_BASE_PATH=$APP_BASE_PATH
ENV APP_PUBLIC_ORIGIN=$APP_PUBLIC_ORIGIN
ENV AUTH_URL=$AUTH_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_BASE_PATH=$NEXT_PUBLIC_APP_BASE_PATH
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY package.json package-lock.json ./
COPY next.config.ts ./next.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN addgroup -S app && adduser -S app -G app \
  && chmod +x ./docker/entrypoint.sh \
  && chown -R app:app /app

USER app

EXPOSE 3000
CMD ["./docker/entrypoint.sh"]
