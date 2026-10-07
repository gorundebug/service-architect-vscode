DEPENDENCY_DOCKER_REGISTRY ?= docker.io
NPM_CONFIG_REGISTRY ?= https://registry.npmjs.org/
SA_DSL_SOURCE ?= ../sa-python-dsl

.PHONY: docker-build
docker-build:
	docker build \
		--build-arg BUILD_IMAGE=$(DEPENDENCY_DOCKER_REGISTRY)/library/node:24.13.0-bookworm-slim \
		--build-arg NPM_CONFIG_REGISTRY=$(NPM_CONFIG_REGISTRY) \
		--build-context "dsl=$(SA_DSL_SOURCE)" \
		--output type=local,dest=dist .
