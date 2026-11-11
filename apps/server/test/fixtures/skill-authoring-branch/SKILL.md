---
name: btc-spot
description: "Fetches the current Bitcoin spot price in USD from CoinGecko"
tier: wasm
effects: []
network:
  allow:
    - api.coingecko.com
---

Fetches the current Bitcoin spot price in USD using CoinGecko's free public API. This is a read-only operation that requires no authentication or secrets.
