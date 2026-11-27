# A machine made like CI's runner, for `pnpm check:ci`: the runner's Ubuntu and the
# tmux its packages give, Node 22 and Node 24, what node-pty compiles with, the
# agent's sandbox (bubblewrap and socat) and Playwright's Chromium. CI's own
# workflow installs the same packages; when its runner's Ubuntu moves, this
# file's first line moves with it.
FROM ubuntu:26.04

ARG NODE_22
ARG NODE_24
ARG PNPM
ARG PLAYWRIGHT
ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    tmux build-essential python3 bubblewrap socat \
    ca-certificates curl git xz-utils rsync util-linux \
  && rm -rf /var/lib/apt/lists/*

# Each Node in a folder of its own, with the package manager the repository names.
RUN for version in "$NODE_22" "$NODE_24"; do \
      major="${version%%.*}"; \
      mkdir -p "/opt/node$major" \
      && curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz" \
        | tar -xJ --strip-components=1 -C "/opt/node$major" \
      && PATH="/opt/node$major/bin:$PATH" npm install --global --silent "pnpm@$PNPM"; \
    done

# Playwright's Chromium, and the system libraries it needs, where every user reads it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN PATH="/opt/node24/bin:$PATH" npx --yes "playwright@$PLAYWRIGHT" install --with-deps chromium \
  && chmod -R a+rX /opt/playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# A user of the host's ids, as CI runs as a user: the agent refuses some of its
# modes to root, and what the check writes back is the person's.
RUN if getent passwd "$UID" > /dev/null; then userdel --remove "$(getent passwd "$UID" | cut -d: -f1)"; fi \
  && (getent group "$GID" > /dev/null || groupadd --gid "$GID" runner) \
  && useradd --uid "$UID" --gid "$GID" --create-home --shell /bin/bash runner
USER runner
WORKDIR /home/runner
# The package store is a volume kept between runs; made here, it is the user's.
RUN mkdir -p /home/runner/.pnpm-store /home/runner/work
