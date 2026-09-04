.PHONY: public-audit release-audit typecheck lint test frontend-build backend-test verify

PIXI ?= ./scripts/pixi.sh

public-audit:
	$(PIXI) run node --test tests/public-release/public-release.test.mjs

release-audit:
	PUBLIC_RELEASE_AUDIT_MODE=release $(PIXI) run node --test tests/public-release/public-release.test.mjs

typecheck:
	$(PIXI) run npm run typecheck

lint:
	$(PIXI) run npm run lint

test:
	$(PIXI) run npm test

frontend-build:
	$(PIXI) run npm run build

backend-test:
	$(PIXI) run test-backend

verify: public-audit typecheck lint test frontend-build backend-test
