import json

from pydantic import BaseModel

from cogmo_ctx import Ctx


class Output(BaseModel):
    price: float


async def run(inputs, ctx: Ctx) -> Output:
    result = await ctx.http.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")
    data = json.loads(result["body"])
    price = data["bitcoin"]["usd"]
    return Output(price=price)
