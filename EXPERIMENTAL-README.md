# EXPERIMENTAL COPY — DO NOT DEPLOY

This is a sandboxed duplicate of `anon-chat-remake` for integrating the
ported profanity-filter library. Rules:

- NEVER install as a systemd service. `bin/ensure-running.sh` refuses.
- NEVER run with the real Discord token. `.env` was removed; there is no `.env`.
- Tests only: `node tests/remake.mjs`, with an isolated temp DATA_DIR.
- The live bot lives at `~/workspace/anon-chat-remake` and is untouched.
