/**
 * The connector contract (`proto/cogmo/connector/v1/`: `session.proto` and
 * `coding.proto`) as protobuf-es types and the `ConnectorService` descriptor.
 * `pnpm generate` rewrites `gen/` from the `.proto` files; CI fails when the
 * two drift.
 */
export * from "./gen/cogmo/connector/v1/coding_pb.js";
export * from "./gen/cogmo/connector/v1/session_pb.js";
