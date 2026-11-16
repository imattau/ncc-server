SHELL := /bin/bash

.PHONY: install install-compose-host first-run-identity bundle-provision-services bundle-reconcile-public-ip uninstall status logs verify check-nat smoke build-test-app deploy-test-app bundle-deploy-test-app init-test-identity publish-test-locator enable-tls disable-tls enable-tor enable-relay-proxy disable-relay-proxy provision-ditto-relay install-ditto-relay test-ditto-wss stage-npanel bundle-config bundle-build bundle-up bundle-down bundle-logs bundle-health bundle-configure-npanel bundle-configure-ditto-web

install:
	sudo ./scripts/install.sh

install-compose-host:
	sudo ./scripts/install-compose-host.sh

first-run-identity:
	node ./test-app/scripts/first-run-identity.mjs $(NCC_SETUP_ARGS)

bundle-provision-services:
	sudo ./scripts/provision-compose-services.py

bundle-reconcile-public-ip:
	sudo ./scripts/reconcile-public-ip.py

uninstall:
	sudo ./scripts/uninstall.sh

status:
	systemctl status caddy ncc-sidecar --no-pager

logs:
	sudo journalctl -u caddy -u ncc-sidecar -f

verify:
	@test -n "$(NPUB)" || (echo 'Usage: make verify NPUB=npub1... [SERVICE=web] [RELAYS="wss://..."]' >&2; exit 2)
	./scripts/verify-locator.sh "$(NPUB)" "$(or $(SERVICE),web)" $(RELAYS)

check-nat:
	./scripts/check-nat.sh $(WAN_IP)

smoke:
	./tests/smoke.sh

build-test-app:
	npm --prefix test-app run build

deploy-test-app:
	sudo rsync -a --chown=root:caddy public/ /srv/ncc-server/public/

bundle-deploy-test-app:
	@test -n "$(TARGET)" || (echo 'Usage: make bundle-deploy-test-app TARGET=user@host' >&2; exit 2)
	./scripts/deploy-compose-test-app.sh "$(TARGET)"

init-test-identity:
	node test-app/scripts/initialize-test-identity.mjs

publish-test-locator:
	node scripts/publish-test-locator.mjs

enable-tls:
	@test -n "$(SERVICE_RECORD_ID)" || (echo 'Usage: sudo make enable-tls SERVICE_RECORD_ID=<numeric-sidecar-service-id>' >&2; exit 2)
	sudo ./scripts/enable-tls.sh "$(SERVICE_RECORD_ID)"

disable-tls:
	sudo ./scripts/disable-tls.sh

enable-tor:
	@test -n "$(SERVICE_RECORD_ID)" || (echo 'Usage: sudo make enable-tor SERVICE_RECORD_ID=<numeric-sidecar-service-id> [TOR_TARGET_PORT=8080]' >&2; exit 2)
	sudo ./scripts/enable-tor.sh "$(SERVICE_RECORD_ID)" "$(or $(TOR_TARGET_PORT),8080)"

enable-relay-proxy:
	@test -n "$(SERVICE_RECORD_ID)" || (echo 'Usage: sudo make enable-relay-proxy SERVICE_RECORD_ID=<numeric-sidecar-service-id>' >&2; exit 2)
	sudo ./scripts/enable-relay-proxy.sh "$(SERVICE_RECORD_ID)"

disable-relay-proxy:
	sudo ./scripts/disable-relay-proxy.sh

provision-ditto-relay:
	@test -n "$(RELAY_URL)" || (echo 'Usage: sudo make provision-ditto-relay RELAY_URL=wss://<public-address>:8444/' >&2; exit 2)
	sudo ./scripts/provision-ditto-relay.py "$(RELAY_URL)"

install-ditto-relay:
	sudo ./scripts/install-ditto-relay.sh

test-ditto-wss:
	@test -n "$(RELAY_URL)" || (echo 'Usage: make test-ditto-wss RELAY_URL=wss://<public-address>:8443/relay/' >&2; exit 2)
	NODE_TLS_REJECT_UNAUTHORIZED=0 node ./scripts/test-ditto-wss.mjs "$(RELAY_URL)"

stage-npanel:
	@test -n "$(NPANEL_BINARY)" || (echo 'Usage: make stage-npanel NPANEL_BINARY=/path/to/static-npanel-binary' >&2; exit 2)
	./scripts/stage-npanel-binary.sh "$(NPANEL_BINARY)"

bundle-config:
	docker-compose -p ncc-bundle -f compose.yaml config

bundle-build:
	DOCKER_BUILDKIT=1 docker-compose -p ncc-bundle -f compose.yaml build

bundle-configure-npanel:
	@set -a; . ./.env; set +a; /opt/ncc-sidecar/.node/bin/node ./scripts/configure-npanel-host.mjs

bundle-configure-ditto-web:
	@set -a; . ./.env; set +a; /opt/ncc-sidecar/.node/bin/node ./scripts/configure-ditto-web.mjs

bundle-up: bundle-configure-npanel bundle-configure-ditto-web bundle-config
	docker-compose -p ncc-bundle -f compose.yaml up -d

bundle-down:
	docker-compose -p ncc-bundle -f compose.yaml down

bundle-logs:
	docker-compose -p ncc-bundle -f compose.yaml logs -f --tail=100

bundle-health:
	./scripts/check-container-stack.sh

