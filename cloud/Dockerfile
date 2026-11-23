# The OpenMerit cloud app as a Rivet Cloud actor node. Build from the repository root, since the app
# imports openmerit-core's engine and ranking from source:
#   docker build -f cloud/Dockerfile .
FROM node:22.19.0-bookworm-slim
WORKDIR /app
COPY cloud/package.json cloud/package-lock.json cloud/
# The engine binary is only for tests and local development: a node connects to the cluster's engine.
RUN cd cloud && npm ci --omit=dev --ignore-scripts \
	&& rm -rf node_modules/@rivetkit/engine-cli* node_modules/@rivet-dev/agentos-* node_modules/@rivet-dev/agent-os-* node_modules/@agentos-software \
	&& npm cache clean --force
# openmerit-core's package.json says its .ts files are ES modules.
COPY openmerit-core/package.json openmerit-core/
COPY openmerit-core/src/engine openmerit-core/src/engine
COPY openmerit-core/src/ranking openmerit-core/src/ranking
COPY openmerit-core/src/eval/proxy.ts openmerit-core/src/eval/
COPY openmerit-core/src/catalogue openmerit-core/src/catalogue
COPY openmerit-core/src/connectors/agent-bundle.ts openmerit-core/src/connectors/
# openmerit-core's sources import their packages (ajv) from the nearest node_modules above them.
RUN ln -s cloud/node_modules node_modules
COPY openmerit-core/data/catalogue.json openmerit-core/data/
COPY cloud/src cloud/src
ENV NODE_ENV=production RIVET_LOG_LEVEL=warn
WORKDIR /app/cloud
USER node
CMD ["node", "src/server.ts"]
