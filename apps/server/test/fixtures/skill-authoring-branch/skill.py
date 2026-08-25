import json


async def run(inputs, ctx) -> dict:
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    resp = await ctx.http.get(url)

    if resp["status"] != 200:
        raise RuntimeError(f"CoinGecko API returned status {resp['status']}")

    try:
        data = json.loads(resp["body"])
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Failed to parse CoinGecko response: {e}")

    try:
        price = data["bitcoin"]["usd"]
    except (KeyError, TypeError) as e:
        raise RuntimeError(f"Unexpected response structure from CoinGecko: {e}")

    return {"price": price}
