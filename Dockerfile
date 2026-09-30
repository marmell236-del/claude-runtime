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

# Install Claude Code
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude Code to PATH
ENV PATH="/root/.local/bin:${PATH}"

# Verify installation
RUN claude --version

# Create Claude configuration directory
RUN mkdir -p /root/.claude

# Robinhood MCP permissions
#
# READ / RESEARCH:
# Automatically permitted.
#
# TRADING:
# Not automatically permitted.
# Order placement, cancellation, option exercise and other
# account-changing operations remain behind Claude's permission gate.
RUN cat > /root/.claude/settings.json <<'EOF'
{
  "permissions": {
    "allow": [
      "mcp__robinhood-trading__get_accounts",
      "mcp__robinhood-trading__get_portfolio",
      "mcp__robinhood-trading__get_equity_positions",
      "mcp__robinhood-trading__get_option_positions",
      "mcp__robinhood-trading__get_crypto_positions",
      "mcp__robinhood-trading__get_realized_pnl",
      "mcp__robinhood-trading__get_pnl_trade_history",

      "mcp__robinhood-trading__get_equity_orders",
      "mcp__robinhood-trading__get_option_orders",
      "mcp__robinhood-trading__get_crypto_orders",

      "mcp__robinhood-trading__get_equity_quotes",
      "mcp__robinhood-trading__get_equity_historicals",
      "mcp__robinhood-trading__get_equity_fundamentals",
      "mcp__robinhood-trading__get_equity_analyst_ratings",
      "mcp__robinhood-trading__get_equity_price_book",
      "mcp__robinhood-trading__get_equity_technical_indicators",
      "mcp__robinhood-trading__get_equity_tradability",
      "mcp__robinhood-trading__get_financials",
      "mcp__robinhood-trading__get_earnings_calendar",
      "mcp__robinhood-trading__get_earnings_results",
      "mcp__robinhood-trading__search",

      "mcp__robinhood-trading__get_option_chains",
      "mcp__robinhood-trading__get_option_instruments",
      "mcp__robinhood-trading__get_option_quotes",
      "mcp__robinhood-trading__get_option_historicals",

      "mcp__robinhood-trading__get_crypto_quotes",
      "mcp__robinhood-trading__get_currency_pairs",

      "mcp__robinhood-trading__get_indexes",
      "mcp__robinhood-trading__get_index_quotes",
      "mcp__robinhood-trading__get_index_historicals",

      "mcp__robinhood-trading__get_sec_filing",
      "mcp__robinhood-trading__get_sec_filing_index",
      "mcp__robinhood-trading__get_sec_filing_facts",
      "mcp__robinhood-trading__get_sec_filing_facts_catalog",

      "mcp__robinhood-trading__get_watchlists",
      "mcp__robinhood-trading__get_watchlist_items",
      "mcp__robinhood-trading__get_popular_watchlists",
      "mcp__robinhood-trading__get_option_watchlist",

      "mcp__robinhood-trading__get_alerts",
      "mcp__robinhood-trading__get_alert_log",

      "mcp__robinhood-trading__get_scans",
      "mcp__robinhood-trading__get_scanner_datapoints",
      "mcp__robinhood-trading__get_scanner_filter_specs",
      "mcp__robinhood-trading__preview_scan",
      "mcp__robinhood-trading__run_scan"
    ]
  }
}
EOF

# Create application directory
WORKDIR /app

# Copy HTTP server
COPY server.js .

# Railway supplies PORT at runtime
EXPOSE 3000

# Configure Robinhood MCP and start runtime
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