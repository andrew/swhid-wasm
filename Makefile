.PHONY: build serve test

build:
	bash scripts/build.sh

serve: build
	./build/server

test: build
	go test -race ./...
	node --test scripts/*.test.mjs
