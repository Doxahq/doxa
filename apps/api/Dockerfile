# The doxa-api origin: the API as a Node server, for ECS Fargate (ARM64).
# Build from the repository root:
#   docker buildx build --platform linux/arm64 -f apps/api/Dockerfile -t doxa-api:<git-sha> .

FROM node:24-slim AS build
WORKDIR /repo

# Keep this version equal to the root packageManager field.
RUN npm install -g pnpm@10.33.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

RUN pnpm install --filter @doxahq/api... --frozen-lockfile
# Some workspace packages export dist/ files, so build them before the bundle.
RUN pnpm --filter "@doxahq/api^..." build
RUN node apps/api/scripts/node-server.mjs build

# The bundle holds every dependency, so the runtime image needs only Node and the bundle.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/api/dist-node ./
USER node
EXPOSE 8786
CMD ["node", "--enable-source-maps", "server.mjs"]
