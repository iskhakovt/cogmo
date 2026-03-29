FROM node:24-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts biome.json ./
COPY src/ src/
COPY migrations/ migrations/
RUN pnpm build
RUN pnpm --filter assistant deploy --prod /deploy

FROM gcr.io/distroless/nodejs24-debian13
ENV NODE_ENV=production
WORKDIR /app
USER nonroot
COPY --from=build /deploy .
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
