# Build from the repository root:  docker build -f examples/scout/Dockerfile -t scout .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY examples/scout/package.json examples/scout/
RUN npm ci --ignore-scripts
COPY packages/sdk packages/sdk
COPY examples/scout examples/scout
RUN npm run build --workspace @pulse/agent-sdk && npm run build --workspace @pulse/agent-sdk-example-scout \
 && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 TOKEN_FILE=/data/pulse-tokens.json
WORKDIR /app
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist packages/sdk/dist
COPY --from=build /repo/examples/scout/package.json examples/scout/package.json
COPY --from=build /repo/examples/scout/dist examples/scout/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "examples/scout/dist/src/main.js"]
