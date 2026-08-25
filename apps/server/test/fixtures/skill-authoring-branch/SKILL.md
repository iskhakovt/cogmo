---
name: btc-spot
description: "Fetches the current Bitcoin price in USD from CoinGecko"
tier: wasm
inputs:
  type: object
  properties: {}
effects: []
network:
  allow:
    - api.coingecko.com
---

# Bitcoin Spot Price

Fetches the current Bitcoin price in USD from the CoinGecko public API.

## Output

Returns a dictionary with the current BTC/USD price:

```json
{
  "price": 42500.50
}
```

## API

Uses the CoinGecko simple price endpoint (public, no authentication required).
