import json

from pydantic import BaseModel

from cogmo_ctx import Ctx, SkillError


class Input(BaseModel):
    pass


class Output(BaseModel):
    price: float


async def run(inputs: Input, ctx: Ctx) -> Output:
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    response = await ctx.http.get(url)

    if response["status"] != 200:
        raise SkillError("network", f"CoinGecko API returned {response['status']}")

    payload = json.loads(response["body"])
    price = payload["bitcoin"]["usd"]

    return Output(price=price)
