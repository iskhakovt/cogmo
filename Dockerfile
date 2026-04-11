FROM node:24-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY migrations/ migrations/
RUN pnpm build
RUN pnpm --filter cogmo deploy --prod /deploy

FROM gcr.io/distroless/nodejs24-debian13
ARG VERSION=dev
ENV NODE_ENV=production
ENV VERSION=$VERSION
WORKDIR /app
USER nonroot
COPY --from=build /deploy .
ENTRYPOINT ["/nodejs/bin/node", "dist/main.js"]
CMD ["serve"]
