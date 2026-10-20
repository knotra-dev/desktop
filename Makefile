.DEFAULT_GOAL := help

.PHONY: help install dev desktop build desktop-build lint format test check native-check e2e e2e-install

help:
	@printf '%s\n' \
	  'make install        Install pinned dependencies' \
	  'make dev            Start browser preview at http://127.0.0.1:1420' \
	  'make desktop        Start the native desktop app' \
	  'make lint           Lint frontend code with Biome' \
	  'make format         Format frontend code and Rust' \
	  'make test           Run frontend unit tests' \
	  'make build          Build the frontend' \
	  'make desktop-build  Build the native app and platform bundles' \
	  'make check          Check frontend style, contracts, tests and build' \
	  'make native-check   Check Rust formatting and tests' \
	  'make e2e-install    Install Chromium for browser tests' \
	  'make e2e            Run browser tests'

install:
	bun install --frozen-lockfile

dev:
	bun run dev

desktop:
	bun run desktop:dev

build:
	bun run build

desktop-build:
	bun run desktop:build

lint:
	bun run lint --error-on-warnings

format:
	bun run format
	cargo fmt --manifest-path src-tauri/Cargo.toml

test:
	bun run test

check:
	bun run check
	python3 -m unittest discover -s scripts -v
	bun run test
	bun run build

native-check:
	cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
	cargo test --locked --manifest-path src-tauri/Cargo.toml

e2e-install:
	bunx playwright install chromium

e2e:
	bun run test:e2e
