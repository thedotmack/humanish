#!/usr/bin/env sh
# Container entrypoint: start neko in the background, then exec the
# action runner in the foreground so PID 1 is the runner (Fly health
# checks and signal forwarding target the runner).
set -e

# Start neko (Xorg + Chromium + WebRTC bridge). The upstream image keeps
# the neko binary at /usr/bin/neko.
/usr/bin/neko --config /etc/neko.yaml &
NEKO_PID=$!

# If neko dies, the runner should die too so Fly restarts the whole
# machine. Trap SIGCHLD and exit. (POSIX sh has no SIGCHLD trap, so we
# rely on `wait -n` semantics in shells that support it; otherwise the
# runner just runs and Fly's healthchecks on neko will catch the failure.)

exec node /opt/action-runner/dist/server.js
