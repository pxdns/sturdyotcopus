# The environment each runner session gets. Build it with:  docker build -t luma-runner:latest runner/image
# UNTESTED in the project's CI: review it before relying on it.
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG GRADLE_VERSION=8.10.2
# Agent command-line tools to preinstall (space separated npm packages). Install any others yourself inside a session.
ARG AGENT_CLIS="@anthropic-ai/claude-code @github/copilot"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg unzip zip less nano vim jq build-essential \
      python3 python3-pip python3-venv openjdk-21-jdk-headless \
 && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# Gradle
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
 && unzip -q /tmp/gradle.zip -d /opt && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle && rm /tmp/gradle.zip

# Agent CLIs: a failed install must not break the image, so it only warns.
RUN npm install -g ${AGENT_CLIS} || echo "WARNING: could not install some agent CLIs: ${AGENT_CLIS}"

RUN useradd -m -u 1001 -s /bin/bash dev && mkdir -p /work && chown dev:dev /work
COPY luma-entry.sh /usr/local/bin/luma-entry
USER dev
ENV HOME=/home/dev LANG=C.UTF-8
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/luma-entry"]
