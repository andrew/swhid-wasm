.PHONY: build serve test

build:
	bash scripts/build.sh

serve: build
	./build/server

test: build
	go test -race ./...
	cd deps/archives && go test ./...
	cd deps/swhid-go && go test ./objects
	node --test scripts/*.test.mjs
