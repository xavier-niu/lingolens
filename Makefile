# LingoLens developer shortcuts. Run `make demo`, then open http://localhost:8080
# (or http://<this machine's IP>:8080 from a phone on the same network).

GO ?= $(shell command -v go 2>/dev/null || echo /usr/local/go/bin/go)

DEMO_ADDR     ?= 0.0.0.0:8080
DEMO_DATA     ?= /tmp/lingolens-demo
DEMO_EMAIL    ?= demo@admin.com
DEMO_PASSWORD ?= admin

.PHONY: demo demo-reset test e2e e2e-docker e2e-bin

# Playwright's image; keep the version in step with e2e/package.json.
E2E_IMAGE ?= mcr.microsoft.com/playwright:v1.64.1-noble
# Run only some browser suites, e.g. make e2e SUITES="shelf offline".
SUITES    ?=
# Rootful Docker: run as you, so e2e/ stays yours. Rootless Docker already maps
# the container's root to you (and --user would break writes to the mount).
DOCKER_USER = $(shell docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless || echo "--user $$(id -u):$$(id -g)")

# A demo server with the Fake model enabled (no API key needed; pick a real
# provider in Settings for actual glosses). The demo admin is created on the
# first run only, while the data directory has no accounts: `make demo-reset`
# starts over. For local demos only: the password is short and the Fake model
# is on.
demo:
	LINGOLENS_DEV_FAKE=1 \
	LINGOLENS_ADMIN_EMAIL='$(DEMO_EMAIL)' \
	LINGOLENS_ADMIN_PASSWORD='$(DEMO_PASSWORD)' \
	$(GO) run ./cmd/lingolens -addr $(DEMO_ADDR) -data $(DEMO_DATA)

# Delete the demo data (texts, accounts, keys) so the next `make demo` starts fresh.
demo-reset:
	rm -rf $(DEMO_DATA)

# Go unit and integration tests (the same as CI's "test" job).
test:
	$(GO) vet ./...
	$(GO) test ./...

# Browser tests (e2e/): build the server, then run every suite against a fresh
# instance with the Fake model. Needs Node 20+; on a new Linux machine also run
# `cd e2e && npx playwright install-deps chromium` once (needs sudo).
e2e: e2e-bin
	cd e2e && npm ci --no-audit --no-fund && npx playwright install chromium && node run.mjs $(SUITES)

# The same inside Playwright's Docker image: no local Node or browsers needed.
e2e-docker: e2e-bin
	docker run --rm --ipc=host $(DOCKER_USER) -e HOME=/tmp \
		-v "$(CURDIR):/src" -w /src/e2e $(E2E_IMAGE) \
		sh -c 'npm ci --no-audit --no-fund && node run.mjs $(SUITES)'

# A static binary, so it also runs inside the Playwright image.
e2e-bin:
	CGO_ENABLED=0 $(GO) build -o e2e/.bin/lingolens ./cmd/lingolens
