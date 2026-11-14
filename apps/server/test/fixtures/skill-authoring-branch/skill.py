import json
from pydantic import BaseModel
from cogmo_ctx import Ctx, SkillError


class Input(BaseModel):
    pass


class Output(BaseModel):
    price: float


async def run(inputs: Input, ctx: Ctx) -> Output:
    response = await ctx.http.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    )

    if response["status"] != 200:
        raise SkillError(
            "api_error",
            f"CoinGecko API returned status {response['status']}",
            retryable=response["status"] >= 500,
        )

    try:
        data = json.loads(response["body"])
        price = data["bitcoin"]["usd"]
    except (json.JSONDecodeError, KeyError) as e:
        raise SkillError(
            "parse_error", f"Failed to parse CoinGecko response: {e}"
        ) from e

    return Output(price=price)
