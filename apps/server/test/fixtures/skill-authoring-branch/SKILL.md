---
name: btc-spot
description: "Fetches the current Bitcoin spot price in USD from CoinGecko"
tier: wasm
effects: []
network:
  allow:
    - api.coingecko.com
---

Fetches the current Bitcoin spot price in USD using the CoinGecko public API.

Returns the price as a float value in USD.
