#!/usr/bin/env bash

# Build configuration for boundary node VMs based on subnet.json and transform it into removable media.

# Build Requirements:
# - Operating System: Ubuntu 20.04
# - Packages: coreutils, jq, mtools, tar, util-linux, wget, rclone

set -o errexit
set -o pipefail

BASE_DIR="$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT=$(git rev-parse --show-toplevel)

# Set argument defaults
DEBUG=0

# Get keyword arguments
for argument in "${@}"; do
    case ${argument} in
        -h | --help)
            echo 'Usage:

Removable Media Builder for Boundary Node VMs

Arguments:
  -h,  --help                 show this help message and exit
  -i=, --input=               JSON formatted input file (Default: ./subnet.json)
  -o=, --output=              removable media output directory (Default: ./build-out/)
  -s=, --ssh=                 specify directory holding SSH authorized_key files (Default: ../../testnet/config/ssh_authorized_keys)
       --git-revision=        git revision for which to prepare the media
  -x,  --debug                enable verbose console output
'
            exit 1
            ;;
        -i=* | --input=*)
            INPUT="${argument#*=}"
            shift
            ;;
        -o=* | --output=*)
            OUTPUT="${argument#*=}"
            shift
            ;;
        -s=* | --ssh=*)
            SSH="${argument#*=}"
            shift
            ;;
        --git-revision=*)
            GIT_REVISION="${argument#*=}"
            shift
            ;;
        -x | --debug)
            DEBUG=1
            ;;
        *)
            echo 'Error: Argument is not supported.'
            exit 1
            ;;
    esac
done

# Set arguments if undefined
INPUT="${INPUT:=${BASE_DIR}/subnet.json}"
OUTPUT="${OUTPUT:=${BASE_DIR}/build-out}"
SSH="${SSH:=${BASE_DIR}/../../testnet/config/ssh_authorized_keys}"
GIT_REVISION="${GIT_REVISION:=}"

if [[ -z "$GIT_REVISION" ]]; then
    echo "Please provide the GIT_REVISION as env. variable or the command line with --git-revision=<value>"
    exit 1
fi

# Load INPUT
CONFIG="$(cat ${INPUT})"

# Read all the top-level values out in one swoop
VALUES=$(echo ${CONFIG} | jq -r -c '[
    .deployment,
    (.name_servers | join(" ")),
    (.name_servers_fallback | join(" ")),
    (.journalbeat_hosts | join(" ")),
    (.journalbeat_tags | join(" "))
] | join("\u0001")')
IFS=$'\1' read -r DEPLOYMENT NAME_SERVERS NAME_SERVERS_FALLBACK JOURNALBEAT_HOSTS JOURNALBEAT_TAGS < <(echo $VALUES)

# Read all the node info out in one swoop
NODES=0
VALUES=$(echo ${CONFIG} \
    | jq -r -c '.datacenters[]
| .aux_nodes[] += { "type": "aux" } | .boundary_nodes[] += {"type": "boundary"} | .nodes[] += { "type": "replica" }
| [.aux_nodes[], .boundary_nodes[], .nodes[]][] + { "ipv6_prefix": .ipv6_prefix, "ipv6_subnet": .ipv6_subnet } | [
    .ipv6_prefix,
    .ipv6_subnet,
    .ipv6_address,
    .hostname,
    .subnet_type,
    .subnet_idx,
    .node_idx,
    .use_hsm,
    .type
] | join("\u0001")')
while IFS=$'\1' read -r ipv6_prefix ipv6_subnet ipv6_address hostname subnet_type subnet_idx node_idx use_hsm type; do
    eval "declare -A __RAW_NODE_$NODES=(
        ['ipv6_prefix']=$ipv6_prefix
        ['ipv6_subnet']=$ipv6_subnet
        ['ipv6_address']=$ipv6_address
        ['subnet_type']=$subnet_type
        ['hostname']=$hostname
        ['subnet_idx']=$subnet_idx
        ['node_idx']=$node_idx
        ['use_hsm']=$use_hsm
        ['type']=$type
    )"
    NODES=$((NODES + 1))
done < <(printf "%s\n" "${VALUES[@]}")
NODES=${!__RAW_NODE_@}

function prepare_build_directories() {
    TEMPDIR=$(mktemp -d /tmp/build-deployment.sh.XXXXXXXXXX)

    IC_PREP_DIR="$TEMPDIR/IC_PREP"
    CONFIG_DIR="$TEMPDIR/CONFIG"
    TARBALL_DIR="$TEMPDIR/TARBALL"

    mkdir -p "${IC_PREP_DIR}"
    mkdir -p "${CONFIG_DIR}"
    mkdir -p "${TARBALL_DIR}"

    if [ ! -d "${OUTPUT}" ]; then
        mkdir -p "${OUTPUT}"
    fi
}

function download_binaries() {
    "${REPO_ROOT}"/gitlab-ci/src/artifacts/rclone_download.py \
        --git-rev "$GIT_REVISION" --remote-path=release --out="${IC_PREP_DIR}/bin"

    find "${IC_PREP_DIR}/bin/" -name "*.gz" -print0 | xargs -P100 -0I{} bash -c "gunzip -f {} && basename {} .gz | xargs -I[] chmod +x ${IC_PREP_DIR}/bin/[]"

    mkdir -p "$OUTPUT/bin"
    rsync -a --delete "${IC_PREP_DIR}/bin/" "$OUTPUT/bin/"
}

function place_control_plane() {
    cp -a "${IC_PREP_DIR}/bin/boundary-node-control-plane" "$REPO_ROOT/ic-os/boundary-guestos/rootfs/opt/ic/bin/boundary-node-control-plane"
}

function create_tarball_structure() {
    for n in $NODES; do
        declare -n NODE=$n
        if [[ "${NODE["type"]}" = "boundary" ]]; then
            local subnet_idx=${NODE["subnet_idx"]}
            local node_idx=${NODE["node_idx"]}
            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx
            mkdir -p "${CONFIG_DIR}/$NODE_PREFIX/node/replica_config"
        fi
    done
}

function generate_journalbeat_config() {
    echo ${CONFIG} | jq -c '.datacenters[]' | while read datacenters; do
        echo ${datacenters} | jq -c '[.nodes[],.boundary_nodes[],.aux_nodes[]][]' | while read nodes; do

            local hostname=$(echo ${nodes} | jq -r '.hostname')
            local subnet_idx=$(echo ${nodes} | jq -r '.subnet_idx')
            local node_idx=$(echo ${nodes} | jq -r '.node_idx')

            # Define hostname
            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx

            if [ "${JOURNALBEAT_HOSTS}" != "" ]; then
                echo "journalbeat_hosts=${JOURNALBEAT_HOSTS}" >"${CONFIG_DIR}/$NODE_PREFIX/journalbeat.conf"

                if [ "${JOURNALBEAT_USERNAME}" != "" ]; then
                    echo "journalbeat_username=${JOURNALBEAT_USERNAME}" >>"${CONFIG_DIR}/$NODE_PREFIX/journalbeat.conf"
                fi

                if [ "${JOURNALBEAT_PASSWORD}" != "" ]; then
                    echo "journalbeat_password=${JOURNALBEAT_PASSWORD}" >>"${CONFIG_DIR}/$NODE_PREFIX/journalbeat.conf"
                fi
            fi

            if [ "${KAFKA_HOSTS}" != "" ]; then
                echo "kafka_hosts=${KAFKA_HOSTS}" >"${CONFIG_DIR}/$NODE_PREFIX/journalbeat.conf"
            fi
        done
    done
}

function generate_boundary_node_config() {
    # Query and list all NNS nodes in subnet
    echo ${CONFIG} | jq -c '.datacenters[]' | while read datacenters; do
        local ipv6_prefix=$(echo ${datacenters} | jq -r '.ipv6_prefix')
        echo ${datacenters} | jq -c '.nodes[]' | while read nodes; do
            NNS_DC_URL=$(echo ${nodes} | jq -c 'select(.subnet_type|test("root_subnet"))' | while read nns_node; do
                local ipv6_address=$(echo "${nns_node}" | jq -r '.ipv6_address')
                echo -n "http://[${ipv6_address}]:8080"
            done)
            echo ${NNS_DC_URL} >>"${IC_PREP_DIR}/NNS_URL"
        done
    done
    NNS_URL="$(cat ${IC_PREP_DIR}/NNS_URL | awk '$1=$1' ORS=',' | sed 's@,$@@g')"
    rm -f "${IC_PREP_DIR}/NNS_URL)"

    # nns config for boundary nodes
    echo ${CONFIG} | jq -c '.datacenters[]' | while read datacenters; do
        echo ${datacenters} | jq -c '[.boundary_nodes[]][]' | while read nodes; do
            local subnet_idx=$(echo ${nodes} | jq -r '.subnet_idx')
            local node_idx=$(echo ${nodes} | jq -r '.node_idx')
            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx
            # TODO (NODE-244): Copy the NNS public key in the correct place
            # Currently Boundary Nodes tests do not depend on nns_public_key
            #cp "${IC_PREP_DIR}/nns_public_key.pem" "${CONFIG_DIR}/$NODE_PREFIX/nns_public_key.pem"
            echo "nns_url=${NNS_URL}" >"${CONFIG_DIR}/$NODE_PREFIX/nns.conf"
        done
    done
}

function generate_network_config() {
    echo ${CONFIG} | jq -c '.datacenters[]' | while read datacenters; do
        local ipv6_prefix=$(echo ${datacenters} | jq -r '.ipv6_prefix')
        local ipv6_subnet=$(echo ${datacenters} | jq -r '.ipv6_subnet')
        local ipv6_gateway="${ipv6_prefix}"::1
        echo ${datacenters} | jq -c '[.nodes[],.boundary_nodes[],.aux_nodes[]][]' | while read nodes; do

            local hostname=$(echo ${nodes} | jq -r '.hostname')
            local subnet_idx=$(echo ${nodes} | jq -r '.subnet_idx')
            local node_idx=$(echo ${nodes} | jq -r '.node_idx')

            # Define hostname
            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx
            echo "hostname=${hostname}" >"${CONFIG_DIR}/$NODE_PREFIX/network.conf"

            # Set name servers
            echo "name_servers=${NAME_SERVERS}" >>"${CONFIG_DIR}/$NODE_PREFIX/network.conf"
            echo "name_servers_fallback=${NAME_SERVERS_FALLBACK}" >>"${CONFIG_DIR}/$NODE_PREFIX/network.conf"

            # IPv6 network configuration is obtained from the Router Advertisement.
        done
    done
}

function copy_ssh_keys() {
    for n in $NODES; do
        declare -n NODE=$n

        if [[ "${NODE["type"]}" = "boundary" ]]; then

            local subnet_idx=${NODE["subnet_idx"]}
            local node_idx=${NODE["node_idx"]}

            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx

            # Copy the contents of the directory, but make sure that we do not
            # copy/create symlinks (but rather dereference file contents).
            # Symlinks must be refused by the config injection script (they
            # can lead to confusion and side effects when overwriting one
            # file changes another).
            cp -Lr "${SSH}" "${CONFIG_DIR}/$NODE_PREFIX/accounts_ssh_authorized_keys"
        fi
    done
}

function build_tarball() {
    for n in $NODES; do
        declare -n NODE=$n
        if [[ "${NODE["type"]}" == "boundary" ]]; then

            local subnet_idx=${NODE["subnet_idx"]}
            local node_idx=${NODE["node_idx"]}

            # Create temporary tarball directory per node
            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx
            mkdir -p "${TARBALL_DIR}/$NODE_PREFIX"
            (
                cd "${CONFIG_DIR}/$NODE_PREFIX"
                tar c .
            ) >${TARBALL_DIR}/$NODE_PREFIX/ic-bootstrap.tar
        fi
    done
    tar czf "${OUTPUT}/config.tgz" -C "${CONFIG_DIR}" .
}

function build_removable_media() {
    for n in $NODES; do
        declare -n NODE=$n
        if [[ "${NODE["type"]}" == "boundary" ]]; then

            local subnet_idx=${NODE["subnet_idx"]}
            local node_idx=${NODE["node_idx"]}

            #echo "${DEPLOYMENT}.$subnet_idx.$node_idx"
            NODE_PREFIX=${DEPLOYMENT}.$subnet_idx.$node_idx
            truncate --size 4M "${OUTPUT}/$NODE_PREFIX.img"
            mkfs.vfat "${OUTPUT}/$NODE_PREFIX.img"
            mcopy -i "${OUTPUT}/$NODE_PREFIX.img" -o -s ${TARBALL_DIR}/$NODE_PREFIX/ic-bootstrap.tar ::
        fi
    done
}

function remove_temporary_directories() {
    rm -rf ${TEMPDIR}
}

# See how we were called
# (NODE-249) Migrate journalbeat and network config from ansible tasks to dockerfile
if [ ${DEBUG} -eq 1 ]; then
    prepare_build_directories
    download_binaries
    place_control_plane
    create_tarball_structure
    generate_boundary_node_config
    #   generate_journalbeat_config
    #   generate_network_config
    copy_ssh_keys
    build_tarball
    build_removable_media
    # remove_temporary_directories
else
    prepare_build_directories >/dev/null 2>&1
    download_binaries >/dev/null 2>&1 &
    place_control_plane >/dev/null 2>&1 &
    create_tarball_structure >/dev/null 2>&1
    generate_boundary_node_config >/dev/null 2>&1
    #   generate_journalbeat_config >/dev/null 2>&1
    #   generate_network_config >/dev/null 2>&1
    copy_ssh_keys >/dev/null 2>&1
    build_tarball >/dev/null 2>&1
    build_removable_media >/dev/null 2>&1
    remove_temporary_directories >/dev/null 2>&1
fi