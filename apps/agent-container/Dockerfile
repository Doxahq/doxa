FROM node:26-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Node 25 and later do not ship Corepack. Keep this version equal to the root packageManager field.
RUN npm install -g pnpm@10.33.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/agent-container ./apps/agent-container

RUN pnpm install --filter @doxahq/agent-container... --frozen-lockfile
RUN pnpm --filter @doxahq/agent... build
RUN pnpm --filter @doxahq/agent preflight

ENV DOXA_WORKSPACE_ROOT=/app
# A child process must not be able to open the Inspector of the agent process.
ENV NODE_OPTIONS=--disable-sigusr1
RUN mkdir -p /app/.workspaces && chown node:node /app/.workspaces
USER node

EXPOSE 8789
CMD ["pnpm", "--filter", "@doxahq/agent-container", "start"]
