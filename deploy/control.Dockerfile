# Deployment control service image: docker CLI (with the compose plugin) +
# python3, running deploy/control_server.py. The code is not baked in: compose
# mounts the repo at the same absolute path (see docker-compose.yml).
FROM docker:27-cli
RUN apk add --no-cache python3
ENTRYPOINT ["python3", "deploy/control_server.py"]
