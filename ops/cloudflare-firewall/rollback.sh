#!/bin/sh
# 遮断を即解除 (DOCKER-USER を空に戻す)
set -eu
iptables -F DOCKER-USER
iptables -F sushiski-cf 2>/dev/null || true
iptables -X sushiski-cf 2>/dev/null || true
iptables -S DOCKER-USER
