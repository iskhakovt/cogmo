import json
from unittest.mock import AsyncMock

import pytest

from skill import Output, run


@pytest.mark.asyncio
async def test_btc_spot_success():
    """Test successful Bitcoin price fetch."""
    mock_ctx = AsyncMock()
    mock_ctx.http.get.return_value = {
        "status": 200,
        "headers": {},
        "body": json.dumps({"bitcoin": {"usd": 42500.50}}),
    }

    result = await run({}, mock_ctx)

    assert isinstance(result, Output)
    assert result.price == 42500.50
    mock_ctx.http.get.assert_called_once_with(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    )


@pytest.mark.asyncio
async def test_btc_spot_malformed_json():
    """Test failure when API response is malformed."""
    mock_ctx = AsyncMock()
    mock_ctx.http.get.return_value = {
        "status": 200,
        "headers": {},
        "body": "invalid json",
    }

    with pytest.raises(json.JSONDecodeError):
        await run({}, mock_ctx)
