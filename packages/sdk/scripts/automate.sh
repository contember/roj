#!/bin/bash

# Roj Agent Server - Automated Plugin Refactoring
# Spouští Claude Code v loop, dokud nejsou všechny issues hotové

set -e
cc() {
  # Ensure .claude.json exists as a file (not directory)
  [[ ! -f "$HOME/.claude.json" ]] && echo '{}' > "$HOME/.claude.json"

  local mounts=(
    # RW mounts first (must come before the ro $HOME mount)
    -v "$HOME/.claude:$HOME/.claude:rw"
    -v "$HOME/.claude.json:$HOME/.claude.json:rw"
    # RO mounts
    -v "$HOME:$HOME:ro"
    -v /etc/passwd:/etc/passwd:ro
    -v /etc/group:/etc/group:ro
    -v /etc/localtime:/etc/localtime:ro
    -v /usr/share/terminfo:/usr/share/terminfo:ro
  )

  # Add SSH agent if available
  [[ -n "$SSH_AUTH_SOCK" ]] && mounts+=(
    -v "$SSH_AUTH_SOCK:$SSH_AUTH_SOCK:ro"
    -e SSH_AUTH_SOCK="$SSH_AUTH_SOCK"
  )

  # Mount PWD as rw (overwrites the ro from $HOME mount)
  [[ "$PWD" != "$HOME/.claude" ]] && mounts+=(-v "$PWD:$PWD:rw")

  docker run -it --rm \
    --network host \
    --user "$(id -u):$(id -g)" \
    "${mounts[@]}" \
    -w "$PWD" \
    -e HOME="$HOME" \
    -e TERM="$TERM" \
    -e PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    claude-sandbox \
    claude --dangerously-skip-permissions "$@"
}



SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "========================================"
echo "Roj - Automated Plugin Refactoring"
echo "========================================"
echo "Project: $PROJECT_DIR"
echo ""

PROMPT='Přečti si docs/INSTRUCTIONS.md a docs/STATUS.md. Najdi první pending issue, implementuj jej podle requirements v docs/issues/, ověř výsledek (bun tsc --noEmit --project roj/packages/agent-server) a aktualizuj docs/STATUS.md. Pokud už nejsou žádné pending issues, odpověz pouze: <done>promise</done>'

ITERATION=1
MAX_ITERATIONS=30

while [ $ITERATION -le $MAX_ITERATIONS ]; do
    echo ""
    echo "========================================"
    echo "Iteration $ITERATION"
    echo "========================================"
    echo ""

    OUTPUT=$(claude --dangerously-skip-permissions -p "$PROMPT" 2>&1) || true

    echo "$OUTPUT"

    if echo "$OUTPUT" | grep -q "<done>promise</done>"; then
        echo ""
        echo "========================================"
        echo "All issues completed!"
        echo "========================================"
        exit 0
    fi

    if echo "$OUTPUT" | grep -qi "error\|failed\|fatal"; then
        echo ""
        echo "========================================"
        echo "Warning: Possible error detected"
        echo "Continuing to next iteration..."
        echo "========================================"
    fi

    ITERATION=$((ITERATION + 1))

    sleep 2
done

echo ""
echo "========================================"
echo "Max iterations ($MAX_ITERATIONS) reached"
echo "========================================"
exit 1
