SHELL := /bin/bash

.PHONY: install dev start dev-crawler status logs

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
