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

# Install Claude Code using the official installer
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude Code to PATH
ENV PATH="/root/.local/bin:${PATH}"

# Verify Claude Code installed
RUN claude --version

# Create application directory
WORKDIR /app

# Copy the HTTP server
COPY server.js .

# Railway supplies PORT at runtime
EXPOSE 3000

# Start Claude/Robinhood runtime.
#
# The Claude configuration is stored persistently at /root/.claude.
# If Robinhood MCP already exists, DO NOT try to add it again.
# If it does not exist, register it.
CMD bash -c '\
  echo "=== CLAUDE VERSION ===" && \
  claude --version && \
  echo "=== CHECKING ROBINHOOD MCP ===" && \
  if claude mcp get robinhood-trading >/dev/null 2>&1; then \
    echo "Robinhood MCP already configured."; \
  else \
    echo "Robinhood MCP not found. Adding it..." && \
    claude mcp add --transport http robinhood-trading https://agent.robinhood.com/mcp/trading; \
  fi && \
  echo "=== ROBINHOOD MCP CONFIG ===" && \
  claude mcp get robinhood-trading && \
  echo "=== STARTING SERVER ===" && \
  exec node server.js'