SHELL := /bin/bash

.PHONY: install dev start status logs

install:
	npm install

dev:
	npm run dev

start:
	npm start

status:
	systemctl status ncc-search --no-pager

logs:
	sudo journalctl -u ncc-search -f
