FROM node:22-bookworm

# Grading toolchain, baked in so the test phase needs no network. These are
# plain npm libraries under a neutral path: the verifier, the expectations and
# the fixtures are not in this image. Harbor copies those to /tests only after
# the agent has stopped.
RUN mkdir -p /opt/toolchain \
 && cd /opt/toolchain \
 && npm init -y > /dev/null \
 && npm pkg set type=module \
 && npm install --no-audit --no-fund ts-morph@27 typescript@5.9 tsx@4 dotenv@17

# The only two files the agent is given. Verbatim copies, kept in sync by
# harbor/sync.sh.
COPY TASK.md setup.md /app/

WORKDIR /app
