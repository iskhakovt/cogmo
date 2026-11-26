/**
 * A `POST /containers/create` exactly as testcontainers-node 12.2.1 (over
 * dockerode 5.0.1 and docker-modem 5.0.7) sends it. Recorded by pointing
 * `DOCKER_HOST` at a Unix-socket server that logged each request and
 * answered `/info`, `/containers/json` and the image inspect, with
 * `TESTCONTAINERS_RYUK_DISABLED=true`, for the container
 * `dev/containers.ts`'s `postgres()` builds plus a name:
 *
 * ```ts
 * new GenericContainer("mirror.gcr.io/pgvector/pgvector:pg18")
 *   .withName("cogmo-capture-postgres")
 *   .withNetwork(network)
 *   .withNetworkAliases("postgres")
 *   .withExposedPorts(5432)
 *   .withEnvironment({ POSTGRES_USER: "cogmo", POSTGRES_DB: "cogmo", POSTGRES_HOST_AUTH_METHOD: "trust" })
 * ```
 *
 * docker-modem copies every create option into the query string as well as
 * the body, objects JSON-encoded and arrays as repeated keys. testcontainers
 * sends no API version prefix.
 */
export const TESTCONTAINERS_CREATE_REQUEST = {
  method: "POST",
  path:
    "/containers/create?Image=mirror.gcr.io%2Fpgvector%2Fpgvector%3Apg18&name=cogmo-capture-postgres" +
    "&ExposedPorts=%7B%225432%2Ftcp%22%3A%7B%7D%7D&Env=POSTGRES_USER%3Dcogmo&Env=POSTGRES_DB%3Dcogmo" +
    "&Env=POSTGRES_HOST_AUTH_METHOD%3Dtrust&Labels=%7B%22org.testcontainers%22%3A%22true%22%2C%22org." +
    "testcontainers.lang%22%3A%22node%22%2C%22org.testcontainers.version%22%3A%2212.2.1%22%2C%22org." +
    "testcontainers.session-id%22%3A%22a4baacb648e3%22%7D&HostConfig=%7B%22AutoRemove%22%3Afalse%2C%22" +
    "PortBindings%22%3A%7B%225432%2Ftcp%22%3A%5B%7B%22HostPort%22%3A%220%22%7D%5D%7D%7D",
  headers: { "user-agent": "tc-node/12.2.1", "content-type": "application/json" },
  body:
    '{"Image":"mirror.gcr.io/pgvector/pgvector:pg18","name":"cogmo-capture-postgres",' +
    '"ExposedPorts":{"5432/tcp":{}},"Env":["POSTGRES_USER=cogmo","POSTGRES_DB=cogmo",' +
    '"POSTGRES_HOST_AUTH_METHOD=trust"],"Labels":{"org.testcontainers":"true",' +
    '"org.testcontainers.lang":"node","org.testcontainers.version":"12.2.1",' +
    '"org.testcontainers.session-id":"a4baacb648e3"},"HostConfig":{"AutoRemove":false,' +
    '"PortBindings":{"5432/tcp":[{"HostPort":"0"}]}}}',
} as const;
