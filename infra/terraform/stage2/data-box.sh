#!/bin/bash
# Stage 2 data box: Kafka + Mongo + Jaeger + Mailpit in Docker, restart on boot.
set -euxo pipefail
dnf install -y docker
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

mkdir -p /opt/data && cd /opt/data
cat > docker-compose.yml <<'YML'
name: data
services:
  kafka:
    image: apache/kafka:3.8.0
    restart: unless-stopped
    ports: ["9092:9092"]
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      # Clients find the broker by its Cloud Map name, not by IP.
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://${data_host}:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_HEAP_OPTS: "-Xmx768m -Xms768m"
    volumes: [kafkadata:/var/lib/kafka/data]
  mongo:
    image: mongo:7
    restart: unless-stopped
    ports: ["27017:27017"]
    command: ["--wiredTigerCacheSizeGB", "0.5"]
    volumes: [mongodata:/data/db]
  jaeger: # UI 16686 only via SSM port forwarding (not in the security group)
    image: jaegertracing/all-in-one:1.60
    restart: unless-stopped
    ports: ["4318:4318", "16686:16686"]
    command: ["--memory.max-traces=20000"]
  mailpit: # UI 8025 only via SSM port forwarding
    image: axllent/mailpit:v1.20
    restart: unless-stopped
    ports: ["1025:1025", "8025:8025"]
volumes:
  kafkadata:
  mongodata:
YML
docker compose up -d
