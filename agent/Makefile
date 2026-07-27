BIN := nstatus-metrics
BIN_DIR := bin
CARGO ?= cargo
RELEASE := --release

.PHONY: build build-all build-linux check fmt clean

build:
	$(CARGO) build $(RELEASE)

check:
	$(CARGO) fmt -- --check
	$(CARGO) check

build-all: build-linux

build-linux:
	@set -e; mkdir -p $(BIN_DIR); \
	for item in \
	  "x86_64-unknown-linux-musl nstatus-metrics-linux-amd64" \
	  "aarch64-unknown-linux-musl nstatus-metrics-linux-arm64" \
	  "armv7-unknown-linux-musleabihf nstatus-metrics-linux-arm" \
	  "arm-unknown-linux-musleabi nstatus-metrics-linux-armv6" \
	  "i686-unknown-linux-musl nstatus-metrics-linux-386"; do \
	    set -- $$item; \
	    $(CARGO) build $(RELEASE) --target $$1; \
	    cp target/$$1/release/$(BIN) $(BIN_DIR)/$$2; \
	done

clean:
	$(CARGO) clean
	rm -f $(BIN_DIR)/nstatus-metrics-*
