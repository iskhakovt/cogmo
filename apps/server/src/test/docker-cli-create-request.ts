/**
 * A `POST /containers/create` exactly as the Docker CLI 29.9.3 sends it, for
 * `docker create --name pg-test -e POSTGRES_PASSWORD=x -p 5432
 * postgres:18-alpine`. Recorded by pointing `DOCKER_HOST` at a Unix-socket
 * server that logged each request and answered `/_ping` with API 1.51.
 *
 * The CLI sends every field, most as zeros, and `Devices` and the five
 * `Blkio*` device lists as `[]`.
 */
export const DOCKER_CLI_CREATE_REQUEST = {
  method: "POST",
  path: "/v1.51/containers/create?name=pg-test",
  headers: { "user-agent": "Docker-Client/29.9.3 (linux)", "content-type": "application/json" },
  body:
    '{"Hostname":"","Domainname":"","User":"","AttachStdin":false,"AttachStdout":true,"AttachSt' +
    'derr":true,"ExposedPorts":{"5432/tcp":{}},"Tty":false,"OpenStdin":false,"StdinOnce":false,' +
    '"Env":["POSTGRES_PASSWORD=x"],"Cmd":null,"Image":"postgres:18-alpine","Volumes":{},"Workin' +
    'gDir":"","Entrypoint":null,"Labels":{},"HostConfig":{"Binds":null,"ContainerIDFile":"","Lo' +
    'gConfig":{"Type":"","Config":{}},"NetworkMode":"default","PortBindings":{"5432/tcp":[{"Hos' +
    'tIp":"","HostPort":""}]},"RestartPolicy":{"Name":"no","MaximumRetryCount":0},"AutoRemove":' +
    'false,"VolumeDriver":"","VolumesFrom":null,"ConsoleSize":[0,0],"CapAdd":null,"CapDrop":nul' +
    'l,"CgroupnsMode":"","Dns":null,"DnsOptions":[],"DnsSearch":[],"ExtraHosts":null,"GroupAdd"' +
    ':null,"IpcMode":"","Cgroup":"","Links":null,"OomScoreAdj":0,"PidMode":"","Privileged":fals' +
    'e,"PublishAllPorts":false,"ReadonlyRootfs":false,"SecurityOpt":null,"UTSMode":"","UsernsMo' +
    'de":"","ShmSize":0,"Isolation":"","CpuShares":0,"Memory":0,"NanoCpus":0,"CgroupParent":"",' +
    '"BlkioWeight":0,"BlkioWeightDevice":[],"BlkioDeviceReadBps":[],"BlkioDeviceWriteBps":[],"B' +
    'lkioDeviceReadIOps":[],"BlkioDeviceWriteIOps":[],"CpuPeriod":0,"CpuQuota":0,"CpuRealtimePe' +
    'riod":0,"CpuRealtimeRuntime":0,"CpusetCpus":"","CpusetMems":"","Devices":[],"DeviceCgroupR' +
    'ules":null,"DeviceRequests":null,"MemoryReservation":0,"MemorySwap":0,"MemorySwappiness":-' +
    '1,"OomKillDisable":false,"PidsLimit":0,"Ulimits":null,"CpuCount":0,"CpuPercent":0,"IOMaxim' +
    'umIOps":0,"IOMaximumBandwidth":0,"MaskedPaths":null,"ReadonlyPaths":null},"NetworkingConfi' +
    'g":{"EndpointsConfig":{"default":{"IPAMConfig":null,"Links":null,"Aliases":null,"DriverOpt' +
    's":null,"GwPriority":0,"NetworkID":"","EndpointID":"","Gateway":"","IPAddress":"","MacAddr' +
    'ess":"","IPPrefixLen":0,"IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"D' +
    'NSNames":null}}}}',
} as const;
