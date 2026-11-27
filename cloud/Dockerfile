# The OpenMerit cloud app as a Rivet Cloud actor node. The server is openmerit-core/src/server, run from
# source with the openmerit-core modules it imports. Build from the repository root:
#   docker build -f cloud/Dockerfile .
FROM node:22.19.0-bookworm-slim
# git clones the GitHub repositories a project adds (src/server/github.ts), over HTTPS only. The reviewer's
# and harness's read-only grep and find tools run ripgrep and fd. Debian's fd (8.6) lacks --no-require-git, which Pi's
# find passes, so fd is the pinned upstream release, checked against its SHA-256; curl leaves with the layer.
ARG FD_VERSION=10.3.0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl \
	&& case "$(dpkg --print-architecture)" in \
		amd64) target=x86_64-unknown-linux-musl sum=2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14 ;; \
		arm64) target=aarch64-unknown-linux-musl sum=996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b ;; \
		*) echo "no fd release for this architecture" >&2; exit 1 ;; esac \
	&& curl -fsSL -o /tmp/fd.tar.gz "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${target}.tar.gz" \
	&& echo "${sum}  /tmp/fd.tar.gz" | sha256sum -c - \
	&& tar -xzf /tmp/fd.tar.gz -C /usr/local/bin --strip-components=1 "fd-v${FD_VERSION}-${target}/fd" \
	&& rm /tmp/fd.tar.gz && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# Pi runs rg and fd from its agent directory's bin before PATH, and passes them the whole environment. These
# wrappers start them with PATH alone, so no secret of the app reaches a search over a customer's code.
RUN mkdir -p /opt/pi-agent/bin \
	&& printf '#!/bin/sh\nexec env -i PATH=/usr/bin:/bin /usr/bin/rg "$@"\n' > /opt/pi-agent/bin/rg \
	&& printf '#!/bin/sh\nexec env -i PATH=/usr/bin:/bin /usr/local/bin/fd "$@"\n' > /opt/pi-agent/bin/fd \
	&& chmod 755 /opt/pi-agent/bin/rg /opt/pi-agent/bin/fd
WORKDIR /app
# The server's packages are openmerit-core's.
COPY openmerit-core/package.json openmerit-core/package-lock.json openmerit-core/
# The engine binary is only for tests, local development and self-hosting: a node connects to the cluster's engine.
RUN cd openmerit-core && npm ci --omit=dev --ignore-scripts \
	&& rm -rf node_modules/@rivetkit/engine-cli* node_modules/@rivet-dev/agentos-* node_modules/@rivet-dev/agent-os-* node_modules/@agentos-software \
	&& npm cache clean --force
COPY openmerit-core/src/engine openmerit-core/src/engine
COPY openmerit-core/src/ranking openmerit-core/src/ranking
COPY openmerit-core/src/eval/proxy.ts openmerit-core/src/eval/loop.ts openmerit-core/src/eval/generated.ts openmerit-core/src/eval/runner.ts openmerit-core/src/eval/
COPY openmerit-core/src/catalogue openmerit-core/src/catalogue
COPY openmerit-core/src/connectors/agent-bundle.ts openmerit-core/src/connectors/eval-command.ts openmerit-core/src/connectors/
COPY openmerit-core/src/job openmerit-core/src/job
COPY openmerit-core/src/harness openmerit-core/src/harness
COPY openmerit-core/src/review openmerit-core/src/review
COPY openmerit-core/src/state/config.ts openmerit-core/src/state/paths.ts openmerit-core/src/state/
COPY openmerit-core/data/catalogue.json openmerit-core/data/eci-estimates.csv openmerit-core/data/
COPY openmerit-core/src/server openmerit-core/src/server
# PI_OFFLINE: a missing rg or fd fails the review's search instead of Pi downloading one at run time.
# PI_CODING_AGENT_DIR must be set before the app starts: Pi fixes its bin directory when it loads.
ENV NODE_ENV=production RIVET_LOG_LEVEL=warn PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_CODING_AGENT_DIR=/opt/pi-agent
WORKDIR /app/openmerit-core/src/server
USER node
CMD ["node", "server.ts"]
