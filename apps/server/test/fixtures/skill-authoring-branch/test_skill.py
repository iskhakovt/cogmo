import json
from unittest.mock import AsyncMock

import pytest

from cogmo_ctx import SkillError
from skill import Input, Output, run


@pytest.mark.asyncio
async def test_run_success():
    ctx = AsyncMock()
    mock_response = {
        "status": 200,
        "headers": {},
        "body": json.dumps({"bitcoin": {"usd": 42500.50}}),
    }
    ctx.http.get.return_value = mock_response

    result = await run(Input(), ctx)

    assert isinstance(result, Output)
    assert result.price == 42500.50
    ctx.http.get.assert_called_once_with("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")


@pytest.mark.asyncio
async def test_run_api_error():
    ctx = AsyncMock()
    mock_response = {"status": 500, "headers": {}, "body": "Internal Server Error"}
    ctx.http.get.return_value = mock_response

    with pytest.raises(SkillError) as exc_info:
        await run(Input(), ctx)

    assert exc_info.value.kind == "network"
    assert "500" in str(exc_info.value)
