#!/usr/bin/env bash
# Assumes the gateway is running on :8787 with GATEWAY_API_KEYS=$USER_KEY and GATEWAY_ADMIN_KEYS=$ADMIN_KEY
B=http://127.0.0.1:8787
# 1. discover each provider's catalogue (read-only; models become 'configured', NOT accessible)
curl -s -H "authorization: Bearer $ADMIN_KEY" -d '{}' $B/v1/admin/discover
# 2. probe specific models with a real 1-token request (consumes a negligible amount of quota)
curl -s -H "authorization: Bearer $ADMIN_KEY" -d '{"models":["openai/YOUR-MODEL-ID"]}' $B/v1/admin/probe
# 3. chat; "auto" lets the router pick among accessible models
curl -s -H "authorization: Bearer $USER_KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}' $B/v1/chat/completions
# 4. see what was really used and why the router chose what it chose
curl -s -H "authorization: Bearer $ADMIN_KEY" $B/v1/usage/summary
curl -s -H "authorization: Bearer $ADMIN_KEY" $B/v1/router/decisions
