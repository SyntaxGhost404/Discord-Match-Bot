#!/bin/bash
echo "REFUSED: this is the experimental copy. It must never be installed as a service." >&2
echo "Run tests only: node tests/remake.mjs" >&2
exit 1
