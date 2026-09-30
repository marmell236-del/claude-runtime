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

# Register Robinhood Trading MCP, verify it, then keep the Railway service alive.
# This does NOT initiate Robinhood OAuth or place any trades.
CMD bash -c '\
  echo "=== CLAUDE VERSION ===" && \
  claude --version && \
  echo "=== ADDING ROBINHOOD MCP ===" && \
  claude mcp add --transport http robinhood-trading https://agent.robinhood.com/mcp/trading && \
  echo "=== ROBINHOOD MCP CONFIG ===" && \
  claude mcp get robinhood-trading && \
  echo "=== MCP LOGIN HELP ===" && \
  claude mcp login --help && \
  echo "=== STARTING HEALTH SERVER ===" && \
  node server.js'

