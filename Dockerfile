# syntax=docker/dockerfile:1.7
ARG BUILD_IMAGE=docker.io/library/node:24.13.0-bookworm-slim
FROM ${BUILD_IMAGE} AS build

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}
WORKDIR /workspace

RUN --mount=type=cache,target=/root/.npm \
    npm install --global @vscode/vsce@4.0.0 --no-audit --no-fund
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY --from=dsl pyproject.toml README.md /workspace/resources/sa-python-dsl/
COPY --from=dsl src/ /workspace/resources/sa-python-dsl/src/
RUN find resources/sa-python-dsl -type d -name __pycache__ -prune -exec rm -rf {} +
RUN mkdir -p /output \
    && npm run check \
    && npm run bundle \
    && vsce package --no-dependencies --out "/output/service-architect-vscode-$(node -p 'require("./package.json").version').vsix"

FROM scratch
COPY --from=build /output/ /
