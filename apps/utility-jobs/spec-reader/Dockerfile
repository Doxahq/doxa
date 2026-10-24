# The spec-reader utility job. The build context is the repository root.
# The final stage holds Node, supervisor.mjs and job.mjs, and nothing else:
# no other job, no agent code, no package manager, no keys.

FROM node:26-slim AS build
WORKDIR /src
# Node 25 and later do not ship Corepack. Keep this version equal to the root packageManager field.
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/utility-jobs/spec-reader ./apps/utility-jobs/spec-reader
RUN pnpm install --filter @doxahq/job-spec-reader... --frozen-lockfile
RUN pnpm --filter @doxahq/job-spec-reader bundle

FROM node:26-slim
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app/job
# Root owns the copied files, so the job cannot change its own code.
COPY --from=build /src/apps/utility-jobs/spec-reader/dist/supervisor.mjs \
                  /src/apps/utility-jobs/spec-reader/dist/job.mjs ./
USER node
EXPOSE 8790
CMD ["node", "--disable-sigusr1", "/app/job/supervisor.mjs"]
