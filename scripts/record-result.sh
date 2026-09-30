#!/bin/bash

# Record challenge completion results interactively
# Usage: ./record-result.sh
#
# Prompts for completion time, answers for each challenge, and feedback

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_FILE="$REPO_ROOT/examples/test-app/results.md"

# Create results file if it doesn't exist
if [ ! -f "$RESULTS_FILE" ]; then
  cat > "$RESULTS_FILE" << 'EOF'
# devharness Challenge Results

This file tracks completion times and answers for the test-app challenges.

---

EOF
fi

echo "=== devharness Challenge Results Recorder ==="
echo ""

# Prompt for completion time
read -p "Completion time (seconds): " COMPLETION_TIME

if [ -z "$COMPLETION_TIME" ]; then
  echo "Error: Completion time is required"
  exit 1
fi

# Format completion time
MINUTES=$((COMPLETION_TIME / 60))
SECONDS_REMAINING=$((COMPLETION_TIME % 60))
if [ $MINUTES -gt 0 ]; then
  TIME_FORMATTED="${MINUTES}m ${SECONDS_REMAINING}s"
else
  TIME_FORMATTED="${SECONDS_REMAINING}s"
fi

echo ""
echo "=== Challenge Answers ==="
echo "(Press Enter to skip any challenge)"
echo ""

# Prompt for each challenge answer
read -p "1. DOM Manipulation Bug: " ANSWER_1
read -p "2. Network Request Bug: " ANSWER_2
read -p "3. Console Errors: " ANSWER_3
read -p "4. Variable Inspection: " ANSWER_4
read -p "5. localStorage Bug: " ANSWER_5
read -p "6. Performance Issue: " ANSWER_6
read -p "7. Secret Vault Password: " ANSWER_7
read -p "8. Multi-Connection Debugging: " ANSWER_8

echo ""
echo "=== Feedback ==="
read -p "Any feedback about the tools? " FEEDBACK

# Get current timestamp
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")

# Build the result entry
ENTRY="## Run: $TIMESTAMP

**Completion Time:** ${COMPLETION_TIME}s (${TIME_FORMATTED})

### Answers

| # | Challenge | Answer |
|---|-----------|--------|"

[ -n "$ANSWER_1" ] && ENTRY+="
| 1 | DOM Manipulation | $ANSWER_1 |"
[ -n "$ANSWER_2" ] && ENTRY+="
| 2 | Network Request | $ANSWER_2 |"
[ -n "$ANSWER_3" ] && ENTRY+="
| 3 | Console Errors | $ANSWER_3 |"
[ -n "$ANSWER_4" ] && ENTRY+="
| 4 | Variable Inspection | $ANSWER_4 |"
[ -n "$ANSWER_5" ] && ENTRY+="
| 5 | localStorage Bug | $ANSWER_5 |"
[ -n "$ANSWER_6" ] && ENTRY+="
| 6 | Performance Issue | $ANSWER_6 |"
[ -n "$ANSWER_7" ] && ENTRY+="
| 7 | Secret Vault Password | $ANSWER_7 |"
[ -n "$ANSWER_8" ] && ENTRY+="
| 8 | Multi-Connection Debugging | $ANSWER_8 |"

ENTRY+="
"

# Add feedback if provided
if [ -n "$FEEDBACK" ]; then
  ENTRY+="
### Feedback

$FEEDBACK
"
fi

ENTRY+="
---

"

# Append to results file
echo "$ENTRY" >> "$RESULTS_FILE"

echo ""
echo "=== Result Recorded ==="
echo "  Timestamp: $TIMESTAMP"
echo "  Completion: ${TIME_FORMATTED} (${COMPLETION_TIME}s)"
echo "  Results file: $RESULTS_FILE"
