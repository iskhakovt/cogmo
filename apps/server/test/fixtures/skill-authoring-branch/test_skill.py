import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from skill import Output, run


@pytest.mark.asyncio
async def test_run_success():
    ctx = MagicMock()
    ctx.http.get = AsyncMock(
        return_value={
            "status": 200,
            "headers": {},
            "body": json.dumps({"bitcoin": {"usd": 42500.50}}),
        }
    )

    result = await run(None, ctx)

    assert isinstance(result, Output)
    assert result.price == 42500.50
    ctx.http.get.assert_called_once_with("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")


@pytest.mark.asyncio
async def test_run_http_error():
    from cogmo_ctx import SkillError

    ctx = MagicMock()
    ctx.http.get = AsyncMock(
        return_value={
            "status": 500,
            "headers": {},
            "body": "Internal Server Error",
        }
    )

    with pytest.raises(SkillError) as exc_info:
        await run(None, ctx)

    assert exc_info.value.kind == "http_error"


@pytest.mark.asyncio
async def test_run_parse_error():
    from cogmo_ctx import SkillError

    ctx = MagicMock()
    ctx.http.get = AsyncMock(
        return_value={
            "status": 200,
            "headers": {},
            "body": "not valid json",
        }
    )

    with pytest.raises(SkillError) as exc_info:
        await run(None, ctx)

    assert exc_info.value.kind == "parse_error"


@pytest.mark.asyncio
async def test_run_missing_field():
    from cogmo_ctx import SkillError

    ctx = MagicMock()
    ctx.http.get = AsyncMock(
        return_value={
            "status": 200,
            "headers": {},
            "body": json.dumps({"bitcoin": {}}),
        }
    )

    with pytest.raises(SkillError) as exc_info:
        await run(None, ctx)

    assert exc_info.value.kind == "missing_field"
