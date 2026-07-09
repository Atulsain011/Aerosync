#!/usr/bin/env bash
# ==============================================================================
# AeroSync Local Server One-Click Launcher
# ==============================================================================

# Ensure directory is where the script resides
cd "$(dirname "$0")"

echo "============================================="
echo " 📡 Starting AeroSync File Server Launcher..."
echo "============================================="

# 1. Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed on this system!"
    echo "Please download and install Node.js (version 20 or higher) from: https://nodejs.org"
    echo "Press Enter to exit..."
    read -r
    exit 1
fi

# 2. Check if node_modules is installed, otherwise run npm install
if [ ! -d "node_modules" ]; then
    echo "📦 Dependencies missing. Running npm install..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Error: Failed to install project dependencies."
        echo "Press Enter to exit..."
        read -r
        exit 1
    fi
fi

# 3. Start the node server in the background
echo "🚀 Starting AeroSync engine..."
npm start &
SERVER_PID=$!

# Guard: cleanup background server process when launcher exits
cleanup() {
    echo -e "\n🛑 Stopping AeroSync Server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 4. Wait for server to bind port and boot
sleep 2

# 5. Open browser automatically
URL="http://localhost:5000"
echo "🌐 Launching UI dashboard at $URL..."

if command -v xdg-open &> /dev/null; then
    xdg-open "$URL"
elif command -v open &> /dev/null; then
    open "$URL"
else
    # Fallback to python browser opener or print instructions
    python3 -m webbrowser "$URL" 2>/dev/null || echo "👉 Please open your browser and navigate to: $URL"
fi

echo "============================================="
echo " 🎉 AeroSync is online!"
echo " Keep this terminal open to keep sharing files."
echo " Press Ctrl+C in this terminal to stop the server."
echo "============================================="

# Keep script running to maintain server process active and output logs
wait $SERVER_PID
