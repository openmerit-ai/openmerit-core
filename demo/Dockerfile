FROM node:22-bookworm-slim
WORKDIR /opt/openmerit
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/pi/package.json packages/pi/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY dist ./dist
COPY demo/runtime ./demo/runtime
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENV PORT=45832 DEMO_WORKSPACE=/workspace NODE_ENV=production
EXPOSE 45832
CMD ["node", "/opt/openmerit/demo/runtime/server.mjs"]
