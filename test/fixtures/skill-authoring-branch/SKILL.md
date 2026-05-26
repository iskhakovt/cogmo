---
name: btc-spot
description: "Fetches the current Bitcoin price in USD from CoinGecko and returns { price: <number> }."
tier: wasm
inputs:
  type: object
  properties: {}
effects: []
---

Fetches the current spot price of Bitcoin in USD from the CoinGecko public API.

Returns a dictionary with a single key `price` containing the current BTC/USD exchange rate as a number.
