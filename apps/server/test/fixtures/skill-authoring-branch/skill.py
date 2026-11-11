import json

from pydantic import BaseModel

from cogmo_ctx import Ctx, SkillError


class Output(BaseModel):
    price: float


async def run(inputs, ctx: Ctx) -> Output:
    result = await ctx.http.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")

    if result["status"] != 200:
        raise SkillError(
            "http_error",
            f"CoinGecko API returned status {result['status']}: {result['body']}",
        )

    try:
        data = json.loads(result["body"])
    except json.JSONDecodeError as e:
        raise SkillError("parse_error", f"Failed to parse CoinGecko response: {e}") from e

    try:
        price = data["bitcoin"]["usd"]
    except KeyError as e:
        raise SkillError(
            "missing_field",
            f"Response missing expected field: {e}",
        ) from e

    return Output(price=price)
