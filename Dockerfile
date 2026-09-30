FROM ubuntu:24.04

# Install system dependencies
RUN apt-get update && apt-get install -y \
    bash \
    curl \
    ca-certificates \
    git \
    build-essential \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI via official installer
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude Code to PATH
ENV PATH="/root/.local/bin:${PATH}"

# Verify Claude installation during build
RUN /root/.local/bin/claude --version

# Create app directory
WORKDIR /app

# Copy HTTP server
COPY server.js .

# Railway supplies PORT at runtime
EXPOSE 3000

# Verify the exact MCP login/add capabilities, then keep service alive
CMD bash -c 'echo "=== CLAUDE VERSION ===" && claude --version && echo && echo "=== MCP LOGIN HELP ===" && claude mcp login --help && echo && echo "=== MCP ADD HELP ===" && claude mcp add --help && echo && node server.js'