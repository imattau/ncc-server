SHELL := /bin/bash

.PHONY: install dev start dev-crawler status logs build-nsite publisher test

install:
	npm install

dev:
	npm run dev

dev-crawler:
	npm run dev:crawler

start:
	npm start

status:
	systemctl status ncc-search ncc-search-crawler --no-pager

logs:
	sudo journalctl -u ncc-search -u ncc-search-crawler -f

build-nsite:
	cd ui && npm run build:nsite

publisher:
	cd nsite-publisher && npm run dev

test:
	npm test
	cd ui && npm test
	cd nsite-publisher && npm test
