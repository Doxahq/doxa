FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs-template/package.json apps/docs-template/package.json
COPY packages/mdx-runtime/package.json packages/mdx-runtime/package.json
RUN pnpm install --frozen-lockfile --filter @doxahq/docs-template...

FROM deps AS builder

ENV NODE_OPTIONS="--max-old-space-size=4096"

ARG VITE_SITE_URL
ARG VITE_COMPANY_LINK
ARG VITE_OPENSOURCE_REPO_URL
ARG VITE_DEBUG_CONTENT

ENV VITE_SITE_URL=$VITE_SITE_URL
ENV VITE_COMPANY_LINK=$VITE_COMPANY_LINK
ENV VITE_OPENSOURCE_REPO_URL=$VITE_OPENSOURCE_REPO_URL
ENV VITE_DEBUG_CONTENT=$VITE_DEBUG_CONTENT

COPY tsconfig.base.json ./
COPY packages/mdx-runtime packages/mdx-runtime
COPY apps/docs-template apps/docs-template
RUN pnpm --filter @doxahq/docs-template build:docker

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY --from=builder --chown=nonroot:nonroot /app/apps/docs-template/.output ./.output

EXPOSE 3000

CMD [".output/server/index.mjs"]
