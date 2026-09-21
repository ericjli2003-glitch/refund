FROM node:22.18-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22.18-alpine AS production
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY scripts/merchant-opportunities.mjs ./scripts/merchant-opportunities.mjs
# The production entrypoint and the TLS normalization it applies before running
# migrations and starting the server.
COPY scripts/start-production.mjs ./scripts/start-production.mjs
COPY app/database-url.mjs ./app/database-url.mjs

EXPOSE 3000
USER node
CMD ["npm", "run", "start:production"]
