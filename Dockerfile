FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder

WORKDIR /app
ARG APP_ENV
ARG APP_PUBLIC_ORIGIN
ARG AUTH_URL
ENV APP_ENV=$APP_ENV
ENV APP_PUBLIC_ORIGIN=$APP_PUBLIC_ORIGIN
ENV AUTH_URL=$AUTH_URL
ENV NEXT_TELEMETRY_DISABLED=1
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
# In v7 la CLI legge schema/URL da prisma.config.ts: serve nel runner perche' l'entrypoint
# fa `prisma migrate deploy`. dotenv resta in node_modules (e' una dependency) e in container
# DATABASE_URL arriva come env var, quindi non serve un file .env.
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
# Il client Prisma v7 e' generato fuori da node_modules (src/generated/prisma). Il build Next lo
# incorpora nei bundle .next, ma lo copiamo comunque nel runner come rete di sicurezza contro
# l'errore "Cannot find module" a runtime, dato che l'app non usa output:'standalone'.
COPY --from=builder /app/src/generated ./src/generated
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN addgroup -S app && adduser -S app -G app \
  && chmod +x ./docker/entrypoint.sh \
  && chown -R app:app /app

USER app

EXPOSE 3000
CMD ["./docker/entrypoint.sh"]
