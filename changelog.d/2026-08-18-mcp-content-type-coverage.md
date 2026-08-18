The MCP streamable-HTTP content-type contract is now exercised, so the next time the SDK moves it we find out.

@modelcontextprotocol/sdk 1.30 tightened response matching from a substring test to exact media-type equality. Three of the six shapes worth caring about change answer between the two: `Application/JSON` becomes accepted because essence extraction lowercases, while `application/json-rpc` and a pair of joined duplicate headers become rejected. A remote server sending any of those behaves differently than it did on 1.29, and nothing in `src/mcp/` touched content-type at all.

The tightening is correct per spec and deliberately not worked around — rewriting a third party's header would hide a bug in their server rather than fix it. What was missing is a test that notices.

Six cases drive a real `StreamableHTTPClientTransport` against a loopback server that answers with each header, so the SDK's own matcher decides the outcome rather than a restatement of it, and the assertions are what a caller sees: the send resolves, or it throws naming the type. That fits the unit tier — a `node:http` server on 127.0.0.1 needs none of the containers the integration tier stands up.
