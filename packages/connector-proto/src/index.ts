/**
 * The connector contract (`proto/cogmo/connector/v1/connector.proto`) as
 * protobuf-es types and the `ConnectorService` descriptor. `pnpm generate`
 * rewrites `gen/` from the `.proto`; CI fails when the two drift.
 */
export * from "./gen/cogmo/connector/v1/connector_pb.js";
