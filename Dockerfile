# Runtime-only image: Rogue ships as one self-contained bundle, so the container
# needs Node and nothing else from this repository. Build the bundle first
# (`npm run build`) or drop a released rogue.js into dist/.
FROM node:22-bookworm-slim

# Rogue's coding tools are real host capabilities inside this container, so the
# image doubles as the agent's working environment. Trim this list to narrow
# what the agent can do, or extend it with whatever its work needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      unzip \
      wget \
 && rm -rf /var/lib/apt/lists/*

# The stock node image already owns 1000; replacing it keeps the agent's UID
# aligned with a typical host user, which matters when the workspace is a bind
# mount rather than a named volume.
ARG ROGUE_UID=1000
ARG ROGUE_GID=1000
RUN if getent passwd "${ROGUE_UID}" >/dev/null; then \
      userdel -r "$(getent passwd "${ROGUE_UID}" | cut -d: -f1)" || true; \
    fi \
 && if ! getent group "${ROGUE_GID}" >/dev/null; then groupadd -g "${ROGUE_GID}" rogue; fi \
 && useradd -m -u "${ROGUE_UID}" -g "${ROGUE_GID}" -s /bin/bash rogue

COPY dist/rogue.js /opt/rogue/rogue.js
COPY docker/entrypoint.sh /usr/local/bin/rogue-entrypoint
RUN chmod 0755 /opt/rogue/rogue.js /usr/local/bin/rogue-entrypoint

ENV HOME=/home/rogue \
    NODE_ENV=production \
    ROGUE_WORKSPACE=/home/rogue/agent \
    ROGUE_BINARY=/opt/rogue/rogue.js

# Durable state lives in .rogue/ under the working directory, and the working
# directory is also where the agent's own files land. Mount this one path and
# the whole installation survives a restart.
RUN install -d -o "${ROGUE_UID}" -g "${ROGUE_GID}" -m 0700 /home/rogue/agent
WORKDIR /home/rogue/agent
USER rogue

ENTRYPOINT ["/usr/local/bin/rogue-entrypoint"]
