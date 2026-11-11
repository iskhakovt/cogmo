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

Fetches the current Bitcoin spot price in USD by querying the CoinGecko public API.

## Use cases
- Get the latest BTC/USD exchange rate
- Real-time price monitoring and tracking
- Price data for reports or notifications

## Response
Returns an object containing the current Bitcoin price in USD as a floating-point number.
