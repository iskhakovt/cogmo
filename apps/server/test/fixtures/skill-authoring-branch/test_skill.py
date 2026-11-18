import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from cogmo_ctx import SkillError
from skill import run, Input, Output


@pytest.mark.asyncio
async def test_btc_spot_success():
    """Test successful fetch of Bitcoin spot price."""
    inputs = Input()
    ctx = MagicMock()

    mock_response = {
        "status": 200,
        "headers": {},
        "body": json.dumps({"bitcoin": {"usd": 42500.50}}),
    }
    ctx.http.get = AsyncMock(return_value=mock_response)

    result = await run(inputs, ctx)

    assert isinstance(result, Output)
    assert result.price == 42500.50
    ctx.http.get.assert_called_once_with(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    )


@pytest.mark.asyncio
async def test_btc_spot_api_error():
    """Test handling of API error response."""
    inputs = Input()
    ctx = MagicMock()

    mock_response = {
        "status": 500,
        "headers": {},
        "body": "Internal Server Error",
    }
    ctx.http.get = AsyncMock(return_value=mock_response)

    with pytest.raises(SkillError) as exc_info:
        await run(inputs, ctx)

    assert exc_info.value.kind == "api_error"
    assert "500" in str(exc_info.value.message)


@pytest.mark.asyncio
async def test_btc_spot_invalid_json():
    """Test handling of invalid JSON response."""
    inputs = Input()
    ctx = MagicMock()

    mock_response = {
        "status": 200,
        "headers": {},
        "body": "invalid json",
    }
    ctx.http.get = AsyncMock(return_value=mock_response)

    with pytest.raises(SkillError) as exc_info:
        await run(inputs, ctx)

    assert exc_info.value.kind == "parse_error"


@pytest.mark.asyncio
async def test_btc_spot_missing_field():
    """Test handling of missing 'bitcoin' field in response."""
    inputs = Input()
    ctx = MagicMock()

    mock_response = {
        "status": 200,
        "headers": {},
        "body": json.dumps({"ethereum": {"usd": 2500.00}}),
    }
    ctx.http.get = AsyncMock(return_value=mock_response)

    with pytest.raises(SkillError) as exc_info:
        await run(inputs, ctx)

    assert exc_info.value.kind == "parse_error"
