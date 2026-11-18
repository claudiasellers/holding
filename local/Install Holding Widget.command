#!/bin/bash
# Puts the parent on your Mac desktop as a small floating window (menu bar app).
# Uses Holding Local automatically while it's running. See mac-widget/README.md.
curl -fsSL https://raw.githubusercontent.com/claudiasellers/holding/main/mac-widget/install.sh | bash
echo
read -n 1 -s -r -p "Done. Press any key to close this window."
