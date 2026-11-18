---
name: btc-spot
description: "Fetches the current Bitcoin spot price in USD from CoinGecko"
tier: wasm
inputs:
  type: object
  properties: {}
effects: []
network:
  allow:
    - api.coingecko.com
---

Fetches the current Bitcoin spot price in USD from the CoinGecko free API.

This skill makes a single HTTP request to CoinGecko's `/simple/price` endpoint and extracts the USD price of Bitcoin. No input is required.
