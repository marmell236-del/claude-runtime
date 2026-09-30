FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    bash \
    curl \
    ca-certificates \
    git \
    build-essential \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/root/.local/bin:${PATH}"

RUN /root/.local/bin/claude --version

WORKDIR /app

COPY server.js .

EXPOSE 3000

CMD bash -c 'claude mcp login --help 2>&1; node server.js'