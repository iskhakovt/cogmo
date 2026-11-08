# The wasm tier's half of `cogmo_ctx`: the `Bridge` over the worker's
# `MessagePort`, and `_cogmo_call_run` (`cogmo_ctx._run.call_run`), which
# the run stage awaits. `pyodide-worker.ts` runs this file in the Pyodide
# globals the skill body shares, once it has written `cogmo_ctx` into
# Pyodide's filesystem. The bridge stays out of `cogmo_ctx` because it
# imports `pyodide.ffi`, which only Pyodide has.

from cogmo_ctx import CtxError as _CogmoCtxError
from cogmo_ctx._run import call_run as _cogmo_call_run  # noqa: F401  (the run stage calls it)


class _CogmoBridge:
    """`cogmo_ctx.Bridge` over the host bridge the worker registers as `__cogmo_bridge__`."""

    def __init__(self, js_bridge):
        self._js = js_bridge

    async def call(self, method, args):
        from pyodide.ffi import jsnull

        # The worker converts `args` to a plain JS object itself: the `js`
        # module holds only timers, so Python has no `Object` to build one.
        # It answers { ok, value } or { ok, kind, message }.
        reply = (await self._js.call(method, args)).to_py()
        if not reply["ok"]:
            raise _CogmoCtxError(reply["kind"], reply["message"])
        value = reply.get("value")
        return None if value is jsnull else value
