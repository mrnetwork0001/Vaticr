# Vendored: `@dreamdex-bot-kit/ec-core`

This directory is an **unmodified verbatim copy** of `packages/ec-core` from the
official **dreamDEX Bot Kit**:

- Upstream: <https://github.com/somnia-chain/dreamdex-bot-kit>
- Path: `packages/ec-core`
- License: MIT — Copyright (c) 2026 DreamDEX S.A. (see `LICENSE`)

## Why it is vendored rather than installed

`@dreamdex-bot-kit/ec-core` is a **private workspace package** inside the Bot Kit
monorepo. It is not published to npm, and npm cannot install a single workspace
package out of a monorepo subdirectory. Vendoring it is the only way to keep
Vaticr's promise of a deterministic `npm install && npm run bot:start` on a clean
clone.

Every source file retains its original DreamDEX copyright header. Vaticr adds no
lines to any file here — all Vaticr code lives in `bot/` and imports this package
through the workspace alias `@dreamdex-bot-kit/ec-core`, exactly as an in-repo
Bot Kit strategy does.

## Refreshing

```bash
git clone --depth 1 https://github.com/somnia-chain/dreamdex-bot-kit /tmp/botkit
cp /tmp/botkit/packages/ec-core/src/*.ts vendor/ec-core/src/
```
