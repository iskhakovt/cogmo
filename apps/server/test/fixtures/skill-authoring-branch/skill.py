async def run(inputs, ctx) -> dict:
    import urllib.request
    import json
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read().decode())
    return {"price": data["bitcoin"]["usd"]}
