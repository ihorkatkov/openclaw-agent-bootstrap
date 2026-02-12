SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE ?= docker compose
GATEWAY_SERVICE ?= gateway
CLI_SERVICE ?= cli

ifneq (,$(wildcard .env))
include .env
export
endif

OPENCLAW_IMAGE ?= openclaw:local
OPENCLAW_GATEWAY_PORT ?= 18789

.PHONY: help setup start stop restart logs status doctor shell cli onboard clean

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "%-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Run interactive setup
	./setup.sh

start: ## Start the agent
	$(COMPOSE) up -d $(GATEWAY_SERVICE)

stop: ## Stop the agent
	$(COMPOSE) down

restart: ## Restart the agent
	$(COMPOSE) restart $(GATEWAY_SERVICE)

logs: ## Follow gateway logs
	$(COMPOSE) logs -f $(GATEWAY_SERVICE)

status: ## Show container and model status
	@$(COMPOSE) ps
	@if [ -n "$$( $(COMPOSE) ps --status running -q $(GATEWAY_SERVICE) )" ]; then \
		$(COMPOSE) exec -T $(GATEWAY_SERVICE) node dist/index.js models status || true; \
	else \
		printf 'Gateway is not running. Run `make start`.\n'; \
	fi

doctor: ## Validate prerequisites and setup state
	@printf 'Checking docker command...\n'
	@command -v docker >/dev/null 2>&1 || { printf 'docker is not installed\n' >&2; exit 1; }
	@printf 'Checking docker compose...\n'
	@$(COMPOSE) version >/dev/null 2>&1 || { printf 'docker compose v2 is required\n' >&2; exit 1; }
	@printf 'Checking docker daemon...\n'
	@docker info >/dev/null 2>&1 || { printf 'Docker daemon is not reachable. Start Docker and retry.\n' >&2; exit 1; }
	@printf 'Checking .env file...\n'
	@test -f .env || { printf '.env not found. Run ./setup.sh first.\n' >&2; exit 1; }
	@printf 'Checking image %s...\n' "$(OPENCLAW_IMAGE)"
	@docker image inspect "$(OPENCLAW_IMAGE)" >/dev/null 2>&1 || { printf 'Docker image not found: %s\n' "$(OPENCLAW_IMAGE)" >&2; exit 1; }
	@printf 'Checking config directory...\n'
	@test -d .openclaw || { printf 'Missing .openclaw directory. Run ./setup.sh.\n' >&2; exit 1; }
	@printf 'Checking port %s availability...\n' "$(OPENCLAW_GATEWAY_PORT)"
	@if command -v lsof >/dev/null 2>&1; then \
		if lsof -nP -iTCP:$(OPENCLAW_GATEWAY_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			if [ -n "$$( $(COMPOSE) ps --status running -q $(GATEWAY_SERVICE) )" ]; then \
				printf 'Port %s is in use by running gateway (ok).\n' "$(OPENCLAW_GATEWAY_PORT)"; \
			else \
				printf 'Port %s is already in use. Update OPENCLAW_GATEWAY_PORT in .env.\n' "$(OPENCLAW_GATEWAY_PORT)" >&2; \
				exit 1; \
			fi; \
		fi; \
	else \
		printf 'lsof not installed; skipping port check.\n'; \
	fi
	@printf 'Doctor checks passed.\n'

shell: ## Open shell in gateway container
	$(COMPOSE) exec $(GATEWAY_SERVICE) sh

cli: ## Run openclaw CLI command (usage: make cli CMD="models status")
	@test -n "$(CMD)" || { printf 'Usage: make cli CMD="models status"\n' >&2; exit 1; }
	$(COMPOSE) --profile cli run --rm $(CLI_SERVICE) $(CMD)

onboard: ## Re-run onboarding wizard
	$(COMPOSE) --profile cli run --rm $(CLI_SERVICE) onboard

clean: ## Remove containers and volumes
	$(COMPOSE) down -v
