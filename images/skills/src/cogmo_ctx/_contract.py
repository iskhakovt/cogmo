# Generated from apps/server/src/skills/ctx-contract.ts by `pnpm --filter cogmo codegen:ctx`. Do not edit.
"""The ctx surface's result types, refusal kinds and bridge, from Cogmo's contract."""

from collections.abc import Mapping
from typing import Any, Literal, Protocol, TypedDict, overload

type CtxErrorKind = Literal[
    "unknown_method",
    "invalid_args",
    "not_in_allowlist",
    "secret_not_found",
    "missing_effect",
    "read_failed",
    "write_failed",
    "list_failed",
    "blocked_destination",
    "timeout",
    "network_error",
    "response_too_large",
    "internal",
]


class Memory(TypedDict):
    content: str
    type: str


class MemoryRecall(TypedDict):
    memories: list[Memory]


class FileEntry(TypedDict):
    path: str
    size: int
    last_modified: str


class FileList(TypedDict):
    entries: list[FileEntry]


class User(TypedDict):
    id: str
    timezone: str


class HttpResponse(TypedDict):
    status: int
    headers: dict[str, str]
    body: str


class Bridge(Protocol):
    """The tier's channel to the host: a ctx call's value, or `CtxError` when the host refuses it."""

    @overload
    async def call(self, method: Literal["secrets.get"], args: Mapping[str, object]) -> str: ...

    @overload
    async def call(self, method: Literal["memory.recall"], args: Mapping[str, object]) -> MemoryRecall: ...

    @overload
    async def call(self, method: Literal["memory.remember"], args: Mapping[str, object]) -> None: ...

    @overload
    async def call(self, method: Literal["files.read"], args: Mapping[str, object]) -> str: ...

    @overload
    async def call(self, method: Literal["files.write"], args: Mapping[str, object]) -> None: ...

    @overload
    async def call(self, method: Literal["files.list"], args: Mapping[str, object]) -> FileList: ...

    @overload
    async def call(self, method: Literal["now"], args: Mapping[str, object]) -> str: ...

    @overload
    async def call(self, method: Literal["user"], args: Mapping[str, object]) -> User: ...

    @overload
    async def call(self, method: Literal["log.info"], args: Mapping[str, object]) -> None: ...

    @overload
    async def call(self, method: Literal["http.request"], args: Mapping[str, object]) -> HttpResponse: ...

    async def call(self, method: str, args: Mapping[str, object]) -> Any: ...
